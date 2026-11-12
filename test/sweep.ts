// Finds and ends what a test run left running. Run on its own, it waits for that run to die,
// however it died, or to say its test file is done, and clears up after it, since a killed
// run can't do that itself.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { processTree } from "../src/agents/tmux.ts";

// A test run: its process and the folder its tests' folders land in.
export type Run = { run: number; folder: string };

// Returns a file of /proc as text, or nothing once the process is gone or isn't ours to read.
function proc(pid: number | string, file: string): string {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "latin1");
  } catch {
    return "";
  }
}

// Returns the command of a process as a person would read it, to say what was left running.
export const command = (pid: number) => proc(pid, "cmdline").replaceAll("\0", " ").trim();

// Returns what a test run has running, by what only that run's processes have: the run as an
// ancestor, its folder in their command or environment, or its process ID in the name of a
// tmux socket. The last two still work once the run is dead. Nothing here goes by a program's
// name, so a real agent's process, or another run's, never matches. A process that exited but
// wasn't reaped has no command, so it doesn't count.
export function leftovers({ run, folder }: Run, spared: number): number[] {
  const marked = readdirSync("/proc").filter((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    const command = proc(entry, "cmdline");
    const named = command.includes(folder) || proc(entry, "environ").includes(folder);
    return named || command.includes(`skel-test-${run}-`);
  });
  const found = new Set([...marked.map(Number), ...processTree(run).slice(1)]);
  // Read after the tree, so a ps the sweep is running at the time is spared too.
  const left = processTree(spared);
  return [...found].filter((pid) => !left.includes(pid) && pid !== run && command(pid) !== "");
}

// Ends every process of the run, and those in `known`. Each is asked first, so a daemon can
// end what it started and a tmux server its panes. A second later, whatever is still there is
// killed, such as a process that ignores being asked. IDs found along the way are kept: a
// process whose parent just ended is no longer under the run, and may name nothing else.
export async function endAll(run: Run, spared: number, known: number[] = []): Promise<void> {
  const found = new Set(known.filter((pid) => pid !== spared));
  const send = (signal: NodeJS.Signals) => {
    for (const pid of leftovers(run, spared)) found.add(pid);
    for (const pid of found)
      try {
        process.kill(pid, signal);
      } catch {}
  };
  send("SIGTERM");
  const deadline = Date.now() + 1000;
  const going = () => [...found].some((pid) => command(pid) !== "");
  while (going() && Date.now() < deadline) await Bun.sleep(50);
  send("SIGKILL");
}

if (import.meta.main) {
  const run = Number(Bun.argv[2]);
  const folder = Bun.argv[3];
  if (!run || !folder) throw new Error("usage: sweep.ts <run's process ID> <run's folder>");
  // Once the run is gone, what it started without naming it can't be told from anyone's, so
  // the sweep keeps the run's latest tree. One started since the last look is missed. No test
  // starts such a process: all give a test's HOME to anything that keeps running.
  let tree: number[] = [];
  // The run writes "done" in its folder when its test file ends, as a parallel worker goes on
  // to run another file in the same process. Clearing up is then the same as after a dead run.
  while (!existsSync(join(folder, "done")) && proc(run, "cmdline") !== "") {
    tree = processTree(run)
      .slice(1)
      .filter((pid) => command(pid) !== "");
    // Lets a test know the sweep has seen what it just started.
    writeFileSync(join(folder, "looked"), "");
    await Bun.sleep(200);
  }
  await endAll({ run, folder }, process.pid, tree);
  rmSync(folder, { recursive: true, force: true });
  // tmux leaves its socket file behind.
  const sockets = join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${userInfo().uid}`);
  for (const name of existsSync(sockets) ? readdirSync(sockets) : [])
    if (name.startsWith(`skel-test-${run}-`)) rmSync(join(sockets, name), { force: true });
}
