// Check slots: sc check runs the repository's whole test suite only while fewer than
// `limits.checks` suites run at once on this machine, as many at once slow every agent down.
import type { Socket } from "node:net";
import { checkLimit } from "../config.ts";
import { errorText } from "../say.ts";
import { Queue } from "./queue.ts";

// The one queue of checks the daemon keeps, for every repository on this machine.
const checks = new Queue();

// Answers an sc check on its connection, given the repository's test commands. Once a slot is
// free it sends the commands, and the caller runs them in its own folder. The caller holds the
// slot while its connection stays open, and closing it, however it ends, frees the slot. So a
// check that was killed never keeps its place. A caller over the limit is first sent its place
// in line. A repository configured with no tests runs none, so it takes no slot.
export function holdCheckSlot(connection: Socket, test: string[] | undefined): void {
  const send = (line: object) => connection.write(`${JSON.stringify(line)}\n`);
  // Without a test command there is nothing to run, and Skelcrew never guesses one.
  if (test === undefined) {
    connection.end(
      `${JSON.stringify({ error: "no test command is configured for this repository. Ask the lead which to use with sc tell lead." })}\n`,
    );
    return;
  }
  if (test.length === 0) {
    connection.end(`${JSON.stringify({ test })}\n`);
    return;
  }
  // The caller leaving, before or after its turn, ends its wait or frees its slot.
  const closed = new AbortController();
  connection.on("close", () => closed.abort());
  let limit: number;
  try {
    limit = checkLimit();
  } catch (error) {
    connection.end(`${JSON.stringify({ error: errorText(error) })}\n`);
    return;
  }
  // Said only when it waits, with how many wait ahead of it counted in.
  if (checks.full(limit)) send({ queued: checks.inLine() + 1 });
  const order = Date.now();
  checks
    .run({ limit, order, signal: closed.signal }, () => {
      send({ test });
      return new Promise<void>((done) => {
        if (closed.signal.aborted) return done();
        closed.signal.addEventListener("abort", () => done(), { once: true });
      });
    })
    // A caller that left while it waited never ran: there is no one to tell.
    .catch(() => {});
}
