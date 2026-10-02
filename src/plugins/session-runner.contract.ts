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

const fakeAgent = `
echo "$PWD $SKELCREW_SESSION \${SKELCREW_FROM_PARENT:-none}" > started.txt
echo start >> starts.txt
echo ready
while IFS= read -r line; do
  echo "$line" >> typed.txt
  if [ "$line" = quit ]; then
    printf '\\033[1mbye\\033[0m\\n'
    exit 3
  fi
done
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

export function sessionRunnerContract(name: string, make: () => SessionRunner): void {
  let dirs: string[] = [];
  let runners: SessionRunner[] = [];
  // Every agent a test started is stopped, even when the test failed.
  afterEach(async () => {
    const closing = runners.map((runner) => runner.close());
    dirs.forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
    dirs = [];
    runners = [];
    await within(10_000, "Closing the runner", Promise.all(closing));
  });

  // A runner, a folder with the fake agents in it, and every end it reports.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "skelcrew-runner-"));
    dirs.push(dir);
    writeFileSync(join(dir, "agent.sh"), fakeAgent);
    writeFileSync(join(dir, "stubborn.sh"), stubbornAgent);
    const runner = make();
    runners.push(runner);
    const ends: { name: string; end: SessionEnd }[] = [];
    runner.onEnd((ended, end) => ends.push({ name: ended, end }));
    const session = (sessionName: string): SessionStart => ({
      name: sessionName,
      command: ["sh", "agent.sh"],
      cwd: dir,
      env: { SKELCREW_SESSION: sessionName },
      unset: [],
    });
    return { dir, runner, ends, session };
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
