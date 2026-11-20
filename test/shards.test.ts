// Splitting the test files into CI's shards by the time each took, so the shards end together.
import { expect, test } from "bun:test";
import { shardFiles } from "../scripts/shards.ts";

// The shards of a split, each with its files and their total time.
function split(files: string[], times: Record<string, number>, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const mine = shardFiles(files, times, i + 1, count);
    return { files: mine, total: mine.reduce((sum, file) => sum + (times[file] ?? 0), 0) };
  });
}

test("every file runs in exactly one shard", () => {
  const files = Array.from({ length: 30 }, (_, i) => `test/f${i}.test.ts`);
  const times = Object.fromEntries(files.map((file, i) => [file, (i * 7) % 11]));
  const shards = split(files, times, 4);
  expect(shards.flatMap((shard) => shard.files).toSorted()).toEqual(files.toSorted());
});

test("the slowest files go to different shards, and the quick ones even out the rest", () => {
  const times = {
    "test/a.test.ts": 100,
    "test/b.test.ts": 90,
    "test/c.test.ts": 80,
    "test/d.test.ts": 70,
    "test/e.test.ts": 40,
    "test/f.test.ts": 30,
    "test/g.test.ts": 20,
    "test/h.test.ts": 10,
  };
  const shards = split(Object.keys(times), times, 4);
  expect(shards.map((shard) => shard.files[0])).toEqual([
    "test/a.test.ts",
    "test/b.test.ts",
    "test/c.test.ts",
    "test/d.test.ts",
  ]);
  expect(shards.map((shard) => shard.total)).toEqual([110, 110, 110, 110]);
});

test("a shard lists its slowest file first, so its workers start on it", () => {
  const times = { "test/a.test.ts": 1, "test/b.test.ts": 5, "test/c.test.ts": 3 };
  expect(shardFiles(Object.keys(times), times, 1, 1)).toEqual([
    "test/b.test.ts",
    "test/c.test.ts",
    "test/a.test.ts",
  ]);
});

// A new file has no time yet. It counts as a middling one rather than as instant, which would
// pile every new file into one shard.
test("files with no time yet spread over the shards", () => {
  const times = { "test/a.test.ts": 10, "test/b.test.ts": 10 };
  const files = ["test/a.test.ts", "test/b.test.ts", "test/new1.test.ts", "test/new2.test.ts"];
  const shards = split(files, times, 2).map((shard) => shard.files.length);
  expect(shards).toEqual([2, 2]);
});
