import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeLock } from "./lock";
import { type Server, serve } from "./server";
import { asRoot, cleanUp, daemonInAnotherProcess, openLine, throwawayRepo } from "./testing";

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
// `repo`. Returns how many got it. Each says GOT or NO, then holds on until
// every one of them has said, so the one that got it still holds it while
// the others try, however slowly they start. The script goes in a folder
// of its own, since `repo` may be read-only.
async function raceFor(repo: string, count: number): Promise<number> {
  const scripts = mkdtempSync(join(tmpdir(), "sk-race-"));
  dirs.push(scripts);
  const script = join(scripts, "race.ts");
  writeFileSync(
    script,
    `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
      "const taken = takeLock(process.argv[2] ?? '');\n" +
      "console.log(taken.ok ? 'GOT' : 'NO');\n" +
      // Holds on until the test closes standard input.
      "await Bun.stdin.text();\n",
  );
  const children = Array.from({ length: count }, () =>
    Bun.spawn([process.execPath, script, repo], { stdin: "pipe", stdout: "pipe" }),
  );
  const said = await Promise.all(children.map((child) => firstLine(child.stdout)));
  for (const child of children) await child.stdin.end();
  await Promise.all(children.map((child) => child.exited));
  return said.filter((line) => line === "GOT").length;
}

// The first line a process writes, without waiting for it to end.
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text.split("\n")[0]?.trim() ?? "";
}

describe("one daemon per repository", () => {
  test("refuses a second daemon for the same repository", async () => {
    const repo = throwawayRepo(dirs);
    const first = await started(repo);
    expect(await serve(repo)).toEqual({
      ok: false,
      message: `The daemon is already running for this repository, as process ${process.pid}. If skelcrew can't reach it, stop that process and try again.`,
    });
    expect(await answers(first)).toMatchObject({ id: "r1", ok: true });
  });

  test("refuses a daemon while another process runs one", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    try {
      expect(await serve(repo)).toEqual({
        ok: false,
        message: `The daemon is already running for this repository, as process ${child.pid}. If skelcrew can't reach it, stop that process and try again.`,
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
        message:
          "The daemon is already running for this repository. If skelcrew can't reach it, stop the daemon and try again.",
      });
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  });

  // Found by review: the lock was on .skelcrew, so replacing that folder
  // let a second daemon in. Both gave out task #2 again.
  test("refuses a second daemon after .skelcrew is replaced by a copy", async () => {
    const repo = throwawayRepo(dirs);
    const child = await daemonInAnotherProcess(repo);
    try {
      const folder = join(repo, ".skelcrew");
      renameSync(folder, join(repo, ".skelcrew-old"));
      // Everything but the socket, which can't be copied on Linux.
      cpSync(join(repo, ".skelcrew-old"), folder, {
        recursive: true,
        filter: (from) => !from.endsWith("daemon.sock"),
      });
      const second = await serve(repo);
      if (second.ok) await second.server.stop();
      expect(second).toEqual({
        ok: false,
        message: `The daemon is already running for this repository, as process ${child.pid}. If skelcrew can't reach it, stop that process and try again.`,
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
      expect({ round, holders: await raceFor(repo, 4) }).toEqual({ round, holders: 1 });
    }
  }, 60_000);

  // Found by review: SQLite opened a read-only lock file read-only, and its
  // exclusive hold then locked nothing, so every daemon thought it held it.
  test.skipIf(asRoot)(
    "lets exactly one daemon hold the lock on a repository it can't write to",
    async () => {
      const repo = throwawayRepo(dirs);
      chmodSync(repo, 0o555);
      try {
        expect(await raceFor(repo, 3)).toBe(1);
      } finally {
        chmodSync(repo, 0o755);
      }
    },
    30_000,
  );

  // A daemon starts git and the checks. They mustn't keep its lock after it
  // has died.
  test("frees the lock when its daemon dies, even if something it started still runs", async () => {
    const repo = throwawayRepo(dirs);
    const script = join(repo, "hold.ts");
    writeFileSync(
      script,
      `import { takeLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))};\n` +
        "const taken = takeLock(process.argv[2] ?? '');\n" +
        "const child = Bun.spawn(['sleep', '10']);\n" +
        "console.log((taken.ok ? 'GOT ' : 'NO ') + child.pid);\n" +
        "await Bun.sleep(10_000);\n",
    );
    const holder = Bun.spawn([process.execPath, script, repo], { stdout: "pipe" });
    const reader = holder.stdout.getReader();
    const [got, pid] = new TextDecoder()
      .decode((await reader.read()).value)
      .trim()
      .split(" ");
    expect(got).toBe("GOT");
    holder.kill("SIGKILL");
    await holder.exited;
    try {
      const taken = takeLock(repo);
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.lock.release();
    } finally {
      // Only the process it started, never someone else's.
      if (pid !== undefined) process.kill(Number(pid), "SIGKILL");
    }
  }, 30_000);

  // Found by review: when several daemons started at once after a crash,
  // one could clear a lock another had just taken, and two ran together.
  test("lets exactly one of many daemons starting at once take the lock", async () => {
    const repo = throwawayRepo(dirs);
    const folder = join(repo, ".skelcrew");
    for (let round = 0; round < 15; round += 1) {
      // A daemon that died left its pid file behind.
      writeFileSync(join(folder, "daemon.pid"), `${await deadPid()}\n`);
      expect({ round, holders: await raceFor(repo, 12) }).toEqual({ round, holders: 1 });
    }
  }, 60_000);

  test("takes over when the pid file holds no process id", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.pid"), "");
    await started(repo);
  });

  // Found by review: with .skelcrew read-only, removing daemon.pid threw
  // before the lock was let go, so the lock stayed held and stop threw.
  test.skipIf(asRoot)(
    "lets go of the lock when it stops, even if it can't remove its pid file",
    async () => {
      const repo = throwawayRepo(dirs);
      const served = await serve(repo);
      if (!served.ok) throw new Error(served.message);
      const folder = join(repo, ".skelcrew");
      chmodSync(folder, 0o555);
      try {
        await served.server.stop();
        const next = takeLock(repo);
        expect(next.ok).toBe(true);
        if (next.ok) next.lock.release();
      } finally {
        chmodSync(folder, 0o755);
      }
    },
  );

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
