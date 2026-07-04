---
name: setup-redlib
description: A private, self-hosted window into public Reddit for your AI agent — no account, no API key, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.
---

# Set up redlib-mcp

Use this when the user wants their agent to read public Reddit content through a private,
self-hosted Redlib backend. This skill installs and heals that backend via the `redlib-mcp` CLI —
`redlib-mcp setup` to install it, `redlib-mcp doctor` to diagnose failures.

## Setup

1. Run the installer (it resolves docker or podman, builds Redlib from a pinned reviewed commit, binds
   it to `127.0.0.1:8080`, and verifies it end to end):

   ```bash
   npx -y redlib-mcp@1.0.0 setup
   ```

   Set `REDLIB_MCP_CLIENT_CONFIG=<path>` (the env var the CLI reads) to THIS agent's own client
   config file so `setup` can register the MCP into it. `setup` prints the diff and asks before
   writing; approve it. (Without a config path, `setup` still succeeds — it just skips registration,
   and you add the server entry yourself.)

2. Confirm the server is registered in your client config, pointing at `redlib-mcp@1.0.0 serve`
   (an exact version — never a floating `npx redlib-mcp`).

## Self-heal (gated — never rebuild-storm)

If an MCP tool call fails, do NOT reinstall blindly. Run `redlib-mcp doctor`, read the typed error
kind, and take the matching action, then retry once:

- `RATE_LIMITED` — Reddit throttling. Wait and retry; never rebuild.
- `UPSTREAM_TOKEN_STALE` — restart the container once (`redlib-mcp doctor` shows how), then retry.
- `REDLIB_DOWN` — the backend is not serving. Restart the container; if still down, surface it.
- `CONTENT_UNAVAILABLE` — the post/user is gone or gated. Report to the user; not a setup problem.
- `PARSE_ERROR` — persistent parse failure. Usually **terminal at the current pin** (spec §6.3):
  `redlib-mcp update` only helps if a NEWER `redlib-mcp` (with a moved pin) is installed — rebuilding
  at the SAME pinned commit cannot fix drift (verify-before-swap just discards the identical build).
  So: if a newer `redlib-mcp` is available, `update` and retry; otherwise upstream Redlib has no fix
  yet — this is not your setup; tell the user to wait/watch redlib-org.

The CLI never rebuilds to upstream HEAD unattended; updates only move the pin on a redlib-mcp release.
