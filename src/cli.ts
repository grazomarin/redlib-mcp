import {
  detectEngine, daemonReachable, containerIdOnPort, waitHealthy, hostArch, imageArch,
  type Engine,
} from "./redlib.js";
import { verifyCandidate } from "./verify.js";
import { resolveRedlibUrl } from "./config.js";

const CONTAINER_NAME = "redlib-mcp";
const DEFAULT_PORT = 8080;

// Everything human-facing goes to STDERR. CLI mode does not share serve mode's stdout-purity rule,
// but keeping logs on stderr means `redlib-mcp doctor >x` stays clean and pipeable.
const say = (s: string) => process.stderr.write(s + "\n");

export type DoctorResult = { check: string; ok: boolean; detail: string; fix?: string };

// Deps are injected so the diagnostic sequence is testable without a real engine/container.
export interface DoctorDeps {
  detectEngine: () => Promise<Engine>;
  daemonReachable: (e: Engine) => Promise<boolean>;
  containerIdOnPort: (e: Engine, port: number) => Promise<string | null>;
  waitHealthy: (url: string) => Promise<boolean>;
  verifyCandidate: (url: string) => Promise<{ decision: string; lastKind: string; detail: string }>;
  hostArch: () => string;
  imageArch: (e: Engine, tag: string) => Promise<string>;
  url: string;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult[]> {
  const out: DoctorResult[] = [];
  let engine: Engine;
  try { engine = await deps.detectEngine(); out.push({ check: "engine", ok: true, detail: `${engine.kind} (${engine.bin})` }); }
  catch (e: any) { out.push({ check: "engine", ok: false, detail: String(e?.message || e), fix: "Install Docker Desktop or Podman; ensure it is on PATH." }); return out; }

  const daemon = await deps.daemonReachable(engine);
  out.push({ check: "daemon", ok: daemon, detail: daemon ? "reachable" : "unreachable", fix: daemon ? undefined : "Start Docker Desktop / the Docker daemon (mac/Win: check 'launch at login')." });
  if (!daemon) return out;

  const id = await deps.containerIdOnPort(engine, DEFAULT_PORT);
  out.push({ check: `container on :${DEFAULT_PORT}`, ok: !!id, detail: id ? `running (${id})` : "not running", fix: id ? undefined : "Run `redlib-mcp setup` to build and start the Redlib backend." });
  if (!id) return out;

  const healthy = await deps.waitHealthy(deps.url);
  out.push({ check: "http health", ok: healthy, detail: healthy ? "200 OK" : "no 200", fix: healthy ? undefined : "Container is up but not serving; check `docker logs redlib-mcp`." });

  const v = await deps.verifyCandidate(deps.url);
  const smokeOk = v.decision === "promote";
  out.push({
    check: "end-to-end smoke",
    ok: smokeOk,
    detail: smokeOk ? "valid content" : `${v.lastKind}: ${v.detail}`,
    // The §6.3 terminal window: at the pinned commit but reads still fail -> upstream lag, not the user.
    fix: smokeOk ? undefined
      : v.lastKind === "PARSE_ERROR"
        ? "Redlib output changed shape — likely a redlib-mcp/pin mismatch; run `redlib-mcp update`."
        : "Transient (Reddit throttling or upstream token-stale). If it persists at the current pin, upstream Redlib has no fix yet — not your setup; wait/watch redlib-org.",
  });

  const [want, got] = [deps.hostArch(), await deps.imageArch(engine, "localhost/redlib:latest")];
  out.push({ check: "image arch", ok: !got || got === want, detail: got ? `${got} (host ${want})` : "unknown", fix: got && got !== want ? `Built image is ${got} but host is ${want} (emulated/slow) — rebuild with \`redlib-mcp update\`.` : undefined });
  return out;
}

export function formatDoctor(results: DoctorResult[]): { text: string; exitCode: number } {
  const lines = results.map((r) => `${r.ok ? "OK  " : "FAIL"} ${r.check}: ${r.detail}${r.ok || !r.fix ? "" : `\n     -> ${r.fix}`}`);
  const failed = results.some((r) => !r.ok);
  return { text: lines.join("\n"), exitCode: failed ? 1 : 0 };
}

async function cmdDoctor(): Promise<number> {
  const url = resolveRedlibUrl();
  const results = await runDoctor({
    detectEngine: () => detectEngine(),
    daemonReachable: (e) => daemonReachable(e),
    containerIdOnPort: (e, port) => containerIdOnPort(e, port),
    waitHealthy: (u) => waitHealthy(u, { tries: 3, delayMs: 1000 }), // doctor fast-fails (~3s); the 60s budget is for setup's post-build bring-up
    verifyCandidate: (u) => verifyCandidate(u),
    hostArch: () => hostArch(),
    imageArch: (e, tag) => imageArch(e, tag),
    url,
  });
  const { text, exitCode } = formatDoctor(results);
  say(text);
  return exitCode;
}

function printHelp(): void {
  say(
    "redlib-mcp — read public Reddit via a self-hosted Redlib backend.\n" +
    "  redlib-mcp serve             run the MCP stdio server\n" +
    "  redlib-mcp setup             build + start the Redlib backend, register the MCP\n" +
    "  redlib-mcp update            rebuild at the pinned commit; promote only if verified\n" +
    "  redlib-mcp doctor            diagnose engine/container/health and print fixes",
  );
}

export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "doctor": return cmdDoctor();
    case "setup": say("redlib-mcp setup: implemented in the next task of this plan."); return 2;   // Task 8
    case "update": say("redlib-mcp update: implemented in the next task of this plan."); return 2; // Task 9
    default: printHelp(); return cmd ? 2 : 0;
  }
}
