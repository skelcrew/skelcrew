// Old logs must stay readable. v1-events.jsonl holds real events, written
// by the simulator in the version 1 shape, one per line.
//
// Until Skelcrew first runs on a real repo, no real log exists, so an
// event's shape may still change. The fixture is then regenerated in the
// same commit, and the commit says so. From the first real run on, it is
// never edited or regenerated: a change that breaks this test needs a way to
// read old events, not a new fixture.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TaskId } from "../core/ids";
import { parseTaskEvent } from "./schema";
import { EventStore } from "./store";

const lines = readFileSync(join(import.meta.dir, "fixtures", "v1-events.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line !== "");

test("every version 1 event still reads back", () => {
  expect(lines.length).toBe(56);
  for (const line of lines) {
    const parsed = parseTaskEvent(JSON.parse(line));
    expect(parsed.ok ? "ok" : parsed.reason).toBe("ok");
  }
});

test("version 1 events still rebuild the tasks they described", () => {
  const store = EventStore.open(":memory:");
  for (const line of lines) {
    const parsed = parseTaskEvent(JSON.parse(line));
    if (!parsed.ok) throw new Error(parsed.reason);
    const saved = store.appendTask([parsed.value]);
    if (!saved.ok) throw new Error(saved.reason);
  }
  const loaded = store.loadTasks();
  if (!loaded.ok) throw new Error(loaded.reason);

  // #1 asked a question, ran out of attempts, was retried and merged.
  expect(loaded.tasks.get(TaskId.parse(1))).toMatchObject({ phase: "done" });
  // #2 waited for merge approval twice, merged after a conflict, and was
  // reverted. A new spec agent redid its spec with the reason as its note,
  // which cleared the note, and the spec now waits for approval.
  expect(loaded.tasks.get(TaskId.parse(2))).toMatchObject({
    phase: "spec",
    note: null,
    step: { kind: "awaiting_approval" },
  });
  // #3 was never asked for a spec.
  expect(loaded.tasks.get(TaskId.parse(3))).toMatchObject({ phase: "idea" });
});
