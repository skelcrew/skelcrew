// The check that a test run leaves nothing running, tried on small test files of its own: one
// that cleans up, one that doesn't, and a run killed part way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { until as wait } from "./harness.ts";

const preload = join(import.meta.dir, "leftovers.ts");
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "skel-leftovers-test-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Starts a run of the given test files, with the check, as bun test would start one. Handed
// this run's TMPDIR, its folder goes with this run's, even if this run is killed. Several
// files run in parallel, as `bun run check` runs them, on one worker, so that worker runs
// them one after another in the same process.
function run(...bodies: string[]) {
  const files = bodies.map((body, i) => {
    writeFileSync(join(home, `fixture${i}.test.ts`), body);
    return `./fixture${i}.test.ts`;
  });
  const parallel = files.length > 1 ? ["--parallel=1"] : [];
  return Bun.spawn([process.execPath, "test", ...parallel, "--preload", preload, ...files], {
    cwd: home,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Returns whether a process is running. One that exited but wasn't reaped has no command.
function running(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).length > 0;
  } catch {
    return false;
  }
}

// Says what it waited for, if it gives up. Each test starts a test run of its own, and the
// sweep after it, which take many seconds on a busy machine, so the wait is generous.
const until = (done: () => boolean, what: string) =>
  wait(done, { timeout: 30_000, what: () => what });

// Waits until the sweeps a run started have ended. They clear up after the run, and on a
// busy machine one can still be at it seconds after the run, when this file's own check
// would count it as a process the test left running. A sweep is known by its folder, which
// lands in this run's: a parallel run's sweeps belong to its workers, not to the run itself.
const swept = () =>
  until(() => {
    const sweep = join(import.meta.dir, "sweep.ts");
    const inside = `${process.env.TMPDIR ?? tmpdir()}/`;
    return !readdirSync("/proc").some((pid) => {
      const args = /^\d+$/.test(pid) ? command(pid) : [];
      return args[1] === sweep && (args[3] ?? "").startsWith(inside);
    });
  }, "the run's sweeps to end");

// Returns the arguments a process was started with, or none once it has gone.
function command(pid: string): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  } catch {
    return [];
  }
}

// Starts a process that outlives what started it, as a daemon's child can, and notes its ID.
// With no env of its own, nothing in it names the run, so only its parent tells it apart.
const stray = (file: string, env = "") => `Bun.spawn(
    ["sh", "-c", "echo $$ > ${file}; exec sleep 60"],
    { detached: true, ${env} stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  ).unref();
  while (!(await Bun.file("${file}").exists())) await Bun.sleep(10);`;

// The check reads /proc, so it only runs on Linux, and on a Mac there is nothing to try.
describe.skipIf(process.platform !== "linux")("the check", () => {
  test("a test that ends what it started passes", async () => {
    const proc = run(`import { test } from "bun:test";
test("clean", async () => {
  await Bun.spawn(["sh", "-c", "exit 0"]).exited;
});`);
    const err = await new Response(proc.stderr).text();
    expect(err).toContain("1 pass");
    expect(await proc.exited).toBe(0);
    await swept();
  });

  test("a run in a folder that goes is still cleared up after", async () => {
    const outer = process.env.TMPDIR ?? tmpdir();
    const before = readdirSync(outer).filter((name) => name.startsWith("skel-run-"));
    const proc = run(`import { test } from "bun:test";
test("clean", () => {});`);
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
    const left = () =>
      readdirSync(outer).filter((name) => name.startsWith("skel-run-") && !before.includes(name));
    await until(() => left().length === 0, "the run's folder to go");
    await swept();
  });

  test("a test that leaves a process running fails by name, and the process is ended", async () => {
    const proc = run(`import { test } from "bun:test";
test("leaky", async () => {
  ${stray("stray")}
});`);
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("sleep 60");
    expect(err).toContain("(fail) leaky");
    const pid = Number(readFileSync(join(home, "stray"), "utf8"));
    await until(() => !running(pid), "the stray process to end");
    await swept();
  }, 60_000);

  test("files a parallel worker runs one after another pass when each ends what it started", async () => {
    const clean = `import { test } from "bun:test";
test("clean", async () => {
  await Bun.spawn(["sh", "-c", "exit 0"]).exited;
});`;
    const proc = run(clean, clean, clean);
    const err = await new Response(proc.stderr).text();
    expect(err).toContain("3 pass");
    expect(await proc.exited).toBe(0);
    await swept();
  }, 60_000);

  test("a leaky file on a parallel worker fails by name, and the process is ended", async () => {
    const proc = run(
      `import { test } from "bun:test";
test("clean", () => {});`,
      `import { test } from "bun:test";
test("leaky", async () => {
  ${stray("stray")}
});`,
    );
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("sleep 60");
    expect(err).toContain("(fail) leaky");
    expect(err).toContain("1 pass");
    const pid = Number(readFileSync(join(home, "stray"), "utf8"));
    await until(() => !running(pid), "the stray process to end");
    await swept();
  }, 60_000);

  test("a parallel worker killed part way leaves no process", async () => {
    const proc = run(
      `import { test } from "bun:test";
test("clean", () => {});`,
      `import { test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("killed", async () => {
  ${stray("unnamed")}
  // Two looks by the sweep, as the first may have begun before this process started.
  const looked = join(process.env.TMPDIR ?? "", "looked");
  for (const look of [1, 2]) {
    rmSync(looked, { force: true });
    while (!existsSync(looked)) await Bun.sleep(10);
  }
  writeFileSync("worker", String(process.pid));
  await Bun.sleep(60_000);
}, 70_000);`,
    );
    const worker = join(home, "worker");
    await until(
      () => existsSync(worker) && readFileSync(worker, "utf8") !== "",
      "the run to start",
    );
    const pid = Number(readFileSync(join(home, "unnamed"), "utf8"));
    expect(running(pid)).toBe(true);
    process.kill(Number(readFileSync(worker, "utf8")), "SIGKILL");
    await proc.exited;
    await until(() => !running(pid), "the stray process to end");
    await swept();
  }, 60_000);

  test("a process whose parent has gone is found, though nothing in it names the run", async () => {
    const proc = run(`import { test } from "bun:test";
test("leaky", async () => {
  await Bun.spawn(["sh", "-c", "sh -c 'echo $$ > orphan; exec sleep 60' & wait \\$! & exit"]).exited;
  while (!(await Bun.file("orphan").exists())) await Bun.sleep(10);
});`);
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(err).toContain("sleep 60");
    const pid = Number(readFileSync(join(home, "orphan"), "utf8"));
    await until(() => !running(pid), "the orphan to end");
    await swept();
  }, 60_000);

  test("a process that ignores being asked is killed, even once its parent has gone", async () => {
    writeFileSync(
      join(home, "stubborn.sh"),
      `sh -c 'trap "" TERM HUP; echo $$ > stubborn; exec sleep 60' & wait\n`,
    );
    const proc = run(`import { test } from "bun:test";
test("leaky", async () => {
  Bun.spawn(["sh", "stubborn.sh"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  while (!(await Bun.file("stubborn").exists())) await Bun.sleep(10);
});`);
    expect(await proc.exited).not.toBe(0);
    const pid = Number(readFileSync(join(home, "stubborn"), "utf8"));
    await until(() => !running(pid), "the stubborn process to end");
    await swept();
  }, 60_000);

  test("a run killed part way leaves no process, tmux server, socket or folder", async () => {
    const proc = run(`import { test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("killed", async () => {
  const folder = mkdtempSync(join(tmpdir(), "skel-fixture-test-"));
  const socket = \`skel-test-\${process.pid}-fixture\`;
  ${stray("stray", "env: process.env,")}
  ${stray("unnamed")}
  // Two looks by the sweep, as the first may have begun before this process started.
  const looked = join(process.env.TMPDIR ?? "", "looked");
  for (const look of [1, 2]) {
    rmSync(looked, { force: true });
    while (!existsSync(looked)) await Bun.sleep(10);
  }
  Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", "new-session", "-d",
    "echo $$ > pane; exec sleep 60"]);
  while (!(await Bun.file("pane").exists())) await Bun.sleep(10);
  writeFileSync("ready", JSON.stringify({ folder, socket }));
  await Bun.sleep(60_000);
}, 70_000);`);
    const ready = join(home, "ready");
    await until(() => existsSync(ready) && readFileSync(ready, "utf8") !== "", "the run to start");
    const { folder, socket } = JSON.parse(readFileSync(ready, "utf8"));
    const pids = ["stray", "unnamed", "pane"].map((file) =>
      Number(readFileSync(join(home, file), "utf8")),
    );
    expect(pids.every(running)).toBe(true);
    proc.kill("SIGKILL");
    await proc.exited;
    const file = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`, socket);
    await until(() => !pids.some(running), "the processes to end");
    await until(() => !existsSync(folder), "the folder to go");
    await until(() => !existsSync(file), "the tmux socket to go");
    await swept();
  }, 60_000);
});
