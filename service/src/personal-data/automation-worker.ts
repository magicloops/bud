import { AutomationMatcher } from "./automation-matcher.js";
import { AutomationAdmission } from "./automation-admission.js";
import { BootstrapAdmission } from "./bootstrap-admission.js";

type Work = { matchNext(): Promise<boolean>; admitLive(): Promise<boolean>; admitBootstrap(): Promise<boolean> };

/** Serial bounded polling; persistence, not timers, owns work and retry state. */
export class AutomationWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly work: Work = {
    matchNext: () => new AutomationMatcher().matchNext(),
    admitLive: () => new AutomationAdmission().admitNext(),
    admitBootstrap: () => new BootstrapAdmission().admitNext(),
  }, private readonly reportError: (code: string) => void = () => {},
  private readonly rounds = 25, private readonly intervalMs = 1000) {
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100 || !Number.isInteger(intervalMs) || intervalMs < 1)
      throw new Error("invalid_automation_worker_settings");
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.stopped || this.timer || this.active) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.poll().finally(() => {
        this.active = undefined;
        this.schedule(this.intervalMs);
      });
    }, delay);
    this.timer.unref();
  }

  private async poll() {
    for (let round = 0; round < this.rounds && !this.stopped; round++) {
      let progressed = false;
      // A failing source does not starve the other admission queues. Each
      // operation owns a transaction and can be retried without duplicating work.
      for (const [kind, operation] of Object.entries(this.work)) {
        if (this.stopped) break;
        try { progressed = await operation() || progressed; }
        catch { this.reportError(`automation_${kind}_failed`); }
      }
      if (!progressed) break;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
