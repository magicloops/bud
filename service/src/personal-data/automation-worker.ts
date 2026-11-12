import { AutomationMatcher } from "./automation-matcher.js";
import { AutomationAdmission } from "./automation-admission.js";
import { BootstrapAdmission } from "./bootstrap-admission.js";
import { AutomationScheduler } from "./automation-scheduler.js";
import { PlacePresence } from "./place-presence.js";

type Work = { settleDepartures?(): Promise<boolean>; matchNext(): Promise<boolean>; scheduleDue?(): Promise<boolean>;
  admitLive(): Promise<boolean>; admitBootstrap(): Promise<boolean> };

const MATCH_BATCH = 100;

function defaultWork(): Work {
  const scheduler = new AutomationScheduler();
  return {
    // Region exits that stayed out past the settle window publish before matching.
    settleDepartures: () => new PlacePresence().settleDepartures(),
    matchNext: () => new AutomationMatcher().matchNext(),
    scheduleDue: () => scheduler.scheduleDue(),
    admitLive: () => new AutomationAdmission().admitNext(),
    admitBootstrap: () => new BootstrapAdmission().admitNext(),
  };
}

/** Serial bounded polling; persistence, not timers, owns work and retry state. */
export class AutomationWorker {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
  constructor(private readonly work: Work = defaultWork(), private readonly reportError: (code: string) => void = () => {},
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
        try { progressed = await (kind === "matchNext" ? this.matchPending() : operation()) || progressed; }
        catch { this.reportError(`automation_${kind}_failed`); }
      }
      if (!progressed) break;
    }
  }

  /** Matches everything already published before anything is admitted, so events published
   * together (a reading's departure and arrival, or a visit's departure and end) are pending
   * together and form one run. Bounded, so a large contact import still lets admission run. */
  private async matchPending() {
    let matched = false;
    for (let count = 0; count < MATCH_BATCH && !this.stopped && await this.work.matchNext(); count++) matched = true;
    return matched;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
