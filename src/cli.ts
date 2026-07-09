import {
  detectEngine, daemonReachable, containerIdOnPort, locateBackend, waitHealthy, hostArch, imageArch,
  cloneAtPin, buildImage, runContainer, stopContainer, restartContainer, tagImage, removeImage, withBuildLock,
  type Engine,
} from "./engine.js";
import { verifyCandidate } from "./verify.js";
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
  locateBackend: (port: number) => Promise<{ engine: Engine; id: string | null }>;
  daemonReachable: (e: Engine) => Promise<boolean>;
  waitHealthy: (url: string) => Promise<boolean>;
  verifyCandidate: (url: string) => Promise<{ decision: string; lastKind: string; detail: string }>;
  hostArch: () => string;
  imageArch: (e: Engine, tag: string) => Promise<string>;
  url: string;
  port?: number;
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult[]> {
  const out: DoctorResult[] = [];
  const port = deps.port ?? DEFAULT_PORT;
  let engine: Engine, id: string | null;
  // Locate the backend across BOTH engines — on a dual-engine machine it may be on the non-preferred one.
  try {
    ({ engine, id } = await deps.locateBackend(port));
    out.push({ check: "engine", ok: true, detail: `${engine.kind} (${engine.bin})${id ? " — hosts the backend" : ""}` });
  } catch (e: any) {
    out.push({ check: "engine", ok: false, detail: String(e?.message || e), fix: "Install Docker Desktop or Podman; ensure it is on PATH." });
    return out;
  }

  const daemon = await deps.daemonReachable(engine);
  out.push({ check: "daemon", ok: daemon, detail: daemon ? "reachable" : "unreachable", fix: daemon ? undefined : "Start Docker Desktop / the Docker daemon (mac/Win: check 'launch at login')." });
  if (!daemon) return out;

  out.push({ check: `container on :${port}`, ok: !!id, detail: id ? `running (${id})` : "not running", fix: id ? undefined : "Run `redlib-mcp setup` to build and start the Redlib backend. If you ran `setup --port <n>`, pass the same `--port` to doctor." });
  if (!id) return out;

  const healthy = await deps.waitHealthy(deps.url);
  out.push({ check: "http health", ok: healthy, detail: healthy ? "200 OK" : "no 200", fix: healthy ? undefined : "Container is up but not serving; check `docker logs redlib-mcp`." });

  const v = await deps.verifyCandidate(deps.url);
  const smokeOk = v.decision === "promote";
  out.push({
    check: "end-to-end smoke",
    ok: smokeOk,
    detail: smokeOk ? "valid content" : `${v.lastKind}: ${v.detail}`,
    // The terminal window: at the pinned commit but reads still fail -> upstream lag, not the user.
    fix: smokeOk ? undefined
      : v.lastKind === "PARSE_ERROR"
        ? "Redlib output changed shape — likely a redlib-mcp/pin mismatch; run `redlib-mcp update`."
        : "Often a stale Reddit token — try `redlib-mcp restart` (refetches it), then re-run doctor. If it persists at the current pin, it's upstream Redlib (throttling or a token-method change), not your setup.",
  });

  const [want, got] = [deps.hostArch(), await deps.imageArch(engine, IMAGE)];
  out.push({ check: "image arch", ok: !got || got === want, detail: got ? `${got} (host ${want})` : "unknown", fix: got && got !== want ? `Built image is ${got} but host is ${want} (emulated/slow) — rebuild with \`redlib-mcp update\`.` : undefined });
  return out;
}

// Color only when writing to a real terminal; stay plain when piped or NO_COLOR is set (and in tests).
const COLOR = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

export function formatDoctor(results: DoctorResult[]): { text: string; exitCode: number } {
  const lines = results.map((r) => {
    const tag = r.ok ? paint("32", "OK  ") : paint("31", "FAIL"); // green / red
    const fix = r.ok || !r.fix ? "" : `\n     ${paint("2", "->")} ${r.fix}`;
    return `${tag} ${paint("1", r.check)}: ${r.detail}${fix}`;
  });
  const failed = results.some((r) => !r.ok);
  return { text: lines.join("\n"), exitCode: failed ? 1 : 0 };
}

export async function cmdDoctor(argv: string[] = [], deps?: Partial<DoctorDeps>): Promise<number> {
  const flags = parseFlags(argv);
  const pf = parsePortFlag(flags);
  if (pf.err) { say(pf.err); return 2; }
  const port = pf.port!;
  const eng = parseEngineFlag(flags);
  if (eng.err) { say(eng.err); return 2; }
  // doctor diagnoses the LOCAL container it manages, always on the resolved port — a single source
  // of truth so location and the health/smoke probe can never target different ports.
  const url = `http://127.0.0.1:${port}`;
  const results = await runDoctor({
    port,
    locateBackend: (p) => locateBackend(p, eng.prefer),
    daemonReachable: (e) => daemonReachable(e),
    waitHealthy: (u) => waitHealthy(u, { tries: 3, delayMs: 1000 }), // doctor fast-fails (~3s)
    verifyCandidate: (u) => verifyCandidate(u),
    hostArch: () => hostArch(),
    imageArch: (e, tag) => imageArch(e, tag),
    url,
    ...deps,
  });
  const { text, exitCode } = formatDoctor(results);
  say(text);
  return exitCode;
}

// Per-command detail, shown by `redlib-mcp <command> --help`. Written for a human reading their terminal.
const CMD_HELP: Record<string, string> = {
  setup:
    "redlib-mcp setup — build + start the Redlib backend, then register the MCP into your client.\n" +
    "  Resolves docker/podman, clones + builds Redlib from the pinned commit, runs it on 127.0.0.1:8080,\n" +
    "  verifies it end to end, then (with your confirmation) writes the MCP client-config entry.\n" +
    "  Flags:\n" +
    "    --yes                   write the client config without asking (non-interactive / agent use)\n" +
    "    --print-only            show the config diff but do not write it\n" +
    "    --port <n>              host port to bind (default 8080)\n" +
    "    --non-loopback          bind 0.0.0.0 — exposes an UNAUTHENTICATED backend to your LAN\n" +
    "    --engine docker|podman  force the engine (default: docker if present, else podman)",
  restart:
    "redlib-mcp restart — restart the running backend to refetch a stale Reddit token.\n" +
    "  Use when reads start failing but the container is still up (a stale token doesn't crash it).\n" +
    "  Finds the backend on docker OR podman automatically.\n" +
    "  Flags: --port <n> (default 8080), --engine docker|podman",
  update:
    "redlib-mcp update — rebuild Redlib at the pinned commit; promote only if it verifies.\n" +
    "  Builds to a temp tag, checks it serves valid content on a temp port, then swaps :latest. Never\n" +
    "  tracks upstream HEAD unattended. Restart the container afterwards to pick up the new image.\n" +
    "  Flags: --port <n> (default 8080), --engine docker|podman",
  doctor:
    "redlib-mcp doctor — diagnose the backend and print how to fix each problem.\n" +
    "  Checks engine, daemon, container, HTTP health, end-to-end content, and image arch — and finds the\n" +
    "  backend on docker OR podman automatically.\n" +
    "  Flags: --port <n> (default 8080), --engine docker|podman",
  serve:
    "redlib-mcp serve — run the MCP server over stdio (this is what your MCP client launches).\n" +
    "  Env: REDLIB_URL (default http://127.0.0.1:8080). Set USE_HTTP=true to serve over loopback HTTP at\n" +
    "  PORT (default 3000); set REDLIB_MCP_TOKEN to require a bearer token.",
};

export function printHelp(): void {
  const h = (s: string) => paint("1", s); // bold section headers on a terminal
  say(
    `${h("redlib-mcp")} — read public Reddit through a private, self-hosted Redlib backend.\n` +
    "Run it yourself from a terminal, or let an AI agent drive it (Claude Code, Codex, Cursor, Gemini CLI).\n" +
    `\n${h("Commands")}\n` +
    "  setup      build + start the Redlib backend, then register the MCP\n" +
    "  restart    restart the backend (refetches a stale Reddit token)\n" +
    "  update     rebuild at the pinned commit; promote only if it verifies\n" +
    "  doctor     check engine, daemon, container + health, and print how to fix\n" +
    "  serve      run the MCP server over stdio (your client launches this)\n" +
    `\n${h("Getting started")}\n` +
    "  redlib-mcp setup     one command: build Redlib, bring it up on 127.0.0.1:8080, register the MCP\n" +
    "  redlib-mcp doctor    if anything looks off, this says what is wrong and how to fix it\n" +
    `\n${h("More")}\n` +
    "  redlib-mcp <command> --help    a command's flags in detail\n" +
    "  common flags: --engine docker|podman, --port <n>",
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

// Tiny hand-rolled flag parser (no arg-parsing dependency; keeps cold-start light).
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

// Shared `--port` parse for setup/restart/update/doctor. Absent flag -> DEFAULT_PORT; a bare `--port`
// (no value) is an ERROR, not a silent default; the value must be an integer in the valid TCP range.
export function parsePortFlag(flags: Record<string, string | boolean>): { port?: number; err?: string } {
  const raw = flags.port;
  if (raw === undefined) return { port: DEFAULT_PORT };
  if (typeof raw !== "string") return { err: "invalid --port value: flag given with no value (expected an integer 1-65535)" };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { err: `invalid --port value: ${raw} (expected an integer 1-65535)` };
  return { port };
}

// A free temp port adjacent to the main one for verify-before-swap; stays in the valid TCP range even
// when the main port is at the 65535 ceiling.
const candidatePort = (port: number): number => (port < 65535 ? port + 1 : port - 1);

// Parse `--engine docker|podman` (shared by setup + restart). Returns the preferred kind, {} for
// auto (docker-preferred), or a validation error. REDLIB_ENGINE (absolute path) still wins over this.
function parseEngineFlag(flags: Record<string, string | boolean>): { prefer?: "docker" | "podman"; err?: string } {
  const v = flags.engine;
  if (v === undefined) return {};
  if (v === "docker" || v === "podman") return { prefer: v };
  return { err: `invalid --engine value: ${String(v)} (expected: docker or podman)` };
}

// The MCP config entry `setup` writes. Immutable-versioned: an absolute installed bin if
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

function withSetupDefaults(deps?: Partial<SetupDeps>, prefer?: "docker" | "podman"): SetupDeps {
  return {
    detectEngine: () => detectEngine(undefined, undefined, undefined, prefer),
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
    withBuildLock: (fn) => withBuildLock(buildLockPath(), fn), // serialize concurrent builds
    resolveClientConfig: () => process.env.REDLIB_MCP_CLIENT_CONFIG || "",
    version: VERSION,
    ...deps,
  };
}

export async function cmdSetup(argv: string[], deps?: Partial<SetupDeps>): Promise<number> {
  const flags = parseFlags(argv);
  const pf = parsePortFlag(flags);
  if (pf.err) { say(pf.err); return 2; }
  const port = pf.port!;
  const host = flags["non-loopback"] ? "0.0.0.0" : "127.0.0.1";
  const eng = parseEngineFlag(flags);
  if (eng.err) { say(eng.err); return 2; }
  const d = withSetupDefaults(deps, eng.prefer);

  const engine = await d.detectEngine();
  say(`engine: ${engine.kind} (${engine.bin})`);
  if (!(await d.daemonReachable(engine))) { say("Docker/Podman daemon is not reachable — start it and re-run."); return 3; }
  if (host === "0.0.0.0") say("WARNING: --non-loopback exposes an UNAUTHENTICATED Redlib to your LAN (Docker bypasses host firewalls).");

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
    // Clean install: nothing to protect, bind :port directly, then verify.
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
    const v = await verifyBeforeSwap(engine, d, buildTag, candidatePort(port));
    if (v.decision === "promote") say("candidate verified and promoted to :latest. Restart the container to pick it up (or it will on next restart).");
    else if (v.decision === "discard") { say(`candidate DISCARDED (${v.lastKind}): ${v.detail}. Kept the current image.`); return 5; }
    else { say(`candidate inconclusive (${v.lastKind}): ${v.detail}. Kept the current image serving; candidate retained as ${buildTag}. Re-run \`redlib-mcp update\` later to re-verify.`); return 6; }
  }

  // Register the MCP into the caller's client config (atomic, diff + confirm).
  const cfgPath = d.resolveClientConfig();
  // No config path (env unset, no --client) -> backend is ready; print a paste-ready entry
  // instead of a bare "skipping". Render it FROM serverEntry so the printed block can never
  // drift from what the write path emits. (A Claude Code plugin user's MCP is already wired;
  // for them this is informational — the setup skill runs this path build-only.)
  if (!cfgPath) {
    const e = serverEntry(null, d.version);
    const entry = `  "redlib-mcp": ${JSON.stringify(e, null, 2).replace(/\n/g, "\n  ")}`;
    say("Backend is ready. To register the MCP with your client, add this to its mcpServers config:\n");
    say(entry + "\n");
    say(`  Claude Code:             claude mcp add redlib-mcp -- ${e.command} ${e.args.join(" ")}`);
    say("  Codex / Cursor / Gemini: add the block above to the client's MCP config file");
    say("  (or re-run with REDLIB_MCP_CLIENT_CONFIG=<path> to have setup write it for you)");
    return 0;
  }
  const before = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
  const entry = serverEntry(null, d.version); // the setup skill may pass an absolute bin; default exact-version npx
  const { text } = mergeServer(before, "redlib-mcp", entry);
  say(`\nMCP client config: ${cfgPath}\n${diffLines(before, text)}`);
  if (flags["print-only"]) { say("(--print-only: not writing the config.)"); return 0; }
  if (!flags.yes && !(await confirm("Write this MCP entry?"))) { say("Skipped config write. Re-run with --yes to apply."); return 0; }
  writeAtomic(cfgPath, text);
  say(`wrote ${cfgPath} (backup at ${cfgPath}.bak).`);
  return 0;
}

export interface UpdateDeps {
  locateBackend: (port: number, prefer?: "docker" | "podman") => Promise<{ engine: Engine; id: string | null }>;
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
// a transient defers (keep old, re-verify later). The live service is never disrupted.
export async function cmdUpdate(argv: string[], deps?: Partial<UpdateDeps>): Promise<number> {
  const flags = parseFlags(argv);
  const pf = parsePortFlag(flags);
  if (pf.err) { say(pf.err); return 2; }
  const port = pf.port!;
  const eng = parseEngineFlag(flags);
  if (eng.err) { say(eng.err); return 2; }
  const d: UpdateDeps = {
    locateBackend: (p, prefer) => locateBackend(p, prefer), daemonReachable: (e) => daemonReachable(e),
    cloneAtPin: (dir) => cloneAtPin(dir), buildImage: (dir, tag, e) => buildImage(dir, tag, e),
    runContainer: (e, o) => runContainer(e, o), stopContainer: (e, n) => stopContainer(e, n),
    waitHealthy: (u) => waitHealthy(u), tagImage: (e, f, t) => tagImage(e, f, t),
    removeImage: (e, t) => removeImage(e, t), verifyCandidate: (u) => verifyCandidate(u),
    withBuildLock: (fn) => withBuildLock(buildLockPath(), fn), // serialize concurrent builds
    ...deps,
  };
  // Build on the engine that HOSTS the backend (dual-engine machine) so the promoted :latest lands in the
  // store the running container actually reads — else the update would be invisible to it.
  const { engine } = await d.locateBackend(port, eng.prefer);
  if (!(await d.daemonReachable(engine))) { say("daemon not reachable; start it and re-run."); return 3; }

  const dir = cloneDir();
  const buildTag = BUILD_TAG;
  // Clone + build inside the build lock so a concurrent setup/update can't stack a second Rust compile.
  await d.withBuildLock(async () => {
    say(`rebuilding Redlib at pinned ${REDLIB_PIN.ref}@${REDLIB_PIN.sha.slice(0, 12)}`);
    await d.cloneAtPin(dir);
    await d.buildImage(dir, buildTag, engine);
  });

  const v = await verifyBeforeSwap(engine, d, buildTag, candidatePort(port));
  if (v.decision === "promote") { say("update verified and promoted to :latest. Restart the container to apply."); return 0; }
  if (v.decision === "discard") { say(`update DISCARDED (${v.lastKind}): ${v.detail}. Kept the current image.`); return 5; }
  // defer: inconclusive — verifyBeforeSwap kept the candidate image unpromoted; do NOT delete it (that
  // would waste the long build and break the re-verify path).
  say(`update inconclusive (${v.lastKind}): ${v.detail}. Kept the current image serving; the new candidate is retained as ${buildTag} — re-run \`redlib-mcp update\` later to re-verify. If it persists at this pin, upstream Redlib has no fix yet — not your setup.`);
  return 6;
}

export interface RestartDeps {
  locateBackend: (port: number, prefer?: "docker" | "podman") => Promise<{ engine: Engine; id: string | null }>;
  daemonReachable: (e: Engine) => Promise<boolean>;
  restartContainer: (e: Engine, nameOrId: string) => Promise<void>;
  waitHealthy: (url: string) => Promise<boolean>;
}

// Restart the running Redlib backend on :port. Purpose is TOKEN RECOVERY: when Reddit invalidates
// Redlib's spoofed OAuth token the container stays Up but 404s every read, and a restart refetches a
// fresh token. Restarts whatever holds the port (robust to container name). The agent self-heal skill
// calls this on UPSTREAM_TOKEN_STALE / REDLIB_DOWN.
export async function cmdRestart(argv: string[], deps?: Partial<RestartDeps>): Promise<number> {
  const flags = parseFlags(argv);
  const eng = parseEngineFlag(flags);
  if (eng.err) { say(eng.err); return 2; }
  const pf = parsePortFlag(flags);
  if (pf.err) { say(pf.err); return 2; }
  const port = pf.port!;
  const d: RestartDeps = {
    locateBackend: (p, prefer) => locateBackend(p, prefer),
    daemonReachable: (e) => daemonReachable(e),
    restartContainer: (e, n) => restartContainer(e, n),
    waitHealthy: (u) => waitHealthy(u),
    ...deps,
  };
  const { engine, id } = await d.locateBackend(port, eng.prefer);
  if (!id) {
    if (!(await d.daemonReachable(engine))) { say(`${engine.kind} daemon not reachable; start it and re-run.`); return 3; }
    say(`No Redlib backend is running on :${port} (checked docker + podman). Run \`redlib-mcp setup\` first.`); return 4;
  }
  say(`restarting the Redlib backend on :${port} (${engine.kind})...`);
  await d.restartContainer(engine, id);
  if (!(await d.waitHealthy(`http://127.0.0.1:${port}`))) { say("restarted but never became healthy; check the container logs."); return 4; }
  say("restarted and serving. A stale-token failure (reads 404ing) should now recover.");
  return 0;
}

export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0];
  // Per-command help must intercept BEFORE dispatch — else `setup --help` would start a real build.
  if (cmd && CMD_HELP[cmd] && (argv.includes("--help") || argv.includes("-h"))) { say(CMD_HELP[cmd]); return 0; }
  switch (cmd) {
    case "doctor": return cmdDoctor(argv.slice(1));
    case "setup": return cmdSetup(argv.slice(1));
    case "restart": return cmdRestart(argv.slice(1));
    case "update": return cmdUpdate(argv.slice(1));
    default: printHelp(); return cmd ? 2 : 0;
  }
}
