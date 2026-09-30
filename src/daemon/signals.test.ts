import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "../config/workflow";
import { TaskId } from "../core/ids";
import type { Input } from "../core/types";
import { Loop } from "../loop/loop";
import { EventStore } from "../store/store";
import { takeLock } from "./lock";
import { daemonPaths } from "./paths";
import { asRoot, cleanUp, openLine, throwawayRepo } from "./testing";

const dirs: string[] = [];
afterEach(() => cleanUp(dirs));

// `skelcrew serve` in a process of its own, as it runs for real.
async function serveInAnotherProcess(repo: string) {
  const script = `
    import { serveUntilSignalled } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
    const running = await serveUntilSignalled(process.env.REPO);
    if (!running.ok) { console.error(running.message); process.exit(1); }
    console.log("ready");
    await running.stopped;
    console.log("stopped");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, REPO: repo },
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain("ready");
  const rest = async () => {
    let said = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return said;
      said += new TextDecoder().decode(chunk.value);
    }
  };
  return { child, rest };
}

describe("stopping the daemon with a signal", () => {
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
  for (const signal of signals) {
    test(`${signal} closes connections, the store and the socket, and lets go of the lock`, async () => {
      const repo = throwawayRepo(dirs);
      const found = daemonPaths(repo);
      if (!found.ok) throw new Error(found.message);
      const { child, rest } = await serveInAnotherProcess(repo);
      const line = await openLine(found.paths.socket);

      child.kill(signal);
      expect(await rest()).toContain("stopped");
      expect(await child.exited).toBe(0);
      await line.closed;
      expect(existsSync(found.paths.socket)).toBe(false);
      // Let go of: another daemon can take the lock now.
      const next = takeLock(found.paths.repo);
      expect(next.ok).toBe(true);
      if (next.ok) next.lock.release();
      expect(existsSync(join(found.paths.folder, "daemon.pid"))).toBe(false);
    });
  }
});

// Leaves a repository as a daemon would that died after asking for a spec
// session, before the answer came back. The next daemon carries out that
// command again at start. Its database is then made read-only, so saving
// the answer fails and the daemon keeps trying.
function replyThatCantBeSaved(repo: string): void {
  const folder = join(repo, ".skelcrew");
  const parsed = parseWorkflow(readFileSync(join(folder, "workflow.yml"), "utf8"));
  if (!parsed.ok) throw new Error(parsed.reasons.join("\n"));
  const store = EventStore.open(join(folder, "skelcrew.db"));
  const opened = Loop.open(parsed.workflow.config, { carryOut: () => {} }, store);
  if (!opened.ok) throw new Error(opened.reason);
  const add: Input = {
    by: "human",
    type: "add",
    title: "CSV export",
    project: null,
    requestSpec: true,
  };
  opened.loop.send(TaskId.parse(1), add, 1);
  opened.loop.startWaiting(2);
  store.close();
  chmodSync(join(folder, "skelcrew.db"), 0o444);
}

// Found by review: without stopping the daemon's retries, a daemon
// retrying a reply ignored SIGTERM and never exited.
describe.skipIf(asRoot)("a daemon still trying to save a reply", () => {
  test("exits when stopped with a signal", async () => {
    const repo = throwawayRepo(dirs);
    replyThatCantBeSaved(repo);
    const { child, rest } = await serveInAnotherProcess(repo);
    await Bun.sleep(300);
    child.kill("SIGTERM");
    expect(await rest()).toContain("stopped");
    expect(await exitsWithin(child, 5_000)).toBe(0);
  }, 30_000);

  test("exits when it can't open its socket", async () => {
    const repo = throwawayRepo(dirs);
    replyThatCantBeSaved(repo);
    const folder = join(repo, ".skelcrew");
    chmodSync(folder, 0o555);
    try {
      const script = `
        import { serve } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
        const served = await serve(process.env.REPO);
        console.log(served.ok ? "started" : served.message);
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, REPO: repo },
        stdout: "pipe",
        stderr: "inherit",
      });
      expect(await exitsWithin(child, 5_000)).toBe(0);
      expect(await new Response(child.stdout).text()).toContain("couldn't be opened");
    } finally {
      chmodSync(folder, 0o755);
    }
  }, 30_000);
});

async function exitsWithin(child: Bun.Subprocess, ms: number): Promise<number | "still running"> {
  const late: Promise<"still running"> = Bun.sleep(ms).then(() => "still running");
  const exited = await Promise.race([child.exited, late]);
  if (exited === "still running") {
    child.kill("SIGKILL");
    await child.exited;
  }
  return exited;
}
