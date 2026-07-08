#!/usr/bin/env node
// Single bin: dispatch server-vs-CLI. serve / piped-stdin -> MCP stdio server;
// setup|update|doctor -> CLI; bare TTY / unknown command -> the shared help owned by cli.ts.
const CLI_COMMANDS = new Set(["setup", "restart", "update", "doctor"]);

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
  // help (bare TTY or unknown command) — ONE help string, owned by cli.ts printHelp (on stderr, so
  // stdout stays clean for pipes).
  const { printHelp } = await import("./cli.js");
  printHelp();
  if (cmd) process.exitCode = 2; // a command was given but unrecognized; bare help stays exit 0
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
