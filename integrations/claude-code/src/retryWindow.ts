/** Bounded suppression for unacknowledged notification retries. */
export class RetryWindow {
  private readonly lastAttempts = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(intervalMs: number, now: () => number = Date.now) {
    this.intervalMs = intervalMs;
    this.now = now;
  }

  shouldAttempt(id: string): boolean {
    const lastAttempt = this.lastAttempts.get(id);
    return lastAttempt === undefined || this.now() - lastAttempt >= this.intervalMs;
  }

  recordAttempt(id: string): void {
    this.lastAttempts.set(id, this.now());
  }

  clear(id: string): void {
    this.lastAttempts.delete(id);
  }
}
