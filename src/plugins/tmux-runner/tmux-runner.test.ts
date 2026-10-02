import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { sessionRunnerContract } from "../session-runner.contract";
import { TmuxRunner } from "./tmux-runner";

// Each test's folder gets a tmux server of its own, so tests never see each
// other's sessions, or yours.
const used = new Set<string>();
const serverFor = (place: string) => {
  const server = `skelcrew-test-${createHash("sha256").update(place).digest("hex").slice(0, 12)}`;
  used.add(server);
  return server;
};

// tmux leaves a server's socket file behind when the server exits. These
// are removed, along with any server a failed test left running.
afterAll(() => {
  const folder = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`);
  for (const server of used) {
    tmux(server, "kill-server");
    rmSync(join(folder, server), { force: true });
  }
});

const tmux = (server: string, ...args: string[]) =>
  Bun.spawnSync(["tmux", "-L", server, ...args], { stdout: "pipe", stderr: "pipe" });

if (Bun.which("tmux") === null) {
  test.skip("the tmux runner's tests need tmux installed", () => {});
} else {
  // tmux keeps a session running when the daemon stops.
  sessionRunnerContract("tmux", (place) => new TmuxRunner({ server: serverFor(place) }), true);

  describe("the tmux runner", () => {
    test("can let the developer step into a session", () => {
      expect(new TmuxRunner({ server: serverFor("step-in") }).canStepIn).toBe(true);
    });

    // Skelcrew's sessions never show up in your own tmux.
    test("holds its sessions on a tmux server of its own", async () => {
      const server = serverFor(`own-${process.pid}`);
      const runner = new TmuxRunner({ server });
      try {
        await runner.start({
          name: "session-own",
          command: ["sh", "-c", "sleep 30"],
          cwd: "/",
          env: {},
          unset: [],
        });
        const listed = tmux(server, "list-sessions", "-F", "#{session_name}");
        expect(listed.stdout.toString().trim()).toBe("session-own");
      } finally {
        await runner.stop("session-own");
        await runner.close();
      }
    });
  });
}
