import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { takeLock } from "./lock";
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

// Starts `count` processes at once that each try to take the lock on
// `folder` and hold it a moment. Returns how many got it.
async function raceFor(folder: string, count: number): Promise<number> {
  const script = join(folder, "..", "race.ts");
  writeFileSync(
    script,
    `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
      "const taken = takeLock(process.argv[2] ?? '');\n" +
      "console.log(taken.ok ? 'GOT' : 'NO');\n" +
      "await Bun.sleep(800);\n",
  );
  const children = Array.from({ length: count }, () =>
    Bun.spawn([process.execPath, script, folder], { stdout: "pipe" }),
  );
  const said = await Promise.all(children.map((child) => new Response(child.stdout).text()));
  await Promise.all(children.map((child) => child.exited));
  return said.filter((out) => out.trim() === "GOT").length;
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

  // Found by review: deleting .skelcrew/daemon.lock while a daemon ran let
  // a second one start. Both gave out task #2, and from then on no daemon
  // could read the saved record.
  test("refuses a second daemon even after the files in .skelcrew are deleted", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    try {
      for (const name of ["daemon.lock", "daemon.pid", "daemon.sock"]) {
        rmSync(join(repo, ".skelcrew", name), { force: true });
      }
      const second = await serve(repo);
      if (second.ok) await second.server.stop();
      expect(second).toEqual({
        ok: false,
        message: "The daemon is already running for this repository.",
      });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  // The process id is only there to say who runs the daemon.
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

  // A daemon killed outright leaves its pid file and its socket file behind.
  test("takes over from a daemon that died without cleaning up", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(join(repo, ".skelcrew", "daemon.pid"))).toBe(true);
    expect(existsSync(join(repo, ".skelcrew", "daemon.sock"))).toBe(true);

    const server = await started(repo);
    expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
  });

  test("isn't kept out by a leftover pid file naming a process that no longer runs", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.pid"), `${await deadPid()}\n`);
    const server = await started(repo);
    expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
  });

  // Found by review: after a crash or a reboot, the process id in a
  // leftover lock often belongs to some other program, and every start was
  // then refused until someone deleted the lock by hand.
  test("isn't kept out by a leftover pid file naming some other live program", async () => {
    const repo = throwawayRepo(dirs);
    const other = Bun.spawn(["sleep", "30"]);
    try {
      writeFileSync(join(repo, ".skelcrew", "daemon.pid"), `${other.pid}\n`);
      const server = await started(repo);
      expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
    } finally {
      other.kill();
      await other.exited;
    }
  });

  // Found by review: the SQLite lock took a shared hold before the
  // exclusive one, so daemons starting at once blocked each other, and
  // often none of them ran.
  test("lets exactly one of several daemons starting at once run, never none", async () => {
    for (let round = 0; round < 10; round += 1) {
      const repo = throwawayRepo(dirs);
      const folder = join(repo, ".skelcrew");
      expect({ round, holders: await raceFor(folder, 4) }).toEqual({ round, holders: 1 });
    }
  }, 60_000);

  // Found by review: SQLite opened a read-only lock file read-only, and its
  // exclusive hold then locked nothing, so every daemon thought it held it.
  test("lets exactly one daemon hold the lock on a folder it can't write to", async () => {
    const repo = throwawayRepo(dirs);
    const folder = join(repo, ".skelcrew");
    chmodSync(folder, 0o555);
    try {
      expect(await raceFor(folder, 3)).toBe(1);
    } finally {
      chmodSync(folder, 0o755);
    }
  }, 30_000);

  // A daemon starts git and the checks. They mustn't keep its lock after it
  // has died.
  test("frees the lock when its daemon dies, even if something it started still runs", async () => {
    const repo = throwawayRepo(dirs);
    const folder = join(repo, ".skelcrew");
    const script = join(repo, "hold.ts");
    writeFileSync(
      script,
      `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
        "const taken = takeLock(process.argv[2] ?? '');\n" +
        "Bun.spawn(['sleep', '10']);\n" +
        "console.log(taken.ok ? 'GOT' : 'NO');\n" +
        "await Bun.sleep(10_000);\n",
    );
    const holder = Bun.spawn([process.execPath, script, folder], { stdout: "pipe" });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("GOT\n");
    holder.kill("SIGKILL");
    await holder.exited;
    try {
      const taken = takeLock(folder);
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.lock.release();
    } finally {
      Bun.spawnSync(["pkill", "-f", "sleep 10"]);
    }
  }, 30_000);

  // Found by review: when several daemons started at once after a crash,
  // one could clear a lock another had just taken, and two ran together.
  test("lets exactly one of many daemons starting at once take the lock", async () => {
    const repo = throwawayRepo(dirs);
    const folder = join(repo, ".skelcrew");
    const script = join(repo, "take.ts");
    writeFileSync(
      script,
      `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
        "const taken = takeLock(process.argv[2] ?? '');\n" +
        "console.log(taken.ok ? 'GOT' : 'NO');\n" +
        "await Bun.sleep(800);\n",
    );
    for (let round = 0; round < 15; round += 1) {
      // A daemon that died left its pid file behind.
      writeFileSync(join(folder, "daemon.pid"), `${await deadPid()}\n`);
      const children = Array.from({ length: 12 }, () =>
        Bun.spawn([process.execPath, script, folder], { stdout: "pipe" }),
      );
      const said = await Promise.all(children.map((child) => new Response(child.stdout).text()));
      await Promise.all(children.map((child) => child.exited));
      expect({ round, holders: said.filter((out) => out.trim() === "GOT").length }).toEqual({
        round,
        holders: 1,
      });
    }
  }, 60_000);

  test("takes over when the pid file holds no process id", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.pid"), "");
    await started(repo);
  });

  // Found by review: with .skelcrew read-only, removing daemon.pid threw
  // before the lock was let go, so the lock stayed held and stop threw.
  test("lets go of the lock when it stops, even if it can't remove its pid file", async () => {
    const repo = throwawayRepo(dirs);
    const served = await serve(repo);
    if (!served.ok) throw new Error(served.message);
    const folder = join(repo, ".skelcrew");
    chmodSync(folder, 0o555);
    try {
      await served.server.stop();
      const next = takeLock(folder);
      expect(next.ok).toBe(true);
      if (next.ok) next.lock.release();
    } finally {
      chmodSync(folder, 0o755);
    }
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
