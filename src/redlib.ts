import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { arch as osArch } from "node:os";
import { join } from "node:path";
import { REDLIB_PIN } from "./pin.js";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  file: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; stream?: boolean },
) => Promise<RunResult>;

// The one place a subprocess is spawned. ALWAYS an argv array + shell:false (spec §8 — never sh -c).
// `stream` forwards the child's stderr live (long Rust builds) while still capturing it.
export const defaultRunner: Runner = (file, args, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, shell: false });
    let stdout = "", stderr = "";
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; if (opts.stream) process.stderr.write(d); });
    child.on("error", (e) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr: stderr + String(e), code: 127 }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });

export interface Engine { bin: string; kind: "docker" | "podman"; }

// Explicit ABSOLUTE candidate paths ONLY (spec §8 — "not bare PATH"). A bare `docker`/`podman`
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
export async function detectEngine(
  run: Runner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): Promise<Engine> {
  // Explicit override: an ABSOLUTE path the operator vouches for — NOT bare-PATH resolution (spec §8).
  const override = env.REDLIB_ENGINE;
  if (override) {
    if (!override.includes("/") && !override.includes("\\")) throw new Error(`REDLIB_ENGINE must be an ABSOLUTE path to a docker/podman binary, not a bare name: ${override}`);
    const r = await run(override, ["version", "--format", "{{.Client.Version}}"]).catch(() => ({ stdout: "", stderr: "spawn failed", code: 127 }));
    if (r.code === 0) return { bin: override, kind: /podman/i.test(override) ? "podman" : "docker" };
    throw new Error(`REDLIB_ENGINE=${override} did not respond to \`version\`.`);
  }
  const misses: string[] = [];
  for (const kind of ["docker", "podman"] as const) {
    for (const cand of CANDIDATES[kind]) {
      if (!exists(cand)) continue; // absolute-only: a candidate that is not on disk is never probed
      const r = await run(cand, ["version", "--format", "{{.Client.Version}}"]).catch(() => ({ stdout: "", stderr: "spawn failed", code: 127 }));
      if (r.code === 0) return { bin: cand, kind };
      misses.push(cand);
    }
  }
  throw new Error(
    `No working container engine found at the standard absolute paths (${[...CANDIDATES.docker, ...CANDIDATES.podman].join(", ")}). ` +
    `Bare PATH is intentionally not searched (spec §8); set REDLIB_ENGINE to an absolute docker/podman path if yours is elsewhere. Is Docker Desktop (or Podman) running?`,
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
// force-moved remote can't slip an unpinned tree past this (spec §6.1).
export async function cloneAtPin(dir: string, run: Runner = defaultRunner, pin = REDLIB_PIN): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[], opts?: { timeoutMs?: number }) => run("git", ["-C", dir, ...args], opts);
  if (!existsSync(join(dir, ".git"))) {
    await ok(await run("git", ["init", "-q", dir]), "git init");
    await ok(await git(["remote", "add", "origin", pin.repo]), "git remote add");
  }
  const byShaFetch = await git(["fetch", "--depth", "1", "origin", pin.sha]);
  if (byShaFetch.code !== 0) {
    await ok(await git(["fetch", "origin", pin.ref]), "git fetch (fallback by ref)");
  }
  await ok(await git(["checkout", "-q", "--detach", pin.sha]), "git checkout pinned SHA");
  const head = (await ok(await git(["rev-parse", "HEAD"]), "git rev-parse")).stdout.trim();
  if (head !== pin.sha) throw new Error(`Redlib clone HEAD ${head} != pinned ${pin.sha} — refusing to build an unpinned tree`);
}

// Node's arch names -> OCI arch names, for the doctor arch-match check (spec §6.2).
export function hostArch(a: string = osArch()): string {
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  return a;
}

// The arch the built image actually targets (spec §6.2: warn/abort on an emulated mismatch).
export async function imageArch(engine: Engine, tag: string, run: Runner = defaultRunner): Promise<string> {
  const r = await run(engine.bin, ["image", "inspect", tag, "--format", "{{.Architecture}}"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

// Build Redlib FROM SOURCE with Dockerfile.ubuntu ONLY (spec §6.2). Generous first-build timeout
// (Rust compile) distinct from the runtime health timeout (spec §8). Streams progress live.
export async function buildImage(dir: string, tag: string, engine: Engine, run: Runner = defaultRunner): Promise<void> {
  const r = await run(
    engine.bin,
    ["build", "-f", "Dockerfile.ubuntu", "-t", tag, dir],
    { timeoutMs: 1_200_000, stream: true }, // 20 min; matches the reference quadlet TimeoutStartSec
  );
  if (r.code !== 0) throw new Error(`Redlib image build failed (${engine.kind}). Last build output:\n${r.stderr.slice(-2000)}`);
}
