// Check slots: sc check runs the repository's whole test suite only while fewer than
// `limits.checks` suites run at once on this machine, as many at once slow every agent down.
import type { Socket } from "node:net";
import { checkLimit } from "../config.ts";
import { errorText } from "../format.ts";
import { Queue } from "./queue.ts";

// The one queue of checks the daemon keeps, for every repository on this machine.
const checks = new Queue();

// Who holds a check slot, such as APP-12/reviewer or you, and in which repository, as
// owner/name.
type Holder = { holder: string; repository: string };

const holderLooked = 5_000;

// Who holds each slot taken now, and since when, so sc ps can say what keeps a check waiting in
// line.
const held = new Map<Socket, Holder & { since: number }>();

// The slots are counted only here, in the daemon. A daemon that restarts starts counting from
// none, and a suite that was running finishes on its own beside the new ones. A restart is rare,
// and the cost is a short overlap, never a wrong result.

// Answers an sc check on its connection, given the repository's test commands and who asks.
// Once a slot is free it sends the commands, and the caller runs them in its own folder. The
// caller holds the slot while its connection stays open, and closing it, however it ends, frees
// the slot. So a check that was killed never keeps its place. A builder or reviewer that has
// ended, as `runs` tells, gives back its place or slot too, though its connection stays open.
// A caller over the limit is first sent its place in line. A repository configured with no
// tests runs none, so it takes no slot.
export function holdCheckSlot(
  connection: Socket,
  test: string[] | undefined,
  holder: Holder & { runs: () => boolean },
): void {
  const send = (line: object) => connection.write(`${JSON.stringify(line)}\n`);
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
  const closed = new AbortController();
  const looking = setInterval(() => {
    if (!holder.runs()) connection.destroy();
  }, holderLooked);
  connection.on("close", () => {
    clearInterval(looking);
    closed.abort();
  });
  const heldUntilClosed = () =>
    new Promise<void>((done) => {
      if (closed.signal.aborted) return done();
      closed.signal.addEventListener("abort", () => done(), { once: true });
    });
  let limit: number;
  try {
    limit = checkLimit();
  } catch (error) {
    connection.end(`${JSON.stringify({ error: errorText(error) })}\n`);
    return;
  }
  if (checks.full(limit)) send({ queued: checks.inLine() + 1 });
  checks
    .run({ limit, order: Date.now(), signal: closed.signal }, async () => {
      held.set(connection, {
        holder: holder.holder,
        repository: holder.repository,
        since: Date.now(),
      });
      send({ test });
      try {
        await heldUntilClosed();
      } finally {
        held.delete(connection);
      }
    })
    .catch(() => {});
}

// Returns who holds the check slots taken now, and since when, oldest first, for sc ps.
export function slotHolders(): (Holder & { since: number })[] {
  return [...held.values()];
}
