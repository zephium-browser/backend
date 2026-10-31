const cooldown = 3600_000;
const messages = {
  billing: {
    failing: "Zephium billing work requires operator attention",
    recovered: "Zephium billing work backlog has recovered",
  },
  contact: {
    failing: "Zephium billing contact update requires operator attention",
    recovered: "Zephium billing contact updates have recovered",
  },
  budget: {
    failing: "Zephium cloud spending is near a configured safety limit",
    recovered: "Zephium cloud spending is below configured safety warning thresholds",
  },
  worker: {
    failing: "Zephium worker tasks are failing repeatedly",
    recovered: "Zephium worker tasks have recovered",
  },
} as const;
type Category = keyof typeof messages;
type AlertState = { failing: boolean; notified: boolean; lastAlert: number | null };

/** Worker-local delivery state; unknown checks must be omitted, never treated as recovery. */
export class WorkerAlerts {
  private readonly states: Record<Category, AlertState> = {
    billing: { failing: false, notified: false, lastAlert: null },
    contact: { failing: false, notified: false, lastAlert: null },
    budget: { failing: false, notified: false, lastAlert: null },
    worker: { failing: false, notified: false, lastAlert: null },
  };

  constructor(
    private readonly notify: (message: string) => Promise<void>,
    private readonly onFailure: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  async scan(checks: Partial<Record<Category, boolean>>): Promise<void> {
    for (const category of Object.keys(messages) as Category[]) {
      const failing = checks[category];
      if (failing === undefined) continue;
      const state = this.states[category];
      if (failing !== state.failing) state.lastAlert = null;
      state.failing = failing;
      if (failing) {
        if (state.lastAlert !== null && this.now() - state.lastAlert < cooldown) continue;
      } else if (!state.notified) {
        continue;
      }
      try {
        await this.notify(messages[category][failing ? "failing" : "recovered"]);
        state.notified = failing;
        state.lastAlert = failing ? this.now() : null;
      } catch {
        // Keep delivery state unchanged so the next scan retries this category.
        this.onFailure();
      }
    }
  }
}
