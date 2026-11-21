// The session supervisor: one for each agent, a builder or a lead, owning its starts, ends,
// stops and removals in turn, and reaching its session through the host the caller gives.

export type SessionHost = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  runs: () => Promise<boolean>;
  clear: () => Promise<void>;
  gone?: () => string | null;
  hold?: <T>(work: () => Promise<T>) => Promise<T>;
  retry?: (error: unknown) => void;
};

type AgentHost = Omit<SessionHost, "stop" | "hold">;

export type Restarted = "refused" | "stays ended" | { gone: string | null } | { failed: unknown };

const hostRetryMs = 5000;

class Supervisor {
  #turn: Promise<void> = Promise.resolve();
  #asked = 0;
  #seen = false;
  #stopping: Promise<void> | null = null;
  #removalEnded: Promise<void> | null = null;

  state() {
    return {
      seenRunning: this.#seen,
      stopping: this.#stopping !== null,
      removing: this.#removalEnded !== null,
      busy: this.#asked > 0,
    };
  }

  #inTurn<T>(work: (earlier: Promise<void>) => Promise<T>): Promise<T> {
    const earlier = this.#turn;
    this.#asked++;
    const done = work(earlier).finally(() => this.#asked--);
    this.#turn = done.then(
      () => {},
      () => {},
    );
    return done;
  }

  async #start(host: Pick<SessionHost, "start">): Promise<void> {
    this.#seen = false;
    await host.start();
    this.#seen = true;
  }

  start(host: Pick<SessionHost, "start">): Promise<void> {
    return this.#inTurn(async (earlier) => {
      await earlier;
      await this.#start(host);
    });
  }

  end(host: Pick<SessionHost, "stop" | "hold">): Promise<void> {
    const hold = host.hold ?? ((work) => work());
    return this.#inTurn((earlier) =>
      hold(async () => {
        await earlier;
        await host.stop();
        this.#seen = false;
      }),
    );
  }

  stop(work: () => Promise<void>): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const stop = work().finally(() => {
      if (this.#stopping === stop) this.#stopping = null;
    });
    this.#stopping = stop;
    return stop;
  }

  async remove(work: () => Promise<void>): Promise<void> {
    if (this.#removalEnded) throw new Error("a removal is under way already");
    const ended = Promise.withResolvers<void>();
    this.#removalEnded = ended.promise;
    try {
      await work();
    } finally {
      this.#removalEnded = null;
      ended.resolve();
    }
  }

  removalEnded(): Promise<void> {
    return this.#removalEnded ?? Promise.resolve();
  }

  async bringBack(host: AgentHost, wanted: () => boolean): Promise<string | null> {
    const gone = host.gone?.() ?? null;
    if (gone !== null) return gone;
    const ours = () => this.#stopping === null && this.#removalEnded === null && wanted();
    let told = false;
    while (true) {
      const unreachable = await this.#inTurn(async (earlier) => {
        await earlier;
        try {
          if (await host.runs()) {
            this.#seen = true;
            return null;
          }
          await host.clear();
        } catch (error) {
          return { error };
        }
        if (!ours()) throw new Error("it was stopped or ended while it was being brought back");
        await this.#start(host);
        return null;
      });
      if (unreachable === null) return null;
      if (host.retry === undefined || !wanted()) throw unreachable.error;
      if (!told) host.retry(unreachable.error);
      told = true;
      await Bun.sleep(hostRetryMs);
    }
  }

  async restart(host: AgentHost, wanted: () => boolean): Promise<Restarted> {
    const ours = () => this.#stopping === null && this.#removalEnded === null && wanted();
    if (!ours()) return "refused";
    await this.#inTurn(async (earlier) => {
      await earlier;
      await host.clear();
      this.#seen = false;
    });
    if (!ours()) return "stays ended";
    return this.bringBack(host, wanted).then(
      (gone) => ({ gone }),
      (failed: unknown) => ({ failed }),
    );
  }

  async lookForEnd(host: Pick<SessionHost, "runs">, wanted: () => boolean): Promise<boolean> {
    const ours = () => this.#stopping === null && this.#removalEnded === null && wanted();
    if (!ours()) return false;
    const ended = await this.#inTurn(async (earlier) => {
      await earlier;
      if (!ours()) return false;
      if (await host.runs()) {
        this.#seen = true;
        return false;
      }
      return this.#seen;
    }).catch(() => false);
    return ended && ours();
  }
}

const supervisors = new Map<string, Supervisor>();

export function supervisor(agent: string): Supervisor {
  const found = supervisors.get(agent);
  if (found) return found;
  const made = new Supervisor();
  supervisors.set(agent, made);
  return made;
}
