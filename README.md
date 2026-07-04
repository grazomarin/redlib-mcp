# redlib-mcp

A private, self-hosted window into public Reddit for your AI agent — no account, no API key, one command, and it works in Claude Code, Codex, Cursor, and Gemini CLI.

`redlib-mcp` is a Model Context Protocol (MCP) server that lets an AI agent read public Reddit content through a self-hosted [Redlib](https://github.com/redlib-org/redlib) instance that you run and control. It ships three parts that work together:

- an **MCP server** (the reader — four tools),
- a **cross-platform CLI** (`redlib-mcp setup | update | doctor`) that installs and operates the Redlib backend for you, and
- a **setup skill** that drives the CLI from your agent.

Redlib itself is never bundled — the CLI clones and builds it from a pinned, reviewed upstream commit on your machine.

## Install

```bash
# 1. install the setup skill into your agent (Claude Code / Codex / Cursor / Gemini CLI)
npx skills add grazomarin/redlib-mcp
# 2. let your agent run it, or run the CLI directly:
npx -y redlib-mcp@1.0.0 setup
```

`setup` resolves docker or podman, clones + builds Redlib from source at the pinned reviewed commit, brings it up bound to `127.0.0.1:8080`, verifies it end to end, and (with your confirmation) registers the MCP into your client config. See `redlib-mcp doctor` if anything is off.

## Tools

| Tool | What it reads |
| --- | --- |
| `search_reddit` | search results (short keyword queries) |
| `get_subreddit_posts` | a subreddit's posts (hot/top/new/rising) + pagination |
| `get_post` | one post with threaded comments |
| `get_user_activity` | a user's recent submissions (source-vetting) |

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `REDLIB_URL` | `http://127.0.0.1:8080` | Your Redlib instance. Use `127.0.0.1`, not `localhost` (a dual-stack host may resolve `localhost` to `::1` and miss the loopback-only bind). |

The MCP talks only to your own loopback Redlib and never contacts reddit.com directly; it applies a conservative request rate cap. (A `robots.txt` respecter is not applicable to a self-hosted loopback backend you control.)

## Platform support

| OS | Status |
| --- | --- |
| Linux | Tested (reference platform) |
| macOS | Experimental until verified |
| Windows | Experimental until verified — help wanted |

The code targets all three (Node + Docker Desktop / Podman); the labels reflect test coverage, not intent.

## Your responsibility

You run and control the Redlib backend on your own machine. You are responsible for your use of it and for complying with the terms of the services you access. This project does not host any instance and ships no credentials.

## License and attribution

- This wrapper is **MIT** (see `LICENSE`), derived from [devthatdoes/redlib-mcp-server](https://github.com/Devthatdoes/redlib-mcp-server).
- [Redlib](https://github.com/redlib-org/redlib) is a separate program under **AGPL-3.0**, cloned and built on your machine — see `NOTICE`.
- Not affiliated with or endorsed by Reddit, Inc. "Reddit" is used only to describe the public content this tool reads.
