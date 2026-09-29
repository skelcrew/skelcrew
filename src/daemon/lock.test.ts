import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  test("holds .skelcrew/daemon.lock with its process id, and removes it when stopped", async () => {
    const repo = throwawayRepo(dirs);
    const served = await serve(repo);
    if (!served.ok) throw new Error(served.message);
    const lock = join(repo, ".skelcrew", "daemon.lock");
    expect(readFileSync(lock, "utf8").trim()).toBe(String(process.pid));
    await served.server.stop();
    expect(existsSync(lock)).toBe(false);
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

  test("takes over a lock whose process no longer runs", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "daemon.lock"), `${await deadPid()}\n`);
    const server = await started(repo);
    expect(await answers(server)).toMatchObject({ id: "r1", ok: true });
  });

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
    expect(existsSync(join(repo, ".skelcrew", "daemon.lock"))).toBe(false);
  });
});
