// The pinned upstream Redlib commit for THIS redlib-mcp version. An immutable reviewed SHA
// (spec §6.1, resolved 2026-07-03) — a recent `main` commit, NOT a tag: Redlib's only tagged
// release (v0.36.0, 2025-03) ships stale Reddit-OAuth spoofing and cannot read. Bumped ONLY on a
// redlib-mcp release via the §10 checklist (sanity scan + cargo audit/trivy + fixture regen +
// e2e smoke). The runtime NEVER advances this to HEAD unattended.
export const REDLIB_PIN = {
  ref: "main",
  sha: "a4d36e954cf1bd64f209cd8868c5a29edc81b374",
  repo: "https://github.com/redlib-org/redlib.git",
} as const;
