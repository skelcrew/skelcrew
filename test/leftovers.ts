// Loaded before every test file: fails a test that leaves a process running, and ends that
// process, so a run leaves nothing even when a test fails or the run is killed.
import { dlopen, FFIType } from "bun:ffi";
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, endAll, leftovers } from "./sweep.ts";

// It reads /proc, which only Linux has.
if (process.platform === "linux") {
  // A process whose parent ends comes to the run rather than to init, so it stays under the
  // run, even a tmux server. Those that end stay as zombies until the run ends.
  const PR_SET_CHILD_SUBREAPER = 36;
  const libc = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
  });
  libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1);

  // Test folders land in this one, so a process given a test's HOME names it. A process
  // started without an env of its own doesn't get this TMPDIR: Bun hands on the environment
  // the run started with, whatever process.env says now.
  const run = { run: process.pid, folder: mkdtempSync(join(tmpdir(), "skel-run-")) };
  process.env.TMPDIR = run.folder;
  // In a session of its own, so what stops the run doesn't stop this too. In a folder that
  // stays, as a run can start in a test's folder, and nothing starts from one that went.
  const sweep = Bun.spawn(
    [process.execPath, join(import.meta.dir, "sweep.ts"), String(run.run), run.folder],
    { cwd: "/", detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  sweep.unref();

  // Runs after each test's own clean-up. tmux and bubblewrap take a moment to end what they
  // ran, so processes get two seconds. A test that timed out is still here too: its finally
  // only runs if the run lasts long enough to reach it.
  afterEach(async () => {
    const deadline = Date.now() + 2000;
    while (leftovers(run, sweep.pid).length > 0 && Date.now() < deadline) await Bun.sleep(50);
    const left = leftovers(run, sweep.pid).map(command);
    if (left.length === 0) return;
    await endAll(run, sweep.pid);
    throw new Error(`this test left processes running:\n${left.join("\n")}`);
  });

  // A parallel run loads this file again for each test file, in a worker process that runs
  // its files one after another. An earlier file's sweep would still be running there, under
  // the same process, and look like something this file left. So the sweep clears up and
  // ends with its file, and the next file waits for that, so the sweep can't end its processes.
  afterAll(async () => {
    sweep.kill("SIGTERM");
    await sweep.exited;
  });
}
