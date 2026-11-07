// What skel's tests share: finding skel's source files and waiting for something to happen.
import { join } from "node:path";

// Returns the path of a file in src/, or of src/ itself, for a test that runs skel or hands
// its code to a process of its own.
export const source = (file = "") => join(import.meta.dir, "..", "src", file);

// Waits until `done` holds, for what a daemon or a session does in its own time, looking every
// `every` milliseconds. Past `timeout` it throws, naming `what` if given. `what` is a function
// so a test can show what is on screen at that moment, and pays for that only on failure.
export async function until(
  done: () => boolean,
  options: { timeout?: number; every?: number; what?: () => string } = {},
): Promise<void> {
  const { timeout = 10_000, every = 50, what } = options;
  const deadline = Date.now() + timeout;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(what ? `gave up waiting for ${what()}` : "gave up waiting");
    await Bun.sleep(every);
  }
}
