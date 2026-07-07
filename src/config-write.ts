import { existsSync, readFileSync, copyFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";

export interface ServerEntry { command: string; args: string[]; env?: Record<string, string>; }

// Strip // line comments and /* */ block comments so a JSONC client config (Claude Code, VS Code)
// parses. Deliberately simple — string-literal awareness is more than this local tool needs;
// worst case, a `//` inside a JSON string value is mishandled and we throw, which fails SAFE
// (we refuse rather than clobber). ponytail: regex, upgrade to a real JSONC parser only if a real
// config trips it.
function stripJsonc(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
}

// Merge one server entry into an MCP client config's servers map WITHOUT touching siblings
// (spec §8). Returns the parsed object + pretty text; does not write. Throws if the existing text
// is non-empty and unparseable — we never overwrite a config we can't understand.
export function mergeServer(
  existingText: string,
  name: string,
  entry: ServerEntry,
  key = "mcpServers",
): { obj: any; text: string } {
  let obj: any = {};
  if (existingText.trim()) {
    // Parse the RAW text first — a valid JSON config must never go through the comment-stripping regex
    // (it is string-unaware and could mangle a "/* */" or "//" inside a string VALUE, then still parse,
    // silently corrupting a sibling). Only strip JSONC comments if the raw parse fails (a real .jsonc).
    try { obj = JSON.parse(existingText); }
    catch {
      try { obj = JSON.parse(stripJsonc(existingText)); }
      catch { throw new Error("Existing client config is not valid JSON/JSONC — refusing to overwrite it. Fix or move it, then re-run."); }
    }
    if (typeof obj !== "object" || obj === null) throw new Error("Existing client config is not a JSON object — refusing to overwrite.");
  }
  obj[key] = obj[key] && typeof obj[key] === "object" ? obj[key] : {};
  obj[key][name] = entry; // merge: replace only THIS server, never the whole map
  return { obj, text: JSON.stringify(obj, null, 2) + "\n" };
}

// Atomic, non-destructive write (spec §8): back up the prior file, write a temp + fsync, rename
// into place (atomic on the same filesystem).
export function writeAtomic(path: string, content: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

// A minimal unified-ish line diff for the confirmation prompt (no dependency).
export function diffLines(before: string, after: string): string {
  const a = before.split("\n"), b = after.split("\n");
  const out: string[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined && !b.includes(a[i])) out.push(`- ${a[i]}`);
    if (b[i] !== undefined && !a.includes(b[i])) out.push(`+ ${b[i]}`);
  }
  return out.join("\n") || "(no changes)";
}
