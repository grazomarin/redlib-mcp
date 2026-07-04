#!/usr/bin/env node
// Single bin: dispatch server-vs-CLI. serve / piped-stdin -> MCP stdio server;
// setup|update|doctor -> CLI (stub until Plan 2); bare TTY -> help.
const CLI_COMMANDS = new Set(["setup", "update", "doctor"]);

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "serve" || (!cmd && !process.stdin.isTTY)) {
    await import("./index.js"); // starts the server (side-effect); it owns stdout
    return;
  }
  if (cmd && CLI_COMMANDS.has(cmd)) {
    const { run } = await import("./cli.js");
    process.exitCode = await run(argv);
    return;
  }
  // help (bare TTY or unknown command) — stderr, so stdout stays clean for pipes.
  console.error(
    "redlib-mcp — read public Reddit via a self-hosted Redlib backend.\n" +
    "  redlib-mcp serve             run the MCP stdio server\n" +
    "  redlib-mcp setup             install/repair the Redlib backend (Plan 2)\n" +
    "  redlib-mcp update|doctor     manage/diagnose the backend (Plan 2)\n"
  );
  if (cmd) process.exitCode = 2; // a command was given but unrecognized; bare help stays exit 0
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
