// Splits the test files into CI's shards by how long each took, so the shards end close together.
// Bun's own --shard splits by file name, which leaves where the slowest files land to chance.
import { z } from "zod";

// How long each test file took in CI, in seconds, by its path from the repository's root, as
// test/times.json keeps them.
export const timesOfFiles = z.record(z.string(), z.number().nonnegative());

// Returns the files of shard `index` of `count`, counted from 1, slowest first, so the shard's
// workers start on the long ones and the quick ones fill in around them. Each file
// goes, slowest first, to the shard with the least time so far, so no shard gets two of the
// slowest files while another gets none. A file with no time, such as a new one, counts as the
// middle of the known times, as most files are quick and a guess too high or low costs little.
export function shardFiles(
  files: string[],
  times: Record<string, number>,
  index: number,
  count: number,
): string[] {
  const known = Object.values(times).toSorted((a, b) => a - b);
  const guess = known[Math.floor(known.length / 2)] ?? 1;
  const timeOf = (file: string) => times[file] ?? guess;
  // Ties go by name, so every shard of a run makes the same split.
  const slowestFirst = files.toSorted((a, b) => timeOf(b) - timeOf(a) || a.localeCompare(b));
  const totals: number[] = Array.from({ length: count }, () => 0);
  const mine: string[] = [];
  for (const file of slowestFirst) {
    const least = totals.indexOf(Math.min(...totals));
    totals[least] = (totals[least] ?? 0) + timeOf(file);
    if (least === index - 1) mine.push(file);
  }
  return mine;
}
