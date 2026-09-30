import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "./lock";
import { daemonPaths } from "./paths";
import { cleanUp, openLine, throwawayRepo } from "./testing";

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
      const next = takeLock(found.paths.folder);
      expect(next.ok).toBe(true);
      if (next.ok) next.lock.release();
      expect(existsSync(join(found.paths.folder, "daemon.pid"))).toBe(false);
    });
  }
});
