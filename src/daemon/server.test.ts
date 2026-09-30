import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_LINE } from "../protocol/protocol";
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

describe("the daemon's socket", () => {
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
