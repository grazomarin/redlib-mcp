import {
  detectEngine, daemonReachable, containerIdOnPort, waitHealthy, hostArch, imageArch,
  cloneAtPin, buildImage, runContainer, stopContainer, tagImage, removeImage, withBuildLock,
  type Engine,
} from "./engine.js";
import { verifyCandidate } from "./verify.js";
import { resolveRedlibUrl } from "./config.js";
import { cloneDir, buildLockPath } from "./paths.js";
import { REDLIB_PIN } from "./pin.js";
import { mergeServer, writeAtomic, diffLines, type ServerEntry } from "./config-write.js";
import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";

// Single source of truth for the version: read package.json at runtime so a release bump in ONE place
// flows to both the emitted client-config entry AND the MCP handshake — no hand-synced "1.0.0" literals.
const VERSION: string = createRequire(import.meta.url)("../package.json").version;
const CONTAINER_NAME = "redlib-mcp";
const DEFAULT_PORT = 8080;
const IMAGE = "localhost/redlib:latest";        // the promoted, live image tag
const BUILD_TAG = "localhost/redlib:building";  // the unpromoted candidate tag (verify-before-swap)

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

  let id: string | null;
  try { id = await deps.containerIdOnPort(engine, DEFAULT_PORT); }
  catch (e: any) { out.push({ check: `container on :${DEFAULT_PORT}`, ok: false, detail: `engine query failed: ${e?.message || e}`, fix: "The container engine errored on `ps` — check it is healthy, then re-run." }); return out; }
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

  const [want, got] = [deps.hostArch(), await deps.imageArch(engine, IMAGE)];
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

export function printHelp(): void {
  say(
    "redlib-mcp — read public Reddit via a self-hosted Redlib backend.\n" +
    "  redlib-mcp serve             run the MCP stdio server\n" +
    "  redlib-mcp setup             build + start the Redlib backend, register the MCP\n" +
    "  redlib-mcp update            rebuild at the pinned commit; promote only if verified\n" +
    "  redlib-mcp doctor            diagnose engine/container/health and print fixes\n" +
    "\nsetup flags: --yes (write the client config without an interactive prompt — for agents,\n" +
    "             which have no TTY), --print-only (show the diff, don't write), --port <n>, --non-loopback",
  );
}

// The candidate verify-before-swap sequence shared by setup's re-setup branch and update: run the
// freshly-built candidate on a temp port, verify it, and apply the ONE correct image op per decision —
// promote: tag :latest + drop the build tag; discard: drop the build tag (broken build); defer: KEEP
// the candidate image unpromoted (the op we must NOT do — deleting it wastes the build and breaks
// re-verify). One home keeps this correctness-critical invariant from drifting between the two callers.
interface SwapDeps {
  stopContainer: (e: Engine, name: string) => Promise<void>;
  runContainer: (e: Engine, o: { image: string; name: string; port: number; host?: string; restart?: boolean }) => Promise<void>;
  waitHealthy: (url: string) => Promise<boolean>;
  verifyCandidate: (url: string) => Promise<{ decision: string; lastKind: string; detail: string }>;
  tagImage: (e: Engine, from: string, to: string) => Promise<void>;
  removeImage: (e: Engine, tag: string) => Promise<void>;
}
async function verifyBeforeSwap(engine: Engine, d: SwapDeps, buildTag: string, tmpPort: number): Promise<{ decision: string; lastKind: string; detail: string }> {
  const tmpName = `${CONTAINER_NAME}-candidate`;
  await d.stopContainer(engine, tmpName);
  await d.runContainer(engine, { image: buildTag, name: tmpName, port: tmpPort, host: "127.0.0.1", restart: false });
  const tmpUrl = `http://127.0.0.1:${tmpPort}`;
  const v = (await d.waitHealthy(tmpUrl))
    ? await d.verifyCandidate(tmpUrl)
    : { decision: "defer", lastKind: "REDLIB_DOWN", detail: "candidate never healthy" };
  await d.stopContainer(engine, tmpName);
  if (v.decision === "promote") { await d.tagImage(engine, buildTag, IMAGE); await d.removeImage(engine, buildTag); }
  else if (v.decision === "discard") { await d.removeImage(engine, buildTag); } // broken build — throw the candidate away
  // defer: intentionally KEEP buildTag unpromoted for a later re-verify — the one image op we must NOT do.
  return v;
}

// Tiny hand-rolled flag parser (spec §14: no arg-parsing dependency; keeps cold-start light).
// Supports `--flag`, `--key value`, `--key=value`. Unknown flags are tolerated (forward-compat).
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const f: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) { f[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { f[key] = next; i++; } else { f[key] = true; }
  }
  return f;
}

// The MCP config entry `setup` writes. Immutable-versioned (spec §7): an absolute installed bin if
// we have one (offline start, no registry round-trip), else EXACT-version npx — never floating.
export function serverEntry(binPath: string | null, version: string): ServerEntry {
  return binPath
    ? { command: binPath, args: ["serve"] }
    : { command: "npx", args: ["-y", `redlib-mcp@${version}`, "serve"] };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-TTY without --yes never auto-writes
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ans: string = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

export interface SetupDeps {
  detectEngine: () => Promise<Engine>;
  daemonReachable: (e: Engine) => Promise<boolean>;
  cloneAtPin: (dir: string) => Promise<void>;
  buildImage: (dir: string, tag: string, e: Engine) => Promise<void>;
  containerIdOnPort: (e: Engine, port: number) => Promise<string | null>;
  runContainer: (e: Engine, o: { image: string; name: string; port: number; host?: string; restart?: boolean }) => Promise<void>;
  tagImage: (e: Engine, from: string, to: string) => Promise<void>;
  removeImage: (e: Engine, tag: string) => Promise<void>;
  stopContainer: (e: Engine, name: string) => Promise<void>;
  waitHealthy: (url: string) => Promise<boolean>;
  verifyCandidate: (url: string) => Promise<{ decision: string; lastKind: string; detail: string }>;
  withBuildLock: (fn: () => Promise<void>) => Promise<void>;
  resolveClientConfig: () => string;
  version: string;
}

function withSetupDefaults(deps?: Partial<SetupDeps>): SetupDeps {
  return {
    detectEngine: () => detectEngine(),
    daemonReachable: (e) => daemonReachable(e),
    cloneAtPin: (dir) => cloneAtPin(dir),
    buildImage: (dir, tag, e) => buildImage(dir, tag, e),
    containerIdOnPort: (e, port) => containerIdOnPort(e, port),
    runContainer: (e, o) => runContainer(e, o),
    tagImage: (e, from, to) => tagImage(e, from, to),
    removeImage: (e, tag) => removeImage(e, tag),
    stopContainer: (e, name) => stopContainer(e, name),
    waitHealthy: (url) => waitHealthy(url),
    verifyCandidate: (url) => verifyCandidate(url),
    withBuildLock: (fn) => withBuildLock(buildLockPath(), fn), // serialize concurrent builds (spec §8)
    resolveClientConfig: () => process.env.REDLIB_MCP_CLIENT_CONFIG || "",
    version: VERSION,
    ...deps,
  };
}

export async function cmdSetup(argv: string[], deps?: Partial<SetupDeps>): Promise<number> {
  const flags = parseFlags(argv);
  const port = parseInt(typeof flags.port === "string" ? flags.port : String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) { say(`invalid --port value: ${String(flags.port)}`); return 2; }
  const host = flags["non-loopback"] ? "0.0.0.0" : "127.0.0.1";
  const d = withSetupDefaults(deps);

  const engine = await d.detectEngine();
  say(`engine: ${engine.kind} (${engine.bin})`);
  if (!(await d.daemonReachable(engine))) { say("Docker/Podman daemon is not reachable — start it and re-run."); return 3; }
  if (host === "0.0.0.0") say("WARNING: --non-loopback exposes an UNAUTHENTICATED Redlib to your LAN (Docker bypasses host firewalls). See spec §6.4.");

  const alreadyRunning = await d.containerIdOnPort(engine, port);
  const buildTag = alreadyRunning ? BUILD_TAG : IMAGE;
  const dir = cloneDir();
  // Clone + build inside the build lock so a concurrent setup/update can't stack a second Rust compile.
  await d.withBuildLock(async () => {
    say(`cloning Redlib at pinned ${REDLIB_PIN.ref}@${REDLIB_PIN.sha.slice(0, 12)} -> ${dir}`);
    await d.cloneAtPin(dir);
    say(`building image (${buildTag}); first build compiles Rust and can take many minutes...`);
    await d.buildImage(dir, buildTag, engine);
  });

  if (!alreadyRunning) {
    // Clean install: nothing to protect, bind :port directly, then verify (spec §6.7).
    // Clear any stale/stopped same-name container first (rm -f is a no-op when absent) so the fresh
    // bind can't hit a `docker run --name redlib-mcp` conflict — the exact state doctor tells the
    // user to fix by re-running setup. containerIdOnPort only sees RUNNING containers, so a stopped
    // `redlib-mcp` slips past the alreadyRunning check and would otherwise crash the direct bind.
    await d.stopContainer(engine, CONTAINER_NAME);
    await d.runContainer(engine, { image: IMAGE, name: CONTAINER_NAME, port, host });
    const url = `http://127.0.0.1:${port}`;
    if (!(await d.waitHealthy(url))) { say("container started but never became healthy; see `docker logs redlib-mcp`."); return 4; }
    const v = await d.verifyCandidate(url);
    if (v.decision !== "promote") { say(`verify failed (${v.lastKind}): ${v.detail}`); return 5; }
    say("verified: serving valid content.");
  } else {
    // Re-setup/repair with a live service: verify the candidate on a TEMP port before swapping.
    const v = await verifyBeforeSwap(engine, d, buildTag, port + 1);
    if (v.decision === "promote") say("candidate verified and promoted to :latest. Restart the container to pick it up (or it will on next restart).");
    else if (v.decision === "discard") { say(`candidate DISCARDED (${v.lastKind}): ${v.detail}. Kept the current image.`); return 5; }
    else { say(`candidate inconclusive (${v.lastKind}): ${v.detail}. Kept the current image serving; candidate retained as ${buildTag}. Re-run \`redlib-mcp update\` later to re-verify.`); return 6; }
  }

  // Register the MCP into the caller's client config (atomic, diff + confirm) — spec §5.2 step 6.
  const cfgPath = d.resolveClientConfig();
  // No config path (env unset, no --client) -> the backend is ready; skip registration rather than
  // crash. writeAtomic("") would renameSync into "" and throw ENOENT AFTER a successful build.
  // Plan 3's skill supplies the per-agent path; a bare `setup` without it still succeeds here.
  if (!cfgPath) { say("Backend is ready. No MCP client-config path given (set REDLIB_MCP_CLIENT_CONFIG or run via the setup skill) — skipping client registration."); return 0; }
  const before = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
  const entry = serverEntry(null, d.version); // Plan 3's skill may pass an absolute bin; default exact-version npx
  const { text } = mergeServer(before, "redlib-mcp", entry);
  say(`\nMCP client config: ${cfgPath}\n${diffLines(before, text)}`);
  if (flags["print-only"]) { say("(--print-only: not writing the config.)"); return 0; }
  if (!flags.yes && !(await confirm("Write this MCP entry?"))) { say("Skipped config write. Re-run with --yes to apply."); return 0; }
  writeAtomic(cfgPath, text);
  say(`wrote ${cfgPath} (backup at ${cfgPath}.bak).`);
  return 0;
}

export interface UpdateDeps {
  detectEngine: () => Promise<Engine>;
  daemonReachable: (e: Engine) => Promise<boolean>;
  cloneAtPin: (dir: string) => Promise<void>;
  buildImage: (dir: string, tag: string, e: Engine) => Promise<void>;
  runContainer: (e: Engine, o: { image: string; name: string; port: number; host?: string; restart?: boolean }) => Promise<void>;
  stopContainer: (e: Engine, name: string) => Promise<void>;
  waitHealthy: (url: string) => Promise<boolean>;
  tagImage: (e: Engine, from: string, to: string) => Promise<void>;
  removeImage: (e: Engine, tag: string) => Promise<void>;
  verifyCandidate: (url: string) => Promise<{ decision: string; lastKind: string; detail: string }>;
  withBuildLock: (fn: () => Promise<void>) => Promise<void>;
}

// `update` rebuilds Redlib AT THE PINNED COMMIT (never live-fetches HEAD) to a temp tag, verifies
// it on a temp port, and promotes :latest ONLY on valid data. PARSE_ERROR discards (keep old);
// a transient defers (keep old, re-verify later). The live service is never disrupted (spec §6.7).
export async function cmdUpdate(argv: string[], deps?: Partial<UpdateDeps>): Promise<number> {
  const d: UpdateDeps = {
    detectEngine: () => detectEngine(), daemonReachable: (e) => daemonReachable(e),
    cloneAtPin: (dir) => cloneAtPin(dir), buildImage: (dir, tag, e) => buildImage(dir, tag, e),
    runContainer: (e, o) => runContainer(e, o), stopContainer: (e, n) => stopContainer(e, n),
    waitHealthy: (u) => waitHealthy(u), tagImage: (e, f, t) => tagImage(e, f, t),
    removeImage: (e, t) => removeImage(e, t), verifyCandidate: (u) => verifyCandidate(u),
    withBuildLock: (fn) => withBuildLock(buildLockPath(), fn), // serialize concurrent builds (spec §8)
    ...deps,
  };
  const engine = await d.detectEngine();
  if (!(await d.daemonReachable(engine))) { say("daemon not reachable; start it and re-run."); return 3; }

  const dir = cloneDir();
  const buildTag = BUILD_TAG;
  // Clone + build inside the build lock so a concurrent setup/update can't stack a second Rust compile.
  await d.withBuildLock(async () => {
    say(`rebuilding Redlib at pinned ${REDLIB_PIN.ref}@${REDLIB_PIN.sha.slice(0, 12)}`);
    await d.cloneAtPin(dir);
    await d.buildImage(dir, buildTag, engine);
  });

  const v = await verifyBeforeSwap(engine, d, buildTag, DEFAULT_PORT + 1);
  if (v.decision === "promote") { say("update verified and promoted to :latest. Restart the container to apply."); return 0; }
  if (v.decision === "discard") { say(`update DISCARDED (${v.lastKind}): ${v.detail}. Kept the current image.`); return 5; }
  // defer: inconclusive — verifyBeforeSwap kept the candidate image unpromoted; do NOT delete it (that
  // would waste the long build and break the re-verify path).
  say(`update inconclusive (${v.lastKind}): ${v.detail}. Kept the current image serving; the new candidate is retained as ${buildTag} — re-run \`redlib-mcp update\` later to re-verify. If it persists at this pin, upstream Redlib has no fix yet — not your setup.`);
  return 6;
}

export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case "doctor": return cmdDoctor();
    case "setup": return cmdSetup(argv.slice(1));
    case "update": return cmdUpdate(argv.slice(1));
    default: printHelp(); return cmd ? 2 : 0;
  }
}
