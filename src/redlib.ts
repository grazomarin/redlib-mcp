import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

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
