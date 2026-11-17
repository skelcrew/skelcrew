// A queue that keeps one kind of work, such as reviews, to a limit at once. The rest waits, and
// starts in order as places free up.

// Work waiting for a place: its order, and how to start it or turn it away.
type Waiting = { order: number; start: () => void };

// Holds the work running and waiting for one kind of work, so the daemon keeps one per kind.
export class Queue {
  private running = 0;
  // Kept sorted by order, lowest first.
  private waiting: Waiting[] = [];
  // The limit the latest work was given. Your config can change it while work waits.
  private limit = 1;

  // Runs `work` once fewer than `limit` run, and returns what it gives back. Waiting work starts
  // lowest `order` first, and among equal orders first come first served. The order is usually
  // when the work joined, so work brought back after a restart keeps its place by giving the
  // time it first joined. Rejects, without running the work, when `signal` cancels it before
  // it starts, so it never holds a place it doesn't use.
  run<T>(
    given: { limit: number; order: number; signal: AbortSignal },
    work: () => Promise<T>,
  ): Promise<T> {
    const { order, signal } = given;
    this.limit = given.limit;
    if (signal.aborted) return Promise.reject(new Error("cancelled while queued"));
    return new Promise<void>((resolve, reject) => {
      // Placed after every waiting entry of the same order or lower.
      const entry = { order, start: resolve };
      const at = this.waiting.findIndex((other) => other.order > order);
      this.waiting.splice(at === -1 ? this.waiting.length : at, 0, entry);
      // Cancelled while still waiting, it leaves the queue. Once started, the work itself
      // watches the signal.
      const cancel = () => {
        const index = this.waiting.indexOf(entry);
        if (index === -1) return;
        this.waiting.splice(index, 1);
        reject(new Error("cancelled while queued"));
      };
      signal.addEventListener("abort", cancel, { once: true });
      entry.start = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      this.startWaiting();
    }).then(async () => {
      // The place is taken as the work is started, so the place is given back however it ends.
      try {
        return await work();
      } finally {
        this.running--;
        this.startWaiting();
      }
    });
  }

  // Runs `work` at once, whatever the limit, and counts it among the work running until it ends.
  // For work that was already running before the queue knew of it, such as a test suite that
  // started before the daemon restarted: it must count, but can't be made to wait.
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
      this.startWaiting();
    }
  }

  // Returns whether work run with this limit now would wait, as every place is taken by work
  // running or waiting. So the caller can say it waits only when it does.
  full(limit: number): boolean {
    return this.running + this.waiting.length >= limit;
  }

  // Returns how much work waits for a place, so work that joins now can say where it stands.
  inLine(): number {
    return this.waiting.length;
  }

  // Starts waiting work, first in order, while the limit leaves places free.
  private startWaiting(): void {
    while (this.running < this.limit) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running++;
      next.start();
    }
  }
}
