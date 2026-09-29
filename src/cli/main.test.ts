// The real `skelcrew` program, run as a process. These are the only CLI
// tests that spawn one: they check what a function call can't, such as
// standard input, exit codes and a daemon started in the background.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { takeLock } from "../daemon/lock";
import { daemonPaths } from "../daemon/paths";
import { type Server, serve } from "../daemon/server";
import { cleanUp, throwawayRepo } from "../daemon/testing";
import { run } from "./cli";
import { startDaemon } from "./start";

const dirs: string[] = [];
const servers: Server[] = [];
const pids: number[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  cleanUp(dirs);
});

const main = join(import.meta.dir, "main.ts");

function skelcrew(repo: string, args: string[], input = "", env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    child,
    result: async () => ({
      code: await child.exited,
      out: await new Response(child.stdout).text(),
      err: await new Response(child.stderr).text(),
    }),
  };
}

function lockOf(repo: string): string {
  const found = daemonPaths(repo);
  if (!found.ok) throw new Error(found.message);
  return found.paths.lock;
}

// The process id of the daemon running for a repository.
function pidOf(repo: string): number {
  return Number(readFileSync(join(dirname(lockOf(repo)), "daemon.pid"), "utf8").trim());
}

// Whether a daemon has let go of the repository: its lock can be taken.
function lockIsFree(repo: string): boolean {
  const taken = takeLock(lockOf(repo));
  if (!taken.ok) return false;
  taken.lock.release();
  return true;
}

// Stops the daemon a test started in the background, and waits until it
// has let go of the repository.
async function stopBackgroundDaemon(repo: string) {
  const pid = pidOf(repo);
  pids.push(pid);
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && !lockIsFree(repo); i += 1) await Bun.sleep(20);
  expect(lockIsFree(repo)).toBe(true);
}

const context = (repo: string) => ({
  cwd: repo,
  session: undefined,
  readStdin: async () => "",
  start: startDaemon,
});

describe("the skelcrew program", () => {
  test("starts the daemon in the background when none is running", async () => {
    const repo = throwawayRepo(dirs);
    const added = await run(["add", "CSV export"], context(repo));
    const pid = pidOf(repo);
    pids.push(pid);
    expect(added).toEqual({ code: 0, out: ["Added #1: CSV export."], err: [] });
    expect(pid).not.toBe(process.pid);
    expect(await run(["status"], context(repo))).toMatchObject({ code: 0 });
    await stopBackgroundDaemon(repo);
  });

  test("says why the daemon it started couldn't start", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "workflow.yml"), "max_running: 0\n");
    const outcome = await run(["status"], context(repo));
    expect(outcome.code).toBe(1);
    expect(outcome.err).toContain("- max_running: must be a whole number, 1 or more.");
  });

  test("runs the daemon with serve until it gets SIGTERM", async () => {
    const repo = throwawayRepo(dirs);
    const { child } = skelcrew(repo, ["serve"]);
    pids.push(child.pid);
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(
      `The daemon for ${realpathSync(repo)} is running. Stop it with Ctrl-C.\n`,
    );
    const noStart = { ...context(repo), start: () => ({ ok: false, message: "No." }) };
    expect(await run(["status"], noStart)).toMatchObject({ code: 0 });

    child.kill("SIGTERM");
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe("The daemon stopped.\n");
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(lockIsFree(repo)).toBe(true);
  });

  test("reads a spec from standard input and prints the answer", async () => {
    const repo = throwawayRepo(dirs);
    const served = await serve(repo, { newSession: () => "you-1" });
    if (!served.ok) throw new Error(served.message);
    servers.push(served.server);
    await run(["add", "CSV export", "--spec"], context(repo));
    await run(["claim", "1"], context(repo));
    const spec = { scope: "Export CSV.", acceptance: ["It downloads."], openQuestions: [] };
    const { result } = skelcrew(repo, ["submit", "#1", "--file", "-"], JSON.stringify(spec), {
      SKELCREW_SESSION: "you-1",
    });
    expect(await result()).toEqual({ code: 0, out: "Submitted the spec for #1.\n", err: "" });
  });

  test("prints a refusal to standard error and exits with 1", async () => {
    const repo = throwawayRepo(dirs);
    const { result } = skelcrew(repo, ["spec", "csv"]);
    expect(await result()).toEqual({
      code: 1,
      out: "",
      err: '"csv" isn\'t a task number. Write it as 12 or #12.\n',
    });
  });

  test("is the skelcrew command in package.json", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json();
    expect(pkg.bin).toEqual({ skelcrew: "src/cli/main.ts" });
  });
});
