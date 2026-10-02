// The tests every session runner must pass. A runner's own test file calls
// sessionRunnerContract with a way to make one.
//
// They never start a real agent. The command is a short shell script that
// stands in for one: it writes down where it started and what was typed,
// and exits with code 3 when told "quit".

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEnd, SessionRunner, SessionStart } from "./session-runner";

// Like a real full-screen agent, it doesn't echo what it reads. So a
// terminal's answer to a question it asked, such as tmux's answer to
// "which terminal is this?", never shows on its screen.
const fakeAgent = `
stty -echo 2>/dev/null
echo "$PWD $SKELCREW_SESSION \${SKELCREW_FROM_PARENT:-none}" > started.txt
echo start >> starts.txt
echo ready
while IFS= read -r line; do
  echo "$line" >> typed.txt
  if [ "$line" = quit ]; then
    printf '\\033[1mbye\\033[0m\\n'
    # What Claude Code sent last when it stopped, in the first real run:
    # codes that query the terminal, set the keyboard, pick a character
    # set, and save and restore the cursor. Only text counts as a line.
    printf '\\033[>0q\\033[>4m\\033[<u\\033(B\\0337\\0338\\n'
    exit 3
  fi
done
`;

// An agent that finishes on its own after a second, with exit code 4.
const finishingAgent = `
echo start >> starts.txt
sleep 1
echo done
exit 4
`;

// An agent that ignores the polite signals to stop, as a busy or stuck one
// may. Only a forced stop ends it.
const stubbornAgent = `
trap '' TERM HUP INT
echo start >> starts.txt
while true; do sleep 1; done
`;

// Waits until the check passes, for at most five seconds.
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error("It didn't happen within five seconds.");
}

// Fails plainly if the promise takes longer than this, instead of letting
// a stuck runner hang the whole test run.
async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms.`)), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

// `make` gives a runner for one test's folder. Asked again for the same
// folder, it gives a runner over the same sessions, as a daemon restarted
// in that repository would get. `keepsSessions` says whether the runner
// keeps its sessions running when it closes.
export function sessionRunnerContract(
  name: string,
  make: (place: string) => SessionRunner,
  keepsSessions: boolean,
): void {
  let dirs: string[] = [];
  let runners: SessionRunner[] = [];
  // Every agent a test started is stopped, even when the test failed. A
  // runner that keeps its sessions would leave them running on close, so
  // each is stopped first.
  afterEach(async () => {
    const stopping = runners.map(async (runner) => {
      const open = await runner.running();
      for (const session of open.ok ? open.value : []) await runner.stop(session);
      await runner.close();
    });
    await within(10_000, "Closing the runner", Promise.all(stopping));
    dirs.forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
    dirs = [];
    runners = [];
  });

  // A runner, a folder with the fake agents in it, and every end it reports.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "skelcrew-runner-"));
    dirs.push(dir);
    writeFileSync(join(dir, "agent.sh"), fakeAgent);
    writeFileSync(join(dir, "stubborn.sh"), stubbornAgent);
    writeFileSync(join(dir, "finishing.sh"), finishingAgent);
    const runner = make(dir);
    runners.push(runner);
    const ends: { name: string; end: SessionEnd }[] = [];
    runner.onEnd((ended, end) => ends.push({ name: ended, end }));
    // A new runner over the same sessions, as after a daemon restart.
    const again = () => {
      const next = make(dir);
      runners.push(next);
      const nextEnds: { name: string; end: SessionEnd }[] = [];
      next.onEnd((ended, end) => nextEnds.push({ name: ended, end }));
      return { runner: next, ends: nextEnds };
    };
    const session = (sessionName: string): SessionStart => ({
      name: sessionName,
      command: ["sh", "agent.sh"],
      cwd: dir,
      env: { SKELCREW_SESSION: sessionName },
      unset: [],
    });
    return { dir, runner, ends, session, again };
  }

  describe(`${name}: start`, () => {
    test("runs the command in its folder, with the environment it adds", async () => {
      const { dir, runner, session } = setup();
      expect(await runner.start(session("session-1"))).toEqual({ ok: true, value: null });
      await eventually(() => read(join(dir, "started.txt")) !== "");
      const [folder, sessionName] = read(join(dir, "started.txt")).trim().split(" ");
      expect(folder !== undefined && existsSync(join(folder, "agent.sh"))).toBe(true);
      expect(sessionName).toBe("session-1");
    });

    // The daemon may run inside another agent's session, such as Claude
    // Code's, and the agent must not take that session's variables.
    test("leaves out the variables it is told to remove", async () => {
      const { dir, runner, session } = setup();
      process.env.SKELCREW_FROM_PARENT = "parent";
      try {
        await runner.start({ ...session("session-1"), unset: ["SKELCREW_FROM_PARENT"] });
        await eventually(() => read(join(dir, "started.txt")) !== "");
      } finally {
        delete process.env.SKELCREW_FROM_PARENT;
      }
      expect(read(join(dir, "started.txt")).trim().split(" ")[2]).toBe("none");
    });

    test("starts nothing when asked again while the session runs", async () => {
      const { dir, runner, session } = setup();
      await runner.start(session("session-1"));
      await eventually(() => read(join(dir, "starts.txt")) !== "");
      expect(await runner.start(session("session-1"))).toEqual({ ok: true, value: null });
      await Bun.sleep(300);
      expect(read(join(dir, "starts.txt"))).toBe("start\n");
    });

    test("lists the sessions still open, and not one that ended", async () => {
      const { runner, ends, session } = setup();
      await runner.start(session("session-1"));
      expect(await runner.running()).toEqual({ ok: true, value: ["session-1"] });
      await runner.type("session-1", "quit");
      await eventually(() => ends.length === 1);
      expect(await runner.running()).toEqual({ ok: true, value: [] });
    });
  });

  describe(`${name}: type`, () => {
    test("types the text into the session, then Enter", async () => {
      const { dir, runner, session } = setup();
      await runner.start(session("session-1"));
      await eventually(() => read(join(dir, "started.txt")) !== "");
      expect(await runner.type("session-1", "Use the CSV helper.")).toEqual({
        ok: true,
        value: null,
      });
      await eventually(() => read(join(dir, "typed.txt")) === "Use the CSV helper.\n");
    });

    test("is refused for a session that isn't running", async () => {
      const { runner } = setup();
      expect((await runner.type("session-9", "Hello")).ok).toBe(false);
    });
  });

  describe(`${name}: ends`, () => {
    test("reports an exit once, with its exit code and last line, without terminal codes", async () => {
      const { runner, ends, session } = setup();
      await runner.start(session("session-1"));
      await runner.type("session-1", "quit");
      await eventually(() => ends.length === 1);
      await Bun.sleep(200);
      expect(ends).toEqual([{ name: "session-1", end: { exitCode: 3, lastLine: "bye" } }]);
    });

    test("reports a stopped session's end, with no exit code", async () => {
      const { dir, runner, ends, session } = setup();
      await runner.start(session("session-1"));
      await eventually(() => read(join(dir, "started.txt")) !== "");
      expect(await runner.stop("session-1")).toEqual({ ok: true, value: null });
      await eventually(() => ends.length === 1);
      expect(ends[0]).toMatchObject({ name: "session-1", end: { exitCode: null } });
    });

    test("stopping a session that already ended does nothing", async () => {
      const { runner, ends, session } = setup();
      await runner.start(session("session-1"));
      await runner.type("session-1", "quit");
      await eventually(() => ends.length === 1);
      expect(await runner.stop("session-1")).toEqual({ ok: true, value: null });
      expect(await runner.stop("session-9")).toEqual({ ok: true, value: null });
      await Bun.sleep(200);
      expect(ends).toHaveLength(1);
    });

    // Found when a stuck fake agent kept a whole test run waiting.
    test("stops a session that ignores the polite signals, and reports its end", async () => {
      const { dir, runner, ends, session } = setup();
      await runner.start({ ...session("session-1"), command: ["sh", "stubborn.sh"] });
      await eventually(() => read(join(dir, "starts.txt")) !== "");
      await within(8_000, "Stopping", runner.stop("session-1"));
      expect(ends.map((ended) => ended.name)).toEqual(["session-1"]);
      expect(await runner.running()).toEqual({ ok: true, value: [] });
    });
  });

  describe(`${name}: close`, () => {
    test(keepsSessions ? "says it keeps its sessions" : "says it can't keep its sessions", () => {
      expect(setup().runner.keepsSessions).toBe(keepsSessions);
    });
  });

  if (keepsSessions) {
    describe(`${name}: after close`, () => {
      test("the session keeps running, and a new runner finds it and reports its end", async () => {
        const { dir, runner, ends, session, again } = setup();
        await runner.start(session("session-1"));
        await eventually(() => read(join(dir, "started.txt")) !== "");
        await runner.close();
        const next = again();
        expect(await next.runner.running()).toEqual({ ok: true, value: ["session-1"] });
        expect(await next.runner.type("session-1", "quit")).toEqual({ ok: true, value: null });
        await eventually(() => next.ends.length === 1);
        expect(next.ends).toEqual([{ name: "session-1", end: { exitCode: 3, lastLine: "bye" } }]);
        expect(ends).toEqual([]);
      });

      // An agent can finish while no daemon runs. The next one must still
      // hear how it ended.
      test("a session that ended while no runner watched is reported by the next one", async () => {
        const { dir, runner, session, again } = setup();
        await runner.start({ ...session("session-1"), command: ["sh", "finishing.sh"] });
        await eventually(() => read(join(dir, "starts.txt")) !== "");
        await runner.close();
        await Bun.sleep(1_500);
        const next = again();
        await eventually(() => next.ends.length === 1);
        expect(next.ends).toEqual([{ name: "session-1", end: { exitCode: 4, lastLine: "done" } }]);
        expect(await next.runner.running()).toEqual({ ok: true, value: [] });
      });
    });
    return;
  }

  describe(`${name}: close, for a runner that can't keep its sessions`, () => {
    test("close returns and ends every session, even one that ignores the signals", async () => {
      const { dir, runner, ends, session } = setup();
      await runner.start({ ...session("session-1"), command: ["sh", "stubborn.sh"] });
      await eventually(() => read(join(dir, "starts.txt")) !== "");
      await within(8_000, "Closing", runner.close());
      expect(ends.map((ended) => ended.name)).toEqual(["session-1"]);
    });

    test("close ends every session", async () => {
      const { runner, ends, session } = setup();
      await runner.start(session("session-1"));
      await runner.start({ ...session("session-2"), command: ["sh", "agent.sh"] });
      await runner.close();
      await eventually(() => ends.length === 2);
      expect(await runner.running()).toEqual({ ok: true, value: [] });
    });
  });
}
