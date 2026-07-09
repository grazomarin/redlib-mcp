# redlib-mcp

A private, self-hosted window into public Reddit for your AI agent — no login, no tracking, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.

`redlib-mcp` is a Model Context Protocol (MCP) server that lets an AI agent read public Reddit content through a self-hosted [Redlib](https://github.com/redlib-org/redlib) instance that you run and control. It ships three parts that work together:

- an **MCP server** (the reader — four tools),
- a **cross-platform CLI** (`redlib-mcp setup | restart | update | doctor`) that installs and operates the Redlib backend, and
- a **setup skill** that drives the CLI from your agent.

Redlib itself is never bundled — the CLI clones and builds it from a pinned, reviewed upstream commit on your machine.

**Requirements:** Docker or Podman, plus Node.js (the MCP server and CLI run via `npx`; CI-tested on Node 20).

## Install

**Claude Code — install as a plugin** (skill + MCP server in one install):

```
/plugin marketplace add grazomarin/redlib-mcp
/plugin install redlib-mcp@redlib-mcp
```

The plugin installs **enabled**, so the `redlib` MCP server and the `setup-redlib` skill are wired
immediately. **The MCP tools do not work until you build the backend once** — enabling the plugin only
loads the wiring, not the Redlib instance the tools read from. Run:

```bash
redlib-mcp setup            # clones + builds the Redlib container; the `serve` MCP is already wired by the plugin
```

Until that first build finishes (a multi-minute compile), the `redlib` MCP shows connected but every
tool returns `REDLIB_DOWN`. Run `/reload-plugins` (or start a new session) once setup completes.

**Other clients (Codex / Cursor / Gemini CLI) — install the skill:**

```bash
# install the setup skill into your agent
npx skills add grazomarin/redlib-mcp
# then let your agent run it, or run the CLI directly:
npx -y redlib-mcp@1.0.1 setup
```

`setup` resolves docker or podman, clones + builds Redlib from source at the pinned reviewed commit,
brings it up bound to `127.0.0.1:8080`, verifies it end to end, and (with your confirmation) registers
the MCP into your client config. The plugin and the CLI both target port `8080` by default; if you run
`setup --port <n>`, set `REDLIB_URL` in the MCP entry yourself. See `redlib-mcp doctor` if anything is off.

## CLI

The `redlib-mcp` command is **usable directly by a human** from a terminal and **equally drivable by an AI agent** — the same commands either way. Run `redlib-mcp` for the command list, or `redlib-mcp <command> --help` for a command's flags.

| Command | What it does |
| --- | --- |
| `setup` | resolve docker/podman, build Redlib from the pinned commit, run it on `127.0.0.1:8080`, verify it, and register the MCP |
| `restart` | restart the backend to refetch a stale Reddit token (reads fail while the container stays up) — finds it on either engine |
| `update` | rebuild at the pinned commit; promote only if it verifies (never tracks upstream HEAD) |
| `doctor` | check engine, daemon, container, health + content, and print how to fix each |
| `serve` | run the MCP server over stdio (your client launches this) |

`doctor` prints a color-coded checklist with a fix on every failing line, so a person can self-diagnose without an agent:

```text
OK   engine: podman (/usr/bin/podman) — hosts the backend
OK   daemon: reachable
FAIL container on :8080: not running
     -> Run `redlib-mcp setup` to build and start the Redlib backend.
```

Commands run under **docker or podman**, chosen automatically (override with `--engine docker|podman`); `restart`, `doctor`, and `update` locate a running backend on either engine.

## Tools

| Tool | What it reads |
| --- | --- |
| `search_reddit` | search results (short keyword queries) |
| `get_subreddit_posts` | a subreddit's posts (hot/top/new/rising) + pagination |
| `get_post` | one post with threaded comments |
| `get_user_activity` | a user's recent submissions (source-vetting) |

## Usage

Ask your agent a real question in plain language — it searches, reads the relevant threads, and synthesizes what the community actually says. You don't name the tools; it picks them.

- **Niche recommendations** — "What CLI file manager do people on Reddit recommend, and why?" The agent runs `search_reddit`, opens the top threads with `get_post`, and returns the consensus picks (yazi, ranger, nnn, ...) with the trade-offs people cite — the community's answer, not one blog's.
- **Compare and weigh opinions** — "How do people compare Chakra UI and shadcn/ui, and which do they prefer for what?" It pulls discussions across subreddits and summarizes both camps: the developer-experience arguments, the "own your components" case, the migration gripes.
- **Deep-dive one thread** — "Summarize the discussion on this post: `<reddit-url>`" pulls `get_post` with its threaded comments for the agent to distill.
- **Vet a source** — "What has `u/<name>` posted recently?" runs `get_user_activity`, handy before you trust a hot take.

Everything is read-only and served from your loopback Redlib; the agent never contacts reddit.com directly.

## Limitations

- **Read-only, public content only.** Posts, comments, and user submissions — it cannot post, vote, message, or reach login-gated content.
- **Follows upstream Redlib.** Reddit periodically changes how its data is served, which can make reads start failing while the container stays up. `redlib-mcp restart` refetches and usually recovers; `redlib-mcp update` moves to a newer reviewed Redlib on a release. If it persists at the current pin, it is upstream, not your setup.
- **Paced by design.** A conservative request cap (`REDLIB_MIN_INTERVAL_MS`, default 300 ms) spaces requests to your backend.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `REDLIB_URL` | `http://127.0.0.1:8080` | Your Redlib instance. Use `127.0.0.1`, not `localhost` (a dual-stack host may resolve `localhost` to `::1` and miss the loopback-only bind). |
| `REDLIB_MIN_INTERVAL_MS` | `300` | Minimum spacing between requests to your backend. |
| `REDLIB_ALLOW_REMOTE` | (unset) | Set to `1` to allow a non-loopback `REDLIB_URL` (off by default). |
| `REDLIB_MCP_CLIENT_CONFIG` | (unset) | Path to the MCP client config file that `setup` registers the server into. |
| `REDLIB_ENGINE` | (auto) | Absolute path to a `docker`/`podman` binary to force the engine (a bare or relative name is rejected). |

The MCP talks only to your own loopback Redlib and never contacts reddit.com directly; it applies a conservative request rate cap.

**HTTP transport (advanced).** By default the server speaks MCP over stdio. Set `USE_HTTP=true` to serve over HTTP on `127.0.0.1` (loopback) at `PORT` (default `3000`); set `REDLIB_MCP_TOKEN` to require a bearer token (recommended — without it the endpoint is unauthenticated). DNS-rebinding protection is on.

**CLI exit codes** (`setup`/`restart`/`update`/`doctor`): `0` success · `2` bad flag/unknown command · `3` container engine/daemon unreachable · `4` container started but unhealthy · `5` verification failed (build discarded) · `6` verification inconclusive (kept current image).

## Platform support

| OS | Status |
| --- | --- |
| Linux | Tested (reference platform) |
| macOS | Experimental until verified |
| Windows | Experimental until verified — help wanted |

The code targets all three (Node + Docker Desktop / Podman); the labels reflect test coverage, not intent.

## Support

`redlib-mcp` is free and open source. If it saves you time, you can support its upkeep:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy_Me_a_Coffee-grazomarin-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/grazomarin)

## Your responsibility

You run and control the Redlib backend on your own machine. You are responsible for your use of it and for complying with the terms of the services you access. This project does not host any instance and ships no credentials.

## License and attribution

- This wrapper is **MIT** (see `LICENSE`), derived from [devthatdoes/redlib-mcp-server](https://github.com/Devthatdoes/redlib-mcp-server).
- [Redlib](https://github.com/redlib-org/redlib) is a separate program under **AGPL-3.0**, cloned and built on your machine — see `NOTICE`.
- Not affiliated with or endorsed by Reddit, Inc. "Reddit" is used only to describe the public content this tool reads.
