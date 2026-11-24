// What a CI test run has running, for when it hangs: the file and test each worker is on, and
// for how long, from the notes scripts/running.ts leaves, then the machine's process tree.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const Note = z.object({
  file: z.string(),
  fileSince: z.number(),
  test: z.string().nullable(),
  testSince: z.number(),
});
export type Running = z.infer<typeof Note>;

// Returns what each worker still running is on, from the notes in `folder`. A worker that ended
// left its last note, and a note being written can't be read yet: both are left out.
export function running(folder: string): Running[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder).flatMap((worker) => {
    try {
      process.kill(Number(worker), 0);
      return [Note.parse(JSON.parse(readFileSync(join(folder, worker), "utf8")))];
    } catch {
      return [];
    }
  });
}

// Returns whether a file has run far past the seconds test/times.json recorded for it: twice
// that, and two minutes more at least, as a busy machine can make any file slower. A file with
// no recorded time counts as instant.
export function overdue(file: Running, recorded: number | undefined, now: number): boolean {
  const seconds = recorded ?? 0;
  return now - file.fileSince > 1000 * Math.max(2 * seconds, seconds + 120);
}

// Returns, for the run's log, each worker's file and test with how long it has run, then the
// process tree, which shows what a hung test waits on.
export function whatRuns(files: Running[], now: number): string {
  const since = (at: number) => `${Math.round((now - at) / 1000)} s`;
  const lines = files.map(
    ({ file, fileSince, test, testSince }) =>
      `  ${file} for ${since(fileSince)}, ${test === null ? "in a hook or an unnamed test" : `in "${test}" for ${since(testSince)}`}`,
  );
  const ps = Bun.spawnSync(["ps", "-ef", "--forest"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const tree = ps.success ? ps.stdout.toString() : `ps failed: ${ps.stderr.toString()}`;
  return `${lines.join("\n")}\n\nThe processes running:\n${tree}`;
}
