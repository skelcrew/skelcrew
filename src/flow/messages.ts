// A builder's messages waiting to be typed in: the lead's sc tell, and what Skelcrew tells it of
// its PR's events. They wait in the database until the builder can take them, so none is
// dropped while it is busy or stopped, or while the daemon restarts, and sc ps and the sidebar
// can count them.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { agentRuns } from "../agents/tmux.ts";
import { draftReason, midTurn, typeInto, whyBusy } from "../agents/typing.ts";
import { markSeen } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { noteForLead, typeLeadNotes } from "./lead.ts";
import {
  builderHarness,
  log,
  readThread,
  record,
  repositoryOf,
  type Thread,
  threadName,
} from "./thread.ts";

// The PR's reviews and comments a message carries, for the forge to mark seen once it is typed.
const TypedIn = z.array(z.object({ kind: z.enum(["review", "comment"]), id: z.string() }));

// One waiting message, as the database keeps it. `sender` is the lead, Skelcrew telling of the
// PR's events, or Skelcrew's reviewer with its review's changes. `text` is what is typed in,
// `said` the lead's own words, or for Skelcrew's messages what they tell, for the thread's log.
// `pasted` is whether it sits at the builder's prompt, left unsent for a question.
const Message = z.object({
  id: z.number(),
  folder: z.string(),
  sender: z.enum(["lead", "skelcrew", "review"]),
  text: z.string(),
  said: z.string(),
  at: z.number(),
  noted: z.coerce.boolean(),
  typed_in: z.string().transform((saved) => TypedIn.parse(JSON.parse(saved))),
  pasted: z.coerce.boolean(),
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
// sidebar: its waiting messages, and a review's changes saved but not yet among them, as when
// the daemon starts again.
export function messagesWaiting(db: Database, thread: Thread): number {
  const counted = (sql: string) =>
    z.object({ count: z.number() }).parse(db.query(sql).get(thread.folder)).count;
  const count = counted("SELECT COUNT(*) AS count FROM messages WHERE folder = ?");
  const reviews = counted(
    "SELECT COUNT(*) AS count FROM messages WHERE folder = ? AND sender = 'review'",
  );
  return count + (thread.telling !== null && reviews === 0 ? 1 : 0);
}

// Returns how many messages wait for a builder, in words, such as "1 message waiting", or
// nothing when none does, for sc ps and the sidebar.
export const waitingText = (count: number) =>
  count === 0 ? "" : `${count} message${count === 1 ? "" : "s"} waiting`;

// The reason a message waits for a builder whose session isn't there or has ended.
const notRunning = "its builder isn't running";

// How long a working or waiting thread's builder may be missing while messages wait for it
// before the thread needs you, in milliseconds. The daemon brings builders back as it starts,
// which takes a few seconds, and a message saved meanwhile must not flag it.
const missingFor = 10_000;

// When each thread's builder was first found missing while messages waited, by its folder.
const missingSince = new Map<string, number>();

// Has a working or waiting thread need you once its builder has been missing a while with
// messages waiting, as nothing else would bring it back, such as a session that ended while a
// review's changes waited. Its status becomes waiting, as no builder works on it.
function noteMissing(db: Database, tmux: string, thread: Thread, why: string): void {
  if (why !== notRunning) return void missingSince.delete(thread.folder);
  const since = missingSince.get(thread.folder) ?? Date.now();
  missingSince.set(thread.folder, since);
  if (thread.needs_you || Date.now() - since < missingFor) return;
  const count = messagesWaiting(db, thread);
  const wait = count === 1 ? "a message waits" : `${count} messages wait`;
  const missing = `${notRunning}, so ${wait} for it`;
  record(db, thread.folder, { needs_you: true, status: "waiting" }, missing);
  typeLeadNotes(db, tmux);
}

// Returns why the thread's builder can't take a message right now, in plain words, or empty
// text when it can. A stopped builder keeps its messages for when sc start brings it back. One
// asking you a question waits too, as typing would answer it for you.
export async function whyWaiting(tmux: string, thread: Thread): Promise<string> {
  if (thread.status !== "working" && thread.status !== "waiting")
    return `the thread is ${thread.status}`;
  if (!agentRuns(tmux, thread.folder)) return notRunning;
  if (thread.asking) return "it is asking the human a question";
  return whyBusy(tmux, thread.folder, builderHarness(thread).marks);
}

// Saves a message for the thread's builder and has the daemon type it in as soon as the builder
// can take it. Skelcrew's own message isn't saved twice while the same one still waits, such as
// a conflict found again after a submit, or a review's changes saved again as the daemon starts. The reviews and comments the second one carries join
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
  const same = sender === "lead" ? null : Message.nullable().parse(query.get(folder, sender, text));
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
// logged: the builder already has them. A review's changes are no longer saved on the thread,
// unless a newer review's are there by then.
function afterTyped(db: Database, folder: string, message: Message): void {
  const thread = readThread(db, folder);
  if (message.sender === "review") {
    if (thread.telling === message.text)
      record(db, folder, { telling: null }, "typed the review into the builder");
    return;
  }
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

// The attempt under way for each thread, by its folder, with what cancels it and what settles
// once it ends. A cancelled attempt stays here until it ends, so no second one starts while it
// may still be pressing Enter on a message it pasted, and type that message again.
const delivering = new Map<string, { cancel: AbortController; ended: Promise<void> }>();

// Types the thread's waiting messages into its builder, oldest first, while it can take them,
// and returns once none is left or it can't. The ones left wait for the next attempt.
async function deliver(db: Database, tmux: string, folder: string, signal: AbortSignal) {
  while (true) {
    const message = oldest(db, folder);
    if (message === null || signal.aborted) return;
    const thread = readThread(db, folder);
    const waits = await whyWaiting(tmux, thread);
    if (signal.aborted) return;
    if (thread.status === "working" || thread.status === "waiting")
      noteMissing(db, tmux, thread, waits);
    // A draft that is this message, left unsent for a question, is sent now, with Enter alone.
    // A bare prompt means a person sent or cleared it, so a draft after that is theirs.
    if (waits === "" && message.pasted)
      db.run("UPDATE messages SET pasted = 0 WHERE id = ?", [message.id]);
    const unsent = waits === "" ? false : message.pasted;
    const why = waits === draftReason && unsent ? "" : waits;
    if (why !== "") return noteLate(db, tmux, thread, why);
    // The builder looked ready a moment ago, so typing shouldn't wait long. If it does, the
    // message stays saved for the next attempt.
    const { marks } = builderHarness(thread);
    const waitsFor = { timeout: 10_000, signal, unsent };
    const typed = await typeInto(tmux, folder, marks, message.text, waitsFor);
    // Saved, so the draft it left is known for this message's even after a restart.
    if (typed === "left unsent")
      db.run("UPDATE messages SET pasted = 1 WHERE id = ?", [message.id]);
    if (typed !== "typed") return;
    // Read again, as an identical comment that came while it was typed joined it, and needs
    // marking seen too. Deleted by its id even when this attempt was cancelled while pasting, as
    // the message went in. Ids are never used again, so a message a new round dropped meanwhile
    // takes no other.
    const typedIn = Message.nullable().parse(
      db.query("SELECT * FROM messages WHERE id = ?").get(message.id),
    );
    db.run("DELETE FROM messages WHERE id = ?", [message.id]);
    afterTyped(db, folder, typedIn ?? message);
  }
}

// Starts typing the thread's waiting messages into its builder, unless that is under way
// already, and returns at once. A failure, such as the session ending, is logged, and the
// messages wait for the next attempt.
export function deliverMessages(db: Database, tmux: string, folder: string): void {
  if (delivering.has(folder)) return;
  const cancel = new AbortController();
  const ended = deliver(db, tmux, folder, cancel.signal)
    .catch((error) => console.log(`couldn't type into ${folder}'s builder: ${errorText(error)}`))
    .finally(() => {
      if (delivering.get(folder) === attempt) delivering.delete(folder);
    });
  const attempt = { cancel, ended };
  delivering.set(folder, attempt);
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
// check or a merge conflict, and the review's changes, as a new round makes them about an older
// commit. A conflict still there is found and told again. The lead's messages stay, and so do
// those carrying a person's review or comment on the PR, as people's words stay true whatever
// the commit, and one left pasted at the prompt, as it would block the next as a draft. Typing
// under way is cancelled first, as it may be typing one of them, and starts again with what is
// left once it has ended. Notices still being prepared learn of the drop by noticeRound.
export function dropOldEvents(db: Database, tmux: string, folder: string): void {
  roundsDropped.set(folder, noticeRound(folder) + 1);
  const ended = delivering.get(folder)?.ended ?? Promise.resolve();
  stopDelivering(db, folder, false);
  const rows = db
    .query("SELECT * FROM messages WHERE folder = ? AND sender IN ('skelcrew', 'review')")
    .all(folder);
  for (const message of z.array(Message).parse(rows))
    if (message.typed_in.length === 0 && !message.pasted)
      db.run("DELETE FROM messages WHERE id = ?", [message.id]);
  ended.then(() => deliverMessages(db, tmux, folder));
}

// How many times each thread's notices were dropped for a new round, by its folder.
const roundsDropped = new Map<string, number>();

// Returns how many times the thread's notices were dropped for a new round. Telling the builder
// of events reads it before fetching what it tells, which takes a while, and again before
// saving it: a notice prepared across a drop is about an older commit, so it isn't saved.
export const noticeRound = (folder: string) => roundsDropped.get(folder) ?? 0;

// Cancels typing under way into the thread's builder, for a stop, a merge, sc rm or a question
// it asked you, so nothing is typed into it afterwards. Its messages stay saved, unless `drop`,
// for a thread that ended.
// The attempt stays known until it ends, so no other starts meanwhile.
// `reason` is forQuestion for a question, which leaves a message already pasted unsent.
export function stopDelivering(db: Database, folder: string, drop: boolean, reason?: string): void {
  delivering.get(folder)?.cancel.abort(reason);
  if (drop) db.run("DELETE FROM messages WHERE folder = ?", [folder]);
}
