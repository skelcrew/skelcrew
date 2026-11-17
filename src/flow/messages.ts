// A builder's messages waiting to be typed in: the lead's sc tell, and what Skelcrew tells it of
// its PR's events. They wait in the database until the builder can take them, so none is
// dropped while it is busy or stopped, or while the daemon restarts, and sc ps and the sidebar
// can count them.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { agentRuns } from "../agents/tmux.ts";
import { midTurn, typeInto, whyBusy } from "../agents/typing.ts";
import { markSeen } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { noteForLead } from "./lead.ts";
import {
  builderHarness,
  log,
  readThread,
  record,
  repositoryOf,
  type Thread,
  threadName,
  turnEnded,
} from "./thread.ts";

// The PR's reviews and comments a message carries, for the forge to mark seen once it is typed.
const TypedIn = z.array(z.object({ kind: z.enum(["review", "comment"]), id: z.string() }));

// One waiting message, as the database keeps it. `text` is what is typed in, `said` the lead's
// own words, or for Skelcrew's messages what they tell, for the thread's log.
const Message = z.object({
  id: z.number(),
  folder: z.string(),
  sender: z.enum(["lead", "skelcrew"]),
  text: z.string(),
  said: z.string(),
  at: z.number(),
  noted: z.coerce.boolean(),
  typed_in: z.string().transform((saved) => TypedIn.parse(JSON.parse(saved))),
});
type Message = z.infer<typeof Message>;

// How long a lead's message may wait before the lead hears that it still does, and why.
const lateAfter = 10 * 60_000;

// Returns the thread's oldest waiting message, or null when none waits.
const oldest = (db: Database, folder: string) =>
  Message.nullable().parse(
    db.query("SELECT * FROM messages WHERE folder = ? ORDER BY id").get(folder),
  );

// Returns how many messages wait to be typed into the thread's builder, for sc ps and the
// sidebar: its waiting messages, and a review's changes not yet typed in.
export function messagesWaiting(db: Database, thread: Thread): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM messages WHERE folder = ?")
    .get(thread.folder);
  const { count } = z.object({ count: z.number() }).parse(row);
  return count + (thread.telling === null ? 0 : 1);
}

// Returns how many messages wait for a builder, in words, such as "1 message waiting", or
// nothing when none does, for sc ps and the sidebar.
export const waitingText = (count: number) =>
  count === 0 ? "" : `${count} message${count === 1 ? "" : "s"} waiting`;

// Returns why the thread's builder can't take a message right now, in plain words, or empty
// text when it can. A stopped builder keeps its messages for when sc start brings it back. One
// asking you a question waits too, as typing would answer it for you.
export async function whyWaiting(db: Database, tmux: string, thread: Thread): Promise<string> {
  if (thread.status !== "working" && thread.status !== "waiting")
    return `the thread is ${thread.status}`;
  if (!agentRuns(tmux, thread.folder)) return "its builder isn't running";
  if (thread.asking) return "it is asking the human a question";
  // Its hook can say its turn ended while the look at its screen is under way.
  const turnOver = () => readThread(db, thread.folder).turn_ended;
  return whyBusy(tmux, thread.folder, builderHarness(thread).marks, { turnOver });
}

// Saves a message for the thread's builder and has the daemon type it in as soon as the builder
// can take it. Skelcrew's own message isn't saved twice while the same one still waits, such as
// a conflict found again after a submit. The reviews and comments the second one carries join
// the waiting one, so each is still marked seen once it is typed in: two comments can say the
// same words.
export function queueMessage(
  db: Database,
  tmux: string,
  folder: string,
  message: Pick<Message, "sender" | "text" | "said" | "typed_in">,
): void {
  const { sender, text, said, typed_in } = message;
  const query = db.query("SELECT * FROM messages WHERE folder = ? AND sender = ? AND text = ?");
  const same =
    sender === "skelcrew" ? Message.nullable().parse(query.get(folder, sender, text)) : null;
  if (same === null)
    db.run(
      "INSERT INTO messages (folder, sender, text, said, at, typed_in) VALUES (?, ?, ?, ?, ?, ?)",
      [folder, sender, text, said, Date.now(), JSON.stringify(typed_in)],
    );
  else {
    const added = typed_in.filter(
      (event) => !same.typed_in.some((had) => had.kind === event.kind && had.id === event.id),
    );
    const joined = JSON.stringify([...same.typed_in, ...added]);
    db.run("UPDATE messages SET typed_in = ? WHERE id = ?", [joined, same.id]);
  }
  deliverMessages(db, tmux, folder);
}

// Does what follows a message once it is in the builder. A lead's message becomes a change to
// the thread's task, so its reviewer judges the builder by what the lead last said. It is kept
// only once typed, so the reviewer never sees what the builder didn't. Skelcrew's message has
// the forge mark the people's reviews and comments it carried seen, so they can see it on the
// PR. Not waited on, and a failure, such as from a plugin too old to know the question, is only
// logged: the builder already has them.
function afterTyped(db: Database, folder: string, message: Message): void {
  const thread = readThread(db, folder);
  if (message.sender === "lead") {
    const update: Thread["updates"][number] = { from: "lead", at: Date.now(), text: message.said };
    record(
      db,
      folder,
      { updates: [...thread.updates, update] },
      `the lead told its builder: ${message.said}`,
    );
    return;
  }
  log(db, thread, `typed into its builder: ${message.said}`);
  const { pr } = thread;
  if (pr === null) return;
  // The repository is looked up inside the promise, so one removed meanwhile is only logged.
  for (const { kind, id } of message.typed_in)
    Promise.resolve()
      .then(() => markSeen(db, repositoryOf(db, thread), { pr, kind, id }))
      .catch((error) =>
        console.log(
          `couldn't mark the ${kind} ${id} seen on ${threadName(db, thread)}'s PR: ${errorText(error)}`,
        ),
      );
}

// Tells the lead, once per message, that its messages to the thread's builder have waited 10
// minutes, naming the thread and why. For a builder mid-turn, it says the human can press Esc
// to end the turn. For any other reason Esc would do nothing, or throw away a question the human
// should answer. Every waiting message of the lead's counts, not only the next one to go in, as
// one can wait behind a message of Skelcrew's.
function noteLate(db: Database, tmux: string, thread: Thread, why: string) {
  const rows = db
    .query("SELECT * FROM messages WHERE folder = ? AND sender = 'lead' AND noted = 0 AND at <= ?")
    .all(thread.folder, Date.now() - lateAfter);
  const late = z.array(Message).parse(rows);
  if (late.length === 0) return;
  for (const { id } of late) db.run("UPDATE messages SET noted = 1 WHERE id = ?", [id]);
  const name = threadName(db, thread);
  const [yours, it] =
    late.length === 1 ? ["your message", "it"] : [`${late.length} of your messages`, "them"];
  const sooner = why.startsWith(midTurn)
    ? ` To have ${it} sooner, ask the human to press Esc in ${name}.`
    : "";
  noteForLead(
    db,
    tmux,
    thread,
    `${name}'s builder hasn't got ${yours} after 10 minutes: ${why}. Skelcrew types ${it} in once it can.${sooner}`,
  );
}

// The attempt under way for each thread, by its folder, with what cancels it.
const delivering = new Map<string, AbortController>();

// Types the thread's waiting messages into its builder, oldest first, while it can take them,
// and returns once none is left or it can't. The ones left wait for the next attempt.
async function deliver(db: Database, tmux: string, folder: string, signal: AbortSignal) {
  while (true) {
    const message = oldest(db, folder);
    if (message === null || signal.aborted) return;
    const thread = readThread(db, folder);
    const why = await whyWaiting(db, tmux, thread);
    if (signal.aborted) return;
    if (why !== "") return noteLate(db, tmux, thread, why);
    // The builder looked ready a moment ago, so typing shouldn't wait long. If it does, the
    // message stays saved for the next attempt.
    const { marks } = builderHarness(thread);
    const turnOver = () => readThread(db, folder).turn_ended;
    const typed = await typeInto(tmux, folder, marks, message.text, {
      timeout: 10_000,
      signal,
      turnOver,
    });
    if (!typed) return;
    // A new turn starts now, before its hook can say so, so the next message waits for it.
    turnEnded(db, folder, false);
    db.run("DELETE FROM messages WHERE id = ?", [message.id]);
    afterTyped(db, folder, message);
  }
}

// Starts typing the thread's waiting messages into its builder, unless that is under way
// already, and returns at once. A failure, such as the session ending, is logged, and the
// messages wait for the next attempt.
export function deliverMessages(db: Database, tmux: string, folder: string): void {
  if (delivering.has(folder)) return;
  const cancel = new AbortController();
  delivering.set(folder, cancel);
  deliver(db, tmux, folder, cancel.signal)
    .catch((error) => console.log(`couldn't type into ${folder}'s builder: ${errorText(error)}`))
    .finally(() => {
      if (delivering.get(folder) === cancel) delivering.delete(folder);
    });
}

// Starts typing into every builder that has messages waiting. The daemon calls it every few
// seconds, so a message reaches its builder soon after the builder can take it: after its
// turn, its question, sc start or the daemon's start.
export function deliverAllWaiting(db: Database, tmux: string): void {
  const rows = db.query("SELECT DISTINCT folder FROM messages").all();
  for (const { folder } of z.array(z.object({ folder: z.string() })).parse(rows))
    deliverMessages(db, tmux, folder);
}

// Drops Skelcrew's waiting messages that tell only of the thread's events, such as a failed
// check or a merge conflict, as a new round makes them about an older commit. A conflict still
// there is found and told again. The lead's messages stay, and so do those carrying a person's
// review or comment on the PR, as people's words stay true whatever the commit.
export function dropOldEvents(db: Database, folder: string): void {
  const rows = db
    .query("SELECT * FROM messages WHERE folder = ? AND sender = 'skelcrew'")
    .all(folder);
  for (const message of z.array(Message).parse(rows))
    if (message.typed_in.length === 0) db.run("DELETE FROM messages WHERE id = ?", [message.id]);
}

// Cancels typing under way into the thread's builder, for a stop, a merge or sc rm, so nothing
// is typed into it afterwards. Its messages stay saved, unless `drop`, for a thread that ended.
export function stopDelivering(db: Database, folder: string, drop: boolean): void {
  delivering.get(folder)?.abort();
  delivering.delete(folder);
  if (drop) db.run("DELETE FROM messages WHERE folder = ?", [folder]);
}
