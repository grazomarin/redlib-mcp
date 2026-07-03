// Loopback-only by default; a strict allowlist so a poisoned env var can't turn the
// reader into an SSRF/shell vector. Non-loopback hosts require opt-in (REDLIB_ALLOW_REMOTE=1).
const ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function resolveRedlibUrl(raw: string | undefined = process.env.REDLIB_URL): string {
  if (!raw) return "http://127.0.0.1:8080";
  if (/[\s;'"`$(){}|&<>\\]/.test(raw)) throw new Error(`REDLIB_URL contains illegal characters: ${raw}`);
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`REDLIB_URL is not a valid URL: ${raw}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`REDLIB_URL scheme must be http/https: ${raw}`);
  if (!ALLOWED_HOSTS.has(u.hostname) && process.env.REDLIB_ALLOW_REMOTE !== "1") {
    throw new Error(`REDLIB_URL host ${u.hostname} is not loopback (set REDLIB_ALLOW_REMOTE=1 to override)`);
  }
  if (u.port && !/^\d+$/.test(u.port)) throw new Error(`REDLIB_URL port must be numeric: ${u.port}`);
  return u.origin;
}
