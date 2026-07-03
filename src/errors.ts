export type RedlibErrorKind =
  | "RATE_LIMITED"
  | "UPSTREAM_TOKEN_STALE"
  | "REDLIB_DOWN"
  | "CONTENT_UNAVAILABLE"
  | "PARSE_ERROR";

const RETRYABLE: ReadonlySet<RedlibErrorKind> = new Set([
  "RATE_LIMITED",
  "UPSTREAM_TOKEN_STALE",
  "REDLIB_DOWN",
]);

export class RedlibError extends Error {
  kind: RedlibErrorKind;
  status?: number;
  retryable: boolean;
  constructor(kind: RedlibErrorKind, message: string, status?: number) {
    super(message);
    this.name = "RedlibError";
    this.kind = kind;
    this.status = status;
    this.retryable = RETRYABLE.has(kind);
  }
}

// Body markers captured from the built Redlib image (spec §6.3), NOT authored by hand
// long-term — the golden-file test regenerates them per pin bump. Order matters:
// most-specific first.
const BODY_MARKERS: ReadonlyArray<[RegExp, RedlibErrorKind]> = [
  [/too many requests|rate limit/i, "RATE_LIMITED"],
  [/oauth token (has )?expired/i, "UPSTREAM_TOKEN_STALE"],
  [/reddit is having issues|status\.reddit\.com|internal server error/i, "REDLIB_DOWN"],
];

// Classify a Redlib HTTP RESPONSE. Redlib's generic error() returns 404 regardless of
// cause (cause only in body); info()=200; nsfw_landing()=403. Returns null for a 200 the
// caller must data-shape-check (unparseable 200 -> PARSE_ERROR at the call site).
export function classifyRedlib(status: number, bodyText: string): RedlibErrorKind | null {
  if (status === 200) return null;
  if (status >= 500) return "REDLIB_DOWN";
  if (status === 403) return "CONTENT_UNAVAILABLE"; // NSFW / gated landing
  if (status === 404) {
    for (const [re, kind] of BODY_MARKERS) if (re.test(bodyText)) return kind;
    return "CONTENT_UNAVAILABLE"; // generic 404 error page: gone/removed/not-found
  }
  return "PARSE_ERROR";
}
