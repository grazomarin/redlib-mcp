// a single-process min-interval gate is enough for a local single-user tool;
// upgrade to a token bucket only if concurrency ever matters.
export class MinIntervalLimiter {
  private minMs: number;
  private next = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(minMs: number) { this.minMs = minMs; }
  acquire(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, this.next - now);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      this.next = Date.now() + this.minMs;
    });
    return this.chain;
  }
}
