// What each working builder is doing, for its row in the sidebar: the step it is on, the tokens
// it used and how far through its plan it is, read from its harness's conversation file. The
// sidebar looks each second, but a file is read at most every 10 seconds, and only what was
// added since the last read.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { noProgress, type Progress } from "../agents/progress.ts";
import { builderHarness, cloneOf, type Thread } from "../flow/thread.ts";

// What was read of a builder's conversation file: which file, if it has one yet, how far, what
// that said, and when it was last looked at. `skipping` says the read stopped inside a line too
// long to read whole, whose rest the next read passes over.
type Read = {
  file: string | null;
  offset: number;
  skipping: boolean;
  progress: Progress;
  at: number;
};
// The reads, by the thread's folder, kept for as long as the sidebar runs.
const reads = new Map<string, Read>();
// How long what was read is shown before the file is looked at again.
const every = 10_000;
// The most read at once, so a huge file is read over a few looks rather than all in one. A line
// longer than this is passed over, as no harness writes what the sidebar shows in one so long.
const most = 16 * 1024 * 1024;

// Returns what the thread's builder's conversation says of its work so far, at a moment in
// milliseconds, with each part null while the harness hasn't given it. Only the builder's: a
// review's conversation is saved elsewhere, or not at all.
export function builderProgress(thread: Thread, now: number): Progress {
  // A look less than 10 seconds ago is still good enough. A clock set back looks again.
  const before = reads.get(thread.folder);
  if (before && now - before.at < every && now >= before.at) return before.progress;
  // Another file, such as a new conversation after the old one couldn't be brought back, is
  // read from its start. A folder that can't be looked in, such as one the agent made
  // unreadable, means no file: the sidebar must go on drawing.
  const harness = builderHarness(thread);
  let file: string | null = null;
  try {
    file = thread.session && harness.conversation(thread.folder, cloneOf(thread), thread.session);
  } catch {
    file = null;
  }
  file ||= null;
  let read: Read =
    before && before.file === file
      ? { ...before, at: now }
      : { file, offset: 0, skipping: false, progress: noProgress, at: now };
  // Reads what was added since. A file that shrank was written anew, so it is read again from
  // its start. The file is the agent's to write, so a reader that fails on what it finds there
  // leaves the progress as it was rather than end the sidebar.
  const added = file ? readAdded(file, read.offset, read.skipping) : null;
  if (file && added) {
    const { end: offset, skipping } = added;
    try {
      const progress = harness.progress(added.lines, added.shrank ? noProgress : read.progress);
      read = { file, offset, skipping, progress, at: now };
    } catch {
      read = { ...read, offset, skipping };
    }
  }
  reads.set(thread.folder, read);
  return read.progress;
}

// Returns the whole lines added to a file past `offset`, and where they end, or null when the
// file isn't there, isn't a plain file or can't be read. A last line still being written is left
// for the next read. `shrank` says the file is now shorter than `offset`, and the lines are then
// from its start. The agent can write in the folder, so a link or a pipe is never read: opening
// a pipe would wait forever.
// A line longer than a whole read would leave the next read where this one began, forever, so
// it is passed over: `skipping` says a read is inside such a line, and the next read drops what
// is left of it.
function readAdded(
  file: string,
  offset: number,
  skipping: boolean,
): { lines: string[]; end: number; shrank: boolean; skipping: boolean } | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const shrank = stat.size < offset;
    const from = shrank ? 0 : offset;
    const buffer = Buffer.alloc(Math.min(stat.size - from, most));
    const read = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from));
    // Past the rest of a line too long to read, when a read stopped inside one.
    let start = 0;
    if (skipping && !shrank) {
      start = read.indexOf(0x0a) + 1;
      if (start === 0) return { lines: [], end: from + read.length, shrank, skipping: true };
    }
    // Up to the last newline. A whole read with none is inside a line too long to read.
    const whole = read.lastIndexOf(0x0a) + 1;
    if (whole === 0 && read.length === most)
      return { lines: [], end: from + read.length, shrank, skipping: true };
    const lines = whole > start ? read.subarray(start, whole).toString("utf8").split("\n") : [];
    return { lines, end: from + Math.max(whole, start), shrank, skipping: false };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Returns a count of tokens in the fewest letters: 850, then 48k, then 1.2M, with a decimal only
// below ten. Rounded down, so it never shows more than was used.
export function tokenText(tokens: number): string {
  const short = (value: number, unit: string) =>
    value < 10 ? `${Math.floor(value * 10) / 10}${unit}` : `${Math.floor(value)}${unit}`;
  if (tokens < 1000) return `${tokens}`;
  return tokens < 1_000_000 ? short(tokens / 1000, "k") : short(tokens / 1_000_000, "M");
}
