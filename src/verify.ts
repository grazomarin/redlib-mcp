import * as cheerio from "cheerio";
import { RedlibBackend } from "./backend/redlib.js";
import { resolveRedlibUrl } from "./config.js";
import { assertRedlibContent, RedlibError } from "./errors.js";

export type SwapDecision = "promote" | "discard" | "defer";

// Smoke a candidate Redlib on its temp port and decide whether to promote it over the live image
// (spec §6.7). "Valid data" here is a REAL end-to-end parser check (spec §5.2 step 5), not just the
// #column_one shell: assertRedlibContent rejects error/info pages, AND the actual `.post` parser
// (the same $('.post') selector the MCP tools use, index.ts) must find at least one post on the
// known-populated smoke sub. A #column_one shell with ZERO posts is the stale-spoofing / parser-
// drift failure and must NOT promote. The result is disambiguated via Plan 1's typed enum (§6.3):
//   valid data (shell + >=1 parseable post) -> promote
//   persistent PARSE_ERROR (error page OR empty/unparseable listing) -> build/parse broken -> discard
//   persistent transient throttle/down/token-stale -> inconclusive -> defer (keep old)
// A single early failure does NOT decide anything — only the LAST retry is authoritative, so a
// warming container that recovers still promotes.
export async function verifyCandidate(
  probeUrl: string,
  opts: { path?: string; retries?: number; backoffMs?: number } = {},
  makeBackend: (url: string) => { fetch: (p: string) => Promise<string> } = (u) => new RedlibBackend(resolveRedlibUrl(u)),
): Promise<{ decision: SwapDecision; lastKind: string; detail: string }> {
  const path = opts.path ?? "/r/popular/hot"; // always-populated; 0 posts here means broken, not empty
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 1500;
  let lastKind = "UNKNOWN";

  for (let attempt = 0; attempt < retries; attempt++) {
    const isLast = attempt === retries - 1;
    try {
      const html = await makeBackend(probeUrl).fetch(path);
      assertRedlibContent(html); // throws RedlibError PARSE_ERROR on a 200 error/info page (shell check)
      const posts = cheerio.load(html)(".post").length; // the REAL parser selector (index.ts parsePostList)
      if (posts === 0) throw new RedlibError("PARSE_ERROR", "candidate served 0 parseable posts on a populated sub — stale spoofing or parser drift");
      return { decision: "promote", lastKind: "VALID", detail: `candidate served ${posts} parseable posts` };
    } catch (e: any) {
      lastKind = e?.kind ?? "PARSE_ERROR";
      if (isLast) {
        // Only a persistent PARSE_ERROR discards (broken build/parse). EVERY other terminal kind ->
        // defer. This is a deliberate safe default, slightly broader than spec §6.7's literal
        // "transient": a non-transient CONTENT_UNAVAILABLE on the smoke probe also defers rather
        // than discards, because defer never disrupts the live service and never throws away a
        // possibly-fine build over a one-off — a genuinely broken build surfaces PARSE_ERROR (or the
        // 0-posts guard above), which is the only thing that discards.
        return lastKind === "PARSE_ERROR"
          ? { decision: "discard", lastKind, detail: "persistent PARSE_ERROR — candidate build/parse is broken" }
          : { decision: "defer", lastKind, detail: `persistent non-parse failure (${lastKind}) — inconclusive, keeping current image` };
      }
      await new Promise((r) => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  return { decision: "defer", lastKind, detail: "inconclusive" };
}
