---
name: setup-redlib
description: A private, self-hosted window into public Reddit for your AI agent — no login, no tracking, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.
---

# Set up redlib-mcp

Use this when the user wants their agent to read public Reddit content through a private,
self-hosted Redlib backend. This skill installs and heals that backend via the `redlib-mcp` CLI —
`redlib-mcp setup` to install it, `redlib-mcp doctor` to diagnose failures.

## Setup

1. Run the installer (it resolves docker or podman, builds Redlib from a pinned reviewed commit, binds
   it to `127.0.0.1:8080`, and verifies it end to end):

   ```bash
   REDLIB_MCP_CLIENT_CONFIG=<this agent's client config path> npx -y redlib-mcp@1.0.0 setup --yes
   ```

   Set `REDLIB_MCP_CLIENT_CONFIG` (the env var the CLI reads) to THIS agent's own client config file
   so `setup` registers the MCP into it. Pass `--yes` so the write happens without a prompt: an agent
   has no TTY, and WITHOUT `--yes` setup prints the diff and then SKIPS the write (it still exits 0, so
   nothing signals the skip). Use `--print-only` first if you want to preview the diff without writing.
   (Without a config path, `setup` still succeeds — it just skips registration and you add the server
   entry yourself.)

2. Confirm the server is registered in your client config, pointing at `redlib-mcp@1.0.0 serve`
   (an exact version — never a floating `npx redlib-mcp`).

## Self-heal (gated — never rebuild-storm)

If an MCP tool call fails, do NOT reinstall blindly. Run `redlib-mcp doctor`, read the typed error
kind, and take the matching action, then retry once:

- `RATE_LIMITED` — Reddit throttling. Wait and retry; never rebuild.
- `UPSTREAM_TOKEN_STALE` — the Reddit token went stale. Run `redlib-mcp restart` (refetches a fresh token), then retry. Never rebuild.
- `REDLIB_DOWN` — the backend is not serving. Run `redlib-mcp restart`; if still down after that, surface it.
- `BAD_INPUT` — your tool arguments were malformed (an unparseable url, or a missing subreddit/postId). Fix the arguments and retry. This is NOT a backend problem — never rebuild, restart, or update.
- `CONTENT_UNAVAILABLE` — the post/user is gone or gated. Report to the user; not a setup problem.
- `PARSE_ERROR` — persistent parse failure. Usually **terminal at the current pin** (spec §6.3):
  `redlib-mcp update` only helps if a NEWER `redlib-mcp` (with a moved pin) is installed — rebuilding
  at the SAME pinned commit cannot fix drift (verify-before-swap just discards the identical build).
  So: if a newer `redlib-mcp` is available, `update` and retry; otherwise upstream Redlib has no fix
  yet — this is not your setup; tell the user to wait/watch redlib-org.

The CLI never rebuilds to upstream HEAD unattended; updates only move the pin on a redlib-mcp release.
