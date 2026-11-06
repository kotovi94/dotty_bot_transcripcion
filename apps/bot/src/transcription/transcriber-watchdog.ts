export class TranscriberWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private failures = 0;
  private lastRecoveryAt = 0;

  constructor(
    private readonly healthUrl: string,
    private readonly recover: () => Promise<void> | void,
    private readonly intervalMs = 30_000,
    private readonly failureThreshold = 3,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(5_000) });
      const health = response.ok ? await response.json() as { status?: string } : null;
      if (health?.status === "ok") {
        this.failures = 0;
        return;
      }
      this.failures += 1;
    } catch {
      this.failures += 1;
    } finally {
      this.checking = false;
    }
    if (this.failures < this.failureThreshold || Date.now() - this.lastRecoveryAt < 120_000) return;
    this.lastRecoveryAt = Date.now();
    try { await this.recover(); }
    catch { /* Keep the bot running; the next check will retry after the cooldown. */ }
  }
}
