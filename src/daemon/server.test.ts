import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod";
import { MAX_LINE } from "../protocol/protocol";
import { spec } from "../test/fixtures";
import { type Server, serve } from "./server";
import { cleanUp, openLine, throwawayRepo } from "./testing";

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

const add = (id: string, title: string) =>
  `${JSON.stringify({ id, command: { type: "add", title, spec: false, project: null } })}\n`;

// Sends one request on its own connection and gives back the reply.
async function send(socket: string, command: unknown): Promise<unknown> {
  const line = await openLine(socket);
  line.send(`${JSON.stringify({ id: "r", command })}\n`);
  const reply = JSON.parse(await line.next());
  line.close();
  return reply;
}

describe("the daemon's socket", () => {
  // Found by review: stopping waited up to 30 seconds for requests being
  // answered, and a done waiting on checks was one. The checks were only
  // stopped after that.
  test("stops at once while a done waits on checks, and tells it why", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "workflow.yml"), 'checks:\n  - "sleep 40"\n');
    let sessions = 0;
    const served = await serve(repo, {
      newSession: () => {
        sessions += 1;
        return `you-${sessions}`;
      },
    });
    if (!served.ok) throw new Error(served.message);
    const socket = served.server.socket;
    await send(socket, { type: "add", title: "CSV export", spec: true, project: null });
    await send(socket, { type: "claim", task: 1 });
    await send(socket, { type: "submit", task: 1, session: "you-1", spec });
    await send(socket, { type: "approve", task: 1, sendBack: null });
    await send(socket, { type: "claim", task: 1 });
    const worktree = join(realpathSync(repo), ".skelcrew", "worktrees", "1-csv-export");
    writeFileSync(join(worktree, "export.csv"), "a,b\n");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.name=A", "-c", "user.email=a@a", ...args], {
        cwd: worktree,
      });
    git("add", "export.csv");
    git("commit", "-q", "-m", "Export");

    const done = send(socket, { type: "done", task: 1, session: "you-2" });
    await Bun.sleep(500);
    const began = Date.now();
    await served.server.stop();
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(await done).toEqual({ id: "r", ok: false, message: "The daemon is shutting down." });
  }, 20_000);

  // Found by review: something at the socket's path that couldn't be
  // removed made serve throw, and kept the lock.
  test("refuses to start, without throwing, when its socket path can't be cleared", async () => {
    const repo = throwawayRepo(dirs);
    const socket = join(repo, ".skelcrew", "daemon.sock");
    mkdirSync(join(socket, "inside"), { recursive: true });
    const served = await serve(repo);
    expect(served.ok).toBe(false);
    expect(!served.ok && served.message).toContain("daemon.sock");

    rmSync(socket, { recursive: true });
    await started(repo);
  });

  test("answers a request with the request's id", async () => {
    const server = await started(throwawayRepo(dirs));
    const line = await openLine(server.socket);
    line.send(add("r1", "CSV export"));
    expect(JSON.parse(await line.next())).toEqual({ id: "r1", ok: true, result: { task: 1 } });
    line.close();
  });

  test("answers several requests sent on one connection, each with its own id", async () => {
    const server = await started(throwawayRepo(dirs));
    const line = await openLine(server.socket);
    line.send(add("a", "one") + add("b", "two") + add("c", "three"));
    const replies = [await line.next(), await line.next(), await line.next()].map((l) =>
      JSON.parse(l),
    );
    expect(replies).toEqual([
      { id: "a", ok: true, result: { task: 1 } },
      { id: "b", ok: true, result: { task: 2 } },
      { id: "c", ok: true, result: { task: 3 } },
    ]);
    line.close();
  });

  test("answers many connections at once, each on its own connection", async () => {
    const server = await started(throwawayRepo(dirs));
    const lines = await Promise.all([1, 2, 3, 4, 5].map(() => openLine(server.socket)));
    lines.forEach((line, i) => {
      line.send(add(`conn-${i}`, `task ${i}`));
    });
    const replies = await Promise.all(lines.map(async (line) => JSON.parse(await line.next())));
    expect(replies.map((reply) => reply.id)).toEqual([
      "conn-0",
      "conn-1",
      "conn-2",
      "conn-3",
      "conn-4",
    ]);
    const numbers = replies.map((reply) => reply.result.task).sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    for (const line of lines) line.close();
  });

  test("refuses a line that isn't a request, and keeps the connection open", async () => {
    const server = await started(throwawayRepo(dirs));
    const line = await openLine(server.socket);
    line.send("not json\n");
    const refused = JSON.parse(await line.next());
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe("The request isn't valid JSON.");

    // A request with a readable id is refused under that id.
    line.send(`${JSON.stringify({ id: "r2", command: { type: "merge" } })}\n`);
    const typo = JSON.parse(await line.next());
    expect(typo).toMatchObject({ id: "r2", ok: false });

    line.send(add("r3", "CSV export"));
    expect(JSON.parse(await line.next())).toEqual({ id: "r3", ok: true, result: { task: 1 } });
    line.close();
  });

  // A client that never ends its line can't make the daemon read without
  // end. Only its own connection is closed.
  test("refuses a line over the size limit and closes only that connection", async () => {
    const server = await started(throwawayRepo(dirs));
    const other = await openLine(server.socket);
    const flood = await openLine(server.socket);
    flood.send("x".repeat(MAX_LINE + 10));
    const refused = JSON.parse(await flood.next());
    expect(refused.ok).toBe(false);
    expect(refused.message).toBe(`The request is longer than ${MAX_LINE} bytes.`);
    await flood.closed;

    other.send(add("r1", "CSV export"));
    expect(JSON.parse(await other.next())).toEqual({ id: "r1", ok: true, result: { task: 1 } });
    other.close();
  });

  test("refuses to start without a workflow.yml, and says how to make one", async () => {
    const repo = throwawayRepo(dirs);
    rmSync(join(repo, ".skelcrew", "workflow.yml"));
    const served = await serve(repo);
    expect(served).toEqual({
      ok: false,
      message: `${repo} has no .skelcrew/workflow.yml. Run \`skelcrew init\` there first.`,
    });
  });

  test("refuses to start when the main branch doesn't exist, and says how to set it", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(
      join(repo, ".skelcrew", "workflow.yml"),
      'checks:\n  - "true"\nmain_branch: trunk\n',
    );
    expect(await serve(repo)).toEqual({
      ok: false,
      message:
        "This repository has no branch trunk. Set main_branch in .skelcrew/workflow.yml to the branch tasks start from and merge into.",
    });
  });

  // Found by review: without git, starting threw a raw "Executable not
  // found" error.
  // In a process of its own, since PATH is read when the process starts.
  test("refuses to start without git, and says so", async () => {
    const repo = throwawayRepo(dirs);
    // An empty folder: an empty PATH falls back to the usual places.
    const noGit = mkdtempSync(join(tmpdir(), "sk-nogit-"));
    dirs.push(noGit);
    const script = `
      import { serve } from ${JSON.stringify(join(import.meta.dir, "server.ts"))};
      const served = await serve(process.env.REPO ?? "");
      if (served.ok) await served.server.stop();
      console.log(JSON.stringify(served.ok ? "started" : served.message));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: { REPO: repo, PATH: noGit },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(child.stdout).text();
    await child.exited;
    expect(out.trim()).toBe(JSON.stringify("Skelcrew needs git, and couldn't find it."));
  });

  // A folder inside a git repository would get worktrees and merges of
  // the whole repository, which nobody has tested.
  test("refuses to start in a folder inside a git repository, not where it starts", async () => {
    const top = throwawayRepo(dirs);
    const web = join(top, "web");
    mkdirSync(join(web, ".skelcrew"), { recursive: true });
    writeFileSync(join(web, ".skelcrew", "workflow.yml"), 'checks:\n  - "true"\n');
    expect(await serve(web)).toEqual({
      ok: false,
      message: `${realpathSync(web)} is inside the git repository at ${realpathSync(top)}. Run Skelcrew there, where the repository starts.`,
    });
  });

  test("refuses to start outside a git repository", async () => {
    const repo = throwawayRepo(dirs);
    rmSync(join(repo, ".git"), { recursive: true });
    expect(await serve(repo)).toEqual({
      ok: false,
      message: `${repo} isn't a git repository. Skelcrew needs one.`,
    });
  });

  test("refuses to start with a workflow.yml that doesn't fit, with every reason", async () => {
    const repo = throwawayRepo(dirs);
    writeFileSync(join(repo, ".skelcrew", "workflow.yml"), "checks: []\nmax_running: 0\n");
    const served = await serve(repo);
    expect(served).toEqual({
      ok: false,
      message: [
        ".skelcrew/workflow.yml doesn't fit:",
        "- checks: list at least one command, such as the one that runs your tests.",
        "- max_running: must be a whole number, 1 or more.",
      ].join("\n"),
    });
  });

  test("keeps its tasks in .skelcrew/skelcrew.db, so a restart picks them up", async () => {
    const repo = throwawayRepo(dirs);
    const first = await started(repo);
    const line = await openLine(first.socket);
    line.send(add("r1", "CSV export"));
    await line.next();
    line.close();
    await first.stop();
    expect(existsSync(join(repo, ".skelcrew", "skelcrew.db"))).toBe(true);

    const second = await started(repo);
    const again = await openLine(second.socket);
    again.send(add("r2", "PDF export"));
    expect(JSON.parse(await again.next())).toEqual({ id: "r2", ok: true, result: { task: 2 } });
    again.close();
  });

  // Found by review: requests sent just before a stop got no answer at
  // all, so the client couldn't tell whether anything was saved.
  test("answers every request sent just before it stops", async () => {
    const served = await serve(throwawayRepo(dirs));
    if (!served.ok) throw new Error(served.message);
    const line = await openLine(served.server.socket);
    line.send(Array.from({ length: 50 }, (_, i) => add(`r${i}`, `Task ${i}`)).join(""));
    const stopped = served.server.stop();
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const next = await Promise.race([line.next(), line.closed.then(() => null)]);
      if (next === null) break;
      ids.push(z.object({ id: z.string() }).parse(JSON.parse(next)).id);
    }
    await stopped;
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => `r${i}`));
  });

  // Found by review: each new line restarted the wait for quiet, so a
  // client that kept sending held a stop open for the whole grace period.
  test("stops within a second, even while a client keeps sending", async () => {
    const served = await serve(throwawayRepo(dirs), { graceMs: 5_000 });
    if (!served.ok) throw new Error(served.message);
    const line = await openLine(served.server.socket);
    const status = `${JSON.stringify({ id: "s", command: { type: "status" } })}\n`;
    const sending = setInterval(() => line.send(status), 20);
    try {
      const began = Date.now();
      await served.server.stop();
      expect(Date.now() - began).toBeLessThan(1_000);
    } finally {
      clearInterval(sending);
      line.close();
    }
  }, 15_000);

  test("stops listening and removes its socket when stopped", async () => {
    const server = await served(throwawayRepo(dirs));
    const line = await openLine(server.socket);
    await server.stop();
    await line.closed;
    expect(existsSync(server.socket)).toBe(false);
    await expect(openLine(server.socket)).rejects.toThrow();
  });

  test("works in a repository too deep for a socket in .skelcrew/", async () => {
    const repo = throwawayRepo(dirs, "a-folder-with-a-rather-long-name".repeat(3));
    const server = await started(repo);
    expect(server.socket.startsWith(join(repo, ".skelcrew"))).toBe(false);
    expect(server.socket.startsWith(`/tmp/skelcrew-${process.getuid?.()}/`)).toBe(true);
    const line = await openLine(server.socket);
    line.send(add("r1", "CSV export"));
    expect(JSON.parse(await line.next())).toEqual({ id: "r1", ok: true, result: { task: 1 } });
    line.close();
  });
});

// The socket folder in /tmp is shared by all of one user's repositories.
// Only that user may open it, or another user could reach their daemons.
test("keeps the socket folder in /tmp for the user alone", async () => {
  const repo = throwawayRepo(dirs, "a-folder-with-a-rather-long-name".repeat(3));
  const base = `/tmp/skelcrew-${process.getuid?.()}`;
  mkdirSync(base, { recursive: true });
  chmodSync(base, 0o755);
  const server = await started(repo);
  expect(dirname(server.socket)).toBe(base);
  expect(statSync(base).mode & 0o777).toBe(0o700);
});

// A server this test stops itself, so afterEach doesn't stop it twice.
async function served(repo: string): Promise<Server> {
  const result = await serve(repo);
  if (!result.ok) throw new Error(result.message);
  return result.server;
}
