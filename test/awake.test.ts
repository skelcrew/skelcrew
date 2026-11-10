// Keeping a Sprite awake while there is work: which threads count as work, decided from their
// rows alone, and the hold the daemon keeps on a fake of the Sprite's control socket.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasWork, type Thread } from "../src/flow/thread.ts";
import { holdAwhile, keepAwake } from "../src/machine/sprite.ts";

function thread(change: Partial<Thread> = {}): Thread {
  return {
    owner: "simon",
    repo: "app",
    task: "12",
    folder: "app-12",
    branch: "skel/12-add-export",
    base: null,
    status: "working",
    session: "s",
    rounds: 0,
    pr: 7,
    needs_you: false,
    submitting: null,
    reviewing: null,
    telling: null,
    held: null,
    seen: [],
    body: null,
    last_review: 0,
    last_comment: 0,
    last_check: 0,
    asking: false,
    noting: null,
    title: null,
    started: null,
    checks: null,
    reviewer: null,
    reviewed_by: null,
    review_round: null,
    verdict: null,
    review_line: null,
    harness: null,
    ...change,
  };
}

test("a builder working is work", () => {
  expect(hasWork([thread()])).toBe(true);
});

test("a builder working on your comment past the round limit is work", () => {
  expect(hasWork([thread({ rounds: 4, needs_you: true })])).toBe(true);
});

test("a review waiting or running is work", () => {
  expect(hasWork([thread({ status: "waiting", submitting: "Add export" })])).toBe(true);
  expect(hasWork([thread({ status: "waiting", reviewing: "abc123" })])).toBe(true);
});

test("a round that failed waits on you, though its submit stays saved to resume", () => {
  const failed = { status: "waiting" as const, needs_you: true };
  expect(hasWork([thread({ ...failed, submitting: "Add export" })])).toBe(false);
  expect(hasWork([thread({ ...failed, reviewing: "abc123" })])).toBe(false);
});

test("a PR waiting on CI is work", () => {
  expect(hasWork([thread({ status: "waiting" })])).toBe(true);
});

test("threads that wait on you, failed, were stopped or are done are no work", () => {
  expect(hasWork([])).toBe(false);
  expect(hasWork([thread({ status: "waiting", needs_you: true })])).toBe(false);
  expect(hasWork([thread({ asking: true })])).toBe(false);
  expect(hasWork([thread({ status: "failed" })])).toBe(false);
  expect(hasWork([thread({ status: "done" })])).toBe(false);
  expect(hasWork([thread({ status: "stopped" })])).toBe(false);
});

test("one thread with work is enough", () => {
  const ready = thread({ status: "waiting", needs_you: true });
  expect(hasWork([ready, thread({ folder: "app-13" })])).toBe(true);
});

// A stand-in for the Sprite's control socket: it notes each request and answers as the real
// one does, 404 for deleting a task that isn't there.
let folder = "";
let socket = "";
let server: Server | null = null;
let calls: string[] = [];
let stop: () => void = () => {};

function serveControlSocket(): Promise<void> {
  const held = new Set<string>();
  server = createServer((connection) => {
    let text = "";
    connection.on("data", (data) => {
      text += data.toString();
      const end = text.indexOf("\r\n\r\n");
      if (end === -1) return;
      const length = Number(/content-length: (\d+)/i.exec(text)?.[1] ?? 0);
      const body = text.slice(end + 4);
      if (body.length < length) return;
      const [method = "", path = ""] = text.split(" ");
      calls.push(`${method} ${path} ${body}`.trim());
      const name = path.split("/").pop() ?? "";
      let status = "200 OK";
      if (method === "PUT") held.add(name);
      else if (method === "DELETE") status = held.delete(name) ? "204 No Content" : "404 Not Found";
      connection.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  });
  return new Promise((done) => server?.listen(socket, done));
}

// Waits until the fake socket has seen `count` requests, or a second has passed.
async function seen(count: number): Promise<string[]> {
  for (let tried = 0; tried < 100 && calls.length < count; tried++) await Bun.sleep(10);
  return calls;
}

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "skel-awake-test-"));
  socket = join(folder, "api.sock");
  calls = [];
  await serveControlSocket();
});
afterEach(() => {
  stop();
  server?.close();
  rmSync(folder, { recursive: true, force: true });
});

test("the daemon holds the Sprite for five minutes and renews the hold", async () => {
  stop = keepAwake(() => true, { socket, every: 20, renew: 50 });
  await Bun.sleep(150);
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(calls.length).toBeLessThanOrEqual(4);
  for (const call of calls) expect(call).toBe('PUT /v1/tasks/skel {"expire":300}');
});

test("the daemon lets the Sprite sleep once there is no work, and holds it again for new work", async () => {
  let work = true;
  stop = keepAwake(() => work, { socket, every: 20, renew: 60_000 });
  await seen(1);
  work = false;
  await seen(2);
  await Bun.sleep(100);
  work = true;
  expect(await seen(3)).toEqual([
    'PUT /v1/tasks/skel {"expire":300}',
    "DELETE /v1/tasks/skel",
    'PUT /v1/tasks/skel {"expire":300}',
  ]);
});

test("a daemon started without work lets go of a hold an earlier daemon left", async () => {
  stop = keepAwake(() => false, { socket, every: 20, renew: 60_000 });
  await Bun.sleep(150);
  expect(calls).toEqual(["DELETE /v1/tasks/skel"]);
});

test("a control socket that doesn't answer is tried again at the next check", async () => {
  server?.close();
  server = null;
  stop = keepAwake(() => true, { socket, every: 20, renew: 60_000 });
  await Bun.sleep(60);
  await serveControlSocket();
  expect(await seen(1)).toEqual(['PUT /v1/tasks/skel {"expire":300}']);
});

// A Sprite sleeps again as soon as a webhook delivery is answered, before the poll it asked
// for has run. This hold is apart from the daemon's own, which it never lets go of.
test("a webhook delivery holds the Sprite for a minute, under a hold of its own", async () => {
  await holdAwhile(60, socket);
  expect(calls).toEqual(['PUT /v1/tasks/skel-webhook {"expire":60}']);
});
