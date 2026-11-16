// The queue that keeps work such as reviews to a limit at once, the rest waiting in order.
import { expect, test } from "bun:test";
import { Queue } from "../src/flow/queue.ts";

// Work that runs until the test ends it, noting when it starts.
function held(started: string[], name: string) {
  let end = () => {};
  const done = new Promise<void>((resolve) => {
    end = resolve;
  });
  const work = async () => {
    started.push(name);
    await done;
    return name;
  };
  return { work, end };
}

// Lets the queue start what it can.
const settle = () => Bun.sleep(5);

test("runs at most the limit at once, and starts the next as one ends", async () => {
  const queue = new Queue();
  const started: string[] = [];
  const signal = new AbortController().signal;
  const all = ["a", "b", "c", "d"].map((name, order) => ({ ...held(started, name), order }));
  const results = all.map(({ work, order }) => queue.run({ limit: 2, order, signal }, work));
  await settle();
  expect(started).toEqual(["a", "b"]);
  all[1]?.end();
  expect(await results[1]).toBe("b");
  await settle();
  expect(started).toEqual(["a", "b", "c"]);
  for (const { end } of all) end();
  expect(await Promise.all(results)).toEqual(["a", "b", "c", "d"]);
});

test("says whether new work would have to wait", async () => {
  const queue = new Queue();
  const started: string[] = [];
  const signal = new AbortController().signal;
  expect(queue.full(1)).toBe(false);
  const first = held(started, "first");
  const running = queue.run({ limit: 1, order: 1, signal }, first.work);
  expect(queue.full(1)).toBe(true);
  expect(queue.full(2)).toBe(false);
  first.end();
  await running;
  expect(queue.full(1)).toBe(false);
});

test("waiting work starts by its order, not by when it joined", async () => {
  const queue = new Queue();
  const started: string[] = [];
  const signal = new AbortController().signal;
  const first = held(started, "first");
  const running = queue.run({ limit: 1, order: 1, signal }, first.work);
  // Work brought back after a restart joins with the time it first joined, which can be
  // earlier than work already waiting.
  const later = held(started, "later");
  const earlier = held(started, "earlier");
  const waiting = [
    queue.run({ limit: 1, order: 30, signal }, later.work),
    queue.run({ limit: 1, order: 20, signal }, earlier.work),
  ];
  await settle();
  expect(started).toEqual(["first"]);
  first.end();
  later.end();
  earlier.end();
  await Promise.all([running, ...waiting]);
  expect(started).toEqual(["first", "earlier", "later"]);
});

test("cancelled work leaves the queue without taking a place", async () => {
  const queue = new Queue();
  const started: string[] = [];
  const signal = new AbortController().signal;
  const first = held(started, "first");
  const running = queue.run({ limit: 1, order: 1, signal }, first.work);
  const cancel = new AbortController();
  const dropped = queue.run({ limit: 1, order: 2, signal: cancel.signal }, held(started, "x").work);
  const next = held(started, "next");
  const after = queue.run({ limit: 1, order: 3, signal }, next.work);
  cancel.abort();
  expect(dropped).rejects.toThrow("cancelled");
  first.end();
  next.end();
  await Promise.all([running, after]);
  expect(started).toEqual(["first", "next"]);
});

test("work that fails gives its place back", async () => {
  const queue = new Queue();
  const signal = new AbortController().signal;
  const failing = queue.run({ limit: 1, order: 1, signal }, async () => {
    throw new Error("broke");
  });
  expect(failing).rejects.toThrow("broke");
  expect(await queue.run({ limit: 1, order: 2, signal }, async () => "ran")).toBe("ran");
});

test("work already cancelled never runs", async () => {
  const queue = new Queue();
  const cancel = new AbortController();
  cancel.abort();
  let ran = false;
  const run = queue.run({ limit: 1, order: 1, signal: cancel.signal }, async () => {
    ran = true;
  });
  expect(run).rejects.toThrow("cancelled");
  await settle();
  expect(ran).toBe(false);
});
