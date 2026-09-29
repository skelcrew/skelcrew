import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Server, serve } from "./server";
import { cleanUp, daemonInAnotherProcess, openLine, throwawayRepo } from "./testing";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  cleanUp(dirs);
});

async function started(repo: string): Promise<Server> {
  const served = await serve(repo);
  if (!served.ok) throw new Error(served.message);
  servers.push(served.server);
  return served.server;
}

async function answers(server: Server): Promise<unknown> {
  const line = await openLine(server.socket);
  line.send(`${JSON.stringify({ id: "r1", command: { type: "status" } })}\n`);
  const reply = JSON.parse(await line.next());
  line.close();
  return reply;
}

// The pid of a process that has finished, so no process has it now.
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("one daemon per repository", () => {
  test("refuses a second daemon for the same repository", async () => {
    const repo = throwawayRepo(dirs);
    const first = await started(repo);
    expect(await serve(repo)).toEqual({
      ok: false,
      message: `The daemon is already running for this repository, as process ${process.pid}.`,
    });
    expect(await answers(first)).toMatchObject({ id: "r1", ok: true });
  });

  test("refuses a daemon while another process runs one", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    try {
      expect(await serve(repo)).toEqual({
        ok: false,
        message: `The daemon is already running for this repository, as process ${child.pid}.`,
      });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  // The lock file itself stays: deleting a lock file that another process
  // may be opening is a race of its own. The process id is only there to
  // say who runs the daemon.
  test("names its process in .skelcrew/daemon.pid, and frees the lock when stopped", async () => {
    const repo = throwawayRepo(dirs);
    const served = await serve(repo);
    if (!served.ok) throw new Error(served.message);
    const pid = join(repo, ".skelcrew", "daemon.pid");
    expect(readFileSync(pid, "utf8").trim()).toBe(String(process.pid));
    await served.server.stop();
    expect(existsSync(pid)).toBe(false);
    await started(repo);
  });

  // A daemon killed outright leaves its lock and its socket file behind.
  test("takes over from a daemon that died without cleaning up", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(join(repo, ".skelcrew", "daemon.lock"))).toBe(true);
    expect(existsSync(join(repo, ".skelcrew", "daemon.sock"))).toBe(true);

    const server = await started(repo);
    expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
  });

  test("isn't kept out by a leftover lock file naming a process that no longer runs", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.lock"), `${await deadPid()}\n`);
    const server = await started(repo);
    expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
  });

  // Found by review: after a crash or a reboot, the process id in a
  // leftover lock often belongs to some other program, and every start was
  // then refused until someone deleted the lock by hand.
  test("isn't kept out by a leftover lock file naming some other live program", async () => {
    const repo = throwawayRepo(dirs);
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(repo, ".skelcrew", "daemon.lock"), `${other.pid}\n`);
      const server = await started(repo);
      expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
    } finally {
      other.kill();
      await other.exited;
    }
  });

  // Found by review: when several daemons started at once after a crash,
  // one could clear a lock another had just taken, and two ran together.
  test("lets exactly one of many daemons starting at once take the lock", async () => {
    const repo = throwawayRepo(dirs);
    const lock = join(repo, ".skelcrew", "daemon.lock");
    const script = join(repo, "take.ts");
    writeFileSync(
      script,
      `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
        "const taken = takeLock(process.argv[2] ?? '');\n" +
        "console.log(taken.ok ? 'GOT' : 'NO');\n" +
        "await Bun.sleep(800);\n",
    );
    for (let round = 0; round < 15; round += 1) {
      // A daemon that died left its lock behind.
      writeFileSync(lock, `${await deadPid()}\n`);
      const children = Array.from({ length: 12 }, () =>
        Bun.spawn([process.execPath, script, lock], { stdout: "pipe" }),
      );
      const said = await Promise.all(children.map((child) => new Response(child.stdout).text()));
      await Promise.all(children.map((child) => child.exited));
      expect({ round, holders: said.filter((out) => out.trim() === "GOT").length }).toEqual({
        round,
        holders: 1,
      });
    }
  }, 60_000);

  test("takes over a lock that holds no process id", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.lock"), "");
    await started(repo);
  });

  // Otherwise a daemon that failed to start would keep every later one out.
  test("lets go of the lock when it fails to start", async () => {
    const repo = throwawayRepo(dirs);
    const store = join(repo, ".skelcrew", "skelcrew.db");
    mkdirSync(store);
    const served = await serve(repo);
    expect(served.ok).toBe(false);
    // With the cause fixed, the next daemon starts.
    rmSync(store, { recursive: true });
    await started(repo);
  });
});
