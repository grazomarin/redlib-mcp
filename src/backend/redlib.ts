import fetchFn from "node-fetch";
import { RedlibError, classifyRedlib } from "../errors.js";
import { resolveRedlibUrl } from "../config.js";
import type { Backend } from "./types.js";

// Resilient HTTP transport: timeout + bounded retry on timeout/429/5xx, HTTP-status check,
// and a content-type guard so a non-HTML block/error page never reaches cheerio.
// Throws a typed RedlibError on 4xx / non-HTML / final failure.
export class RedlibBackend implements Backend {
  constructor(
    private baseUrl = resolveRedlibUrl(),        // validated; throws on a bad REDLIB_URL
    private minAcquire: () => Promise<void> = async () => {},
    private timeoutMs = 15000,
  ) {}
  async fetch(path: string): Promise<string> {
    await this.minAcquire();
    const url = `${this.baseUrl}${path}`;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetchFn(url, { signal: ctrl.signal as any });
        clearTimeout(timer);
        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          if (!ct.includes("html")) throw new RedlibError("PARSE_ERROR", `Redlib returned non-HTML content-type "${ct}" for ${url} — is REDLIB_URL a Redlib instance?`);
          return await res.text();
        }
        const body = await res.text().catch(() => "");
        const kind = classifyRedlib(res.status, body) ?? "PARSE_ERROR";
        const err = new RedlibError(kind, `Redlib HTTP ${res.status} (${kind}) for ${url}`, res.status);
        if (err.retryable && attempt < 2) { lastErr = err; await sleep(400 * (attempt + 1)); continue; }
        throw err;
      } catch (e: any) {
        clearTimeout(timer);
        if (e instanceof RedlibError) throw e;
        if (e?.name === "AbortError") {
          lastErr = new RedlibError("REDLIB_DOWN", `Redlib request timed out after ${this.timeoutMs}ms for ${url}.`);
          if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
          throw lastErr;
        }
        if (e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET") throw new RedlibError("REDLIB_DOWN", `Redlib not reachable at ${url} (${e.code}) — is the container running?`);
        throw new RedlibError("PARSE_ERROR", `Redlib request failed for ${url}: ${e?.message || e}`);
      }
    }
    throw lastErr || new RedlibError("PARSE_ERROR", `Redlib request failed for ${url}`);
  }
}
