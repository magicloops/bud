import { AppKeys } from "./app-keys.js";

/** Expiry stays service-owned when all clients and app backends are closed. */
export class AppKeyMaintenance {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly repository: Pick<AppKeys, "expireNext"> = new AppKeys(),
    private readonly reportError: () => void = () => {}, private readonly intervalMs = 1000) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (this.stopped || this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.poll().finally(() => { this.active = undefined; this.schedule(this.intervalMs); });
    }, delay);
    this.timer.unref();
  }
  private async poll() {
    try {
      for (let count = 0; count < 25 && !this.stopped; count++) if (!await this.repository.expireNext()) break;
    } catch { this.reportError(); }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
