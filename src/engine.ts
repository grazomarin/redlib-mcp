import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { arch as osArch } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { REDLIB_PIN } from "./pin.js";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  file: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; stream?: boolean },
) => Promise<RunResult>;

// The one place a subprocess is spawned. ALWAYS an argv array + shell:false (never sh -c).
// `stream` forwards the child's stderr live (long Rust builds) while still capturing it.
export const defaultRunner: Runner = (file, args, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, shell: false });
    // Retain only a bounded TAIL: a 20-min build streams MBs live, but callers only ever read
    // slice(-2000)/slice(-600). Trim when we exceed 2×CAP so buffering stays O(n), not unbounded.
    const CAP = 64 * 1024;
    let stdout = "", stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 2 * CAP) stdout = stdout.slice(-CAP); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2 * CAP) stderr = stderr.slice(-CAP); if (opts.stream) process.stderr.write(d); });
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr: stderr + String(e), code: 127 }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });

export interface Engine { bin: string; kind: "docker" | "podman"; }

// Explicit ABSOLUTE candidate paths ONLY ("not bare PATH"). A bare `docker`/`podman`
// resolved via the child's PATH is a hijack surface (a malicious binary earlier in PATH runs), so
// it is deliberately NOT searched. A non-standard install is reachable via the REDLIB_ENGINE
// override below (still an explicit absolute path, not PATH resolution).
const CANDIDATES: Record<"docker" | "podman", string[]> = {
  docker: [
    "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/usr/bin/docker",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ],
  podman: [
    "/usr/local/bin/podman", "/opt/homebrew/bin/podman", "/usr/bin/podman",
    "C:\\Program Files\\RedHat\\Podman\\podman.exe",
  ],
};

// Resolve a WORKING engine: a binary whose `version` succeeds (client reachable). docker is
// preferred, podman is the fallback. `DOCKER_HOST` etc. are honored by the resolved binary itself.
// `exists` is injected so the resolver is testable off-host without real binaries on disk.
// `prefer` (from `--engine docker|podman`) narrows auto-detection to that one kind. An explicit
// REDLIB_ENGINE absolute path still wins over it (the lower-level escape hatch is the most specific).
export async function detectEngine(
  run: Runner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  prefer?: "docker" | "podman",
): Promise<Engine> {
  // Explicit override: an ABSOLUTE path the operator vouches for — NOT bare-PATH resolution.
  const override = env.REDLIB_ENGINE;
  if (override) {
    // ABSOLUTE only: a bare name PATH-resolves, and a relative name (e.g. "./docker") resolves against
    // the process CWD — both are the binary-hijack surface this rule exists to close. isAbsolute covers
    // POSIX "/…", Windows "C:\…", and UNC paths; a leading "./" or "../" is correctly rejected.
    if (!isAbsolute(override)) throw new Error(`REDLIB_ENGINE must be an ABSOLUTE path to a docker/podman binary, not a bare or relative name: ${override}`);
    const r = await run(override, ["version", "--format", "{{.Client.Version}}"]).catch(() => ({ stdout: "", stderr: "spawn failed", code: 127 }));
    if (r.code === 0) return { bin: override, kind: /podman/i.test(override) ? "podman" : "docker" };
    throw new Error(`REDLIB_ENGINE=${override} did not respond to \`version\`.`);
  }
  const kinds: ("docker" | "podman")[] = prefer ? [prefer] : ["docker", "podman"];
  for (const kind of kinds) {
    for (const cand of CANDIDATES[kind]) {
      if (!exists(cand)) continue; // absolute-only: a candidate that is not on disk is never probed
      const r = await run(cand, ["version", "--format", "{{.Client.Version}}"]).catch(() => ({ stdout: "", stderr: "spawn failed", code: 127 }));
      if (r.code === 0) return { bin: cand, kind };
    }
  }
  throw new Error(
    prefer
      ? `--engine ${prefer} was requested but no working ${prefer} was found at its standard absolute paths (${CANDIDATES[prefer].join(", ")}). Is ${prefer} installed and running? Set REDLIB_ENGINE to an absolute path if it lives elsewhere.`
      : `No working container engine found at the standard absolute paths (${[...CANDIDATES.docker, ...CANDIDATES.podman].join(", ")}). ` +
        `Bare PATH is intentionally not searched; set REDLIB_ENGINE to an absolute docker/podman path if yours is elsewhere. Is Docker Desktop (or Podman) running?`,
  );
}

// Separate check: the binary is present but is the DAEMON reachable? (doctor distinguishes
// "not installed" from "installed, daemon down / Docker Desktop not started").
export async function daemonReachable(engine: Engine, run: Runner = defaultRunner): Promise<boolean> {
  const r = await run(engine.bin, ["version", "--format", "{{.Server.Version}}"]).catch(() => ({ stdout: "", stderr: "", code: 1 }));
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function ok(r: RunResult, label: string): Promise<RunResult> {
  if (r.code !== 0) throw new Error(`${label} failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-600)}`);
  return r;
}

// Clone/fetch Redlib at the IMMUTABLE pinned SHA and detach onto it. We fetch the exact commit
// (GitHub serves reachable SHAs); if the server refuses a bare-SHA want, fall back to fetching the
// branch, then check the SHA out of its history. Finally assert HEAD == pin — a redirected or
// force-moved remote can't slip an unpinned tree past this.
export async function cloneAtPin(dir: string, run: Runner = defaultRunner, pin = REDLIB_PIN): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // git is resolved via PATH (unlike the container engine, which is absolute-only). Hardening git to
  // fixed absolute paths is impractical — it lives in many locations across OSes and users expect PATH
  // git — and the threat it would add (a malicious `git` earlier in PATH) already implies shell
  // compromise. Accepted tradeoff; the HEAD == pin.sha assertion below is the real supply-chain guard.
  const git = (args: string[], opts?: { timeoutMs?: number }) => run("git", ["-C", dir, ...args], opts);
  if (!existsSync(join(dir, ".git"))) {
    await ok(await run("git", ["init", "-q", dir]), "git init");
    await ok(await git(["remote", "add", "origin", pin.repo]), "git remote add");
  }
  // Network fetches get a timeout: a stalled network must not hang FOREVER while holding the build
  // lock (stale-reclaim only rescues a DEAD holder, not a hung-but-alive one).
  const NET = { timeoutMs: 180_000 };
  const byShaFetch = await git(["fetch", "--depth", "1", "origin", pin.sha], NET);
  if (byShaFetch.code !== 0) {
    await ok(await git(["fetch", "origin", pin.ref], NET), "git fetch (fallback by ref)");
  }
  await ok(await git(["checkout", "-q", "--detach", pin.sha]), "git checkout pinned SHA");
  const head = (await ok(await git(["rev-parse", "HEAD"]), "git rev-parse")).stdout.trim();
  if (head !== pin.sha) throw new Error(`Redlib clone HEAD ${head} != pinned ${pin.sha} — refusing to build an unpinned tree`);
}

// Node's arch names -> OCI arch names, for the doctor arch-match check.
export function hostArch(a: string = osArch()): string {
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  return a;
}

// The arch the built image actually targets (warn/abort on an emulated mismatch).
export async function imageArch(engine: Engine, tag: string, run: Runner = defaultRunner): Promise<string> {
  const r = await run(engine.bin, ["image", "inspect", tag, "--format", "{{.Architecture}}"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Build Redlib FROM SOURCE with Dockerfile.ubuntu ONLY. Generous first-build timeout
// (Rust compile) distinct from the runtime health timeout. Streams progress live.
// `-f` must be the Dockerfile INSIDE the clone dir: BuildKit (docker-desktop's default builder)
// resolves a `-f` path relative to the CLI's CWD, NOT the build context, so a bare "Dockerfile.ubuntu"
// looks in the caller's CWD and fails with "no such file". Qualify it against `dir`.
export async function buildImage(dir: string, tag: string, engine: Engine, run: Runner = defaultRunner): Promise<void> {
  const r = await run(
    engine.bin,
    ["build", "-f", join(dir, "Dockerfile.ubuntu"), "-t", tag, dir],
    { timeoutMs: 1_200_000, stream: true }, // 20 min; a from-source Redlib (Rust) build is slow
  );
  if (r.code !== 0) throw new Error(`Redlib image build failed (${engine.kind}). Last build output:\n${r.stderr.slice(-2000)}`);
}

export async function runContainer(
  engine: Engine,
  opts: { image: string; name: string; port: number; host?: string; restart?: boolean },
  run: Runner = defaultRunner,
): Promise<void> {
  const host = opts.host ?? "127.0.0.1"; // loopback default
  const args = ["run", "-d", "--name", opts.name, "-p", `${host}:${opts.port}:8080`];
  if (opts.restart !== false) args.push("--restart", "unless-stopped");
  args.push(opts.image);
  await ok(await run(engine.bin, args), `start container ${opts.name}`);
}

export async function stopContainer(engine: Engine, name: string, run: Runner = defaultRunner): Promise<void> {
  await run(engine.bin, ["rm", "-f", name]); // best-effort; absent container is fine
}

// Restart a running container (by name or id). Used by `redlib-mcp restart` to refetch a stale
// Reddit OAuth token — the container stays Up when the token dies, so nothing else restarts it.
export async function restartContainer(engine: Engine, nameOrId: string, run: Runner = defaultRunner): Promise<void> {
  await ok(await run(engine.bin, ["restart", nameOrId]), `restart container ${nameOrId}`);
}

// The container id publishing `port` on the host, or null. Used to detect "already running on :8080".
export async function containerIdOnPort(engine: Engine, port: number, run: Runner = defaultRunner): Promise<string | null> {
  // Match the published HOST port from the Ports column. `--filter publish=` is DOCKER-ONLY — podman
  // rejects it ("publish is an invalid filter"), so parse the port here with a format both engines share.
  const r = await run(engine.bin, ["ps", "--format", "{{.ID}} {{.Ports}}"]);
  // A FAILED `ps` (exit != 0) is NOT "no container": returning null there would let setup's clean-install
  // branch `rm -f` a live container and bind an unverified image on a transient engine hiccup. Fail loudly.
  if (r.code !== 0) throw new Error(`\`${engine.kind} ps\` failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(-200)}`);
  // Ports look like "0.0.0.0:8080->8080/tcp" / "127.0.0.1:8080->8080/tcp" / "[::]:8080->8080/tcp".
  // ":<port>->" is the HOST-published side (the container side reads "-><port>/"), so no false match.
  for (const line of r.stdout.split("\n")) {
    if (new RegExp(`:${port}->`).test(line)) {
      const id = line.trim().split(/\s+/)[0];
      if (id) return id;
    }
  }
  return null;
}

// Find the engine that actually HOSTS the redlib container on `port`, across BOTH docker and podman.
// On a dual-engine machine the backend can live on the non-preferred engine (e.g. built with
// `--engine podman` while docker is also installed) — plain detectEngine picks docker and misses it, so
// restart/doctor/update would look in the wrong store. An explicit choice (REDLIB_ENGINE abs path, or
// `prefer` from `--engine`) short-circuits the search. Returns the hosting engine + container id; or the
// first working engine with id=null when nothing hosts it (so callers still resolve a sane engine for
// their "not running -> run setup" message). Throws the standard clear error only if NO engine works.
export async function locateBackend(
  port: number,
  prefer?: "docker" | "podman",
  run: Runner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): Promise<{ engine: Engine; id: string | null }> {
  if (env.REDLIB_ENGINE || prefer) {
    const engine = await detectEngine(run, env, exists, prefer);
    return { engine, id: await containerIdOnPort(engine, port, run) };
  }
  let fallback: Engine | null = null;
  for (const kind of ["docker", "podman"] as const) {
    let engine: Engine;
    try { engine = await detectEngine(run, env, exists, kind); } catch { continue; } // this kind not installed/working
    fallback ??= engine;                                   // first working engine = a sane default for messages
    if (!(await daemonReachable(engine, run))) continue;   // can't `ps` a down daemon; try the other engine
    let id: string | null = null;
    try { id = await containerIdOnPort(engine, port, run); } catch { continue; } // ps hiccup on this engine: try the other
    if (id) return { engine, id };                         // this engine HOSTS the backend
  }
  if (fallback) return { engine: fallback, id: null };     // engine(s) present, backend not running on either
  return { engine: await detectEngine(run, env, exists), id: null }; // nothing installed -> standard clear throw
}

export async function tagImage(engine: Engine, from: string, to: string, run: Runner = defaultRunner): Promise<void> {
  await ok(await run(engine.bin, ["tag", from, to]), `tag ${from} -> ${to}`);
}

export async function removeImage(engine: Engine, tag: string, run: Runner = defaultRunner): Promise<void> {
  await run(engine.bin, ["rmi", "-f", tag]); // best-effort cleanup
}

// Poll a Redlib URL until it answers 200, or give up. Distinct from the build timeout.
// fetchFn injectable for tests; defaults to global fetch (Node ≥18).
export async function waitHealthy(
  url: string,
  opts: { tries?: number; delayMs?: number; fetchFn?: (u: string) => Promise<{ ok: boolean }> } = {},
): Promise<boolean> {
  const tries = opts.tries ?? 60;
  const delayMs = opts.delayMs ?? 1000;
  const fetchFn = opts.fetchFn ?? ((u: string) => fetch(u)); // global fetch's Response already has `ok`
  for (let i = 0; i < tries; i++) {
    try { if ((await fetchFn(`${url}/settings`)).ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

// Cross-platform build lock: create a sentinel with O_EXCL ("wx"); if it already exists
// and is fresh, another build is running -> refuse (do not stack a second multi-minute Rust
// compile). A lock older than staleMs is assumed crashed and reclaimed. Always released in finally.
// an O_EXCL sentinel is enough for one-machine single-user serialization; no lock daemon.
export async function withBuildLock<T>(lockPath: string, fn: () => Promise<T>, opts: { staleMs?: number } = {}): Promise<T> {
  const staleMs = opts.staleMs ?? 30 * 60 * 1000; // > worst-case build
  mkdirSync(dirname(lockPath), { recursive: true });
  const acquire = (): number => {
    try { return openSync(lockPath, "wx"); }
    catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      // mtimeMs is a sub-ms float while Date.now() is integer ms, so a just-written lock can read
      // as a tiny negative age; clamp to 0 so staleMs:0 correctly reclaims any existing lock.
      const age = Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
      if (age < staleMs) throw new Error(`A Redlib build is already in progress (lock: ${lockPath}). Wait for it to finish, or delete the lock if it is stale.`);
      rmSync(lockPath, { force: true });               // reclaim a crashed build's stale lock
      try { return openSync(lockPath, "wx"); }
      catch (e2: any) {
        // Lost a race to reclaim the SAME stale lock (another process re-created it first). Surface the
        // friendly in-progress message instead of letting a raw EEXIST escape withBuildLock.
        if (e2?.code === "EEXIST") throw new Error(`A Redlib build is already in progress (lock: ${lockPath}).`);
        throw e2;
      }
    }
  };
  const fd = acquire();
  closeSync(fd);
  try { return await fn(); }
  finally { rmSync(lockPath, { force: true }); }
}
