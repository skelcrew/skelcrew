// The messages module: every message Skelcrew types into an agent goes through here, on the
// transport. It holds who may tell whom, the <skelcrew> tag around an agent's words, and each
// agent's queue. A builder's messages are the lead's sc tell and what Skelcrew tells it of its
// PR's events. They wait in the database until the builder can take them, so none is dropped
// while it is busy or stopped, or while the daemon restarts, and sc ps and the sidebar can count
// them. A lead's notes wait there too, until the lead has started and is idle, and the human
// isn't reading further up or typing in it.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { harnessNamed } from "../agents/harness.ts";
import { agentRuns, scrolledBack } from "../agents/sessions.ts";
import { deliver, draftReason, midTurn, type Typed, whyBusy } from "../agents/transport.ts";
import { markSeen } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { leadOf } from "./lead.ts";
import { repositories } from "./repo.ts";
import type { Caller } from "./requests.ts";
import {
  builderHarness,
  builderSession,
  log,
  readThread,
  record,
  repositoryOf,
  Thread,
  threadName,
} from "./thread.ts";

// A note waiting to be typed into a lead.
const Note = z.object({ id: z.number(), text: z.string() });

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

// Returns how many messages wait to be typed into the thread's builder, for sc ps, the list and
// the sidebar: its waiting messages, and a review's changes saved but not yet among them, as
// when the daemon starts again.
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
// nothing when none does, for sc ps, the list and the sidebar.
export const waitingText = (count: number) =>
  count === 0 ? "" : `${count} message${count === 1 ? "" : "s"} waiting`;

// The reason a message waits for a builder whose session isn't there or has ended.
const notRunning = "its builder isn't running";

// How long a working or waiting thread's builder may be missing while messages wait for it
// before the thread needs you, in milliseconds. The daemon brings builders back as it starts,
// which takes a few seconds, and a message saved meanwhile must not flag it. Tests set
// SKELCREW_MISSING_WAIT_MS shorter, so they don't each wait the whole ten seconds.
const missingFor = z.coerce
  .number()
  .min(0)
  .catch(10_000)
  .parse(process.env.SKELCREW_MISSING_WAIT_MS ?? 10_000);

// When each thread's builder was first found missing while messages waited, by its folder.
const missingSince = new Map<string, number>();

// Has a working or waiting thread need you once its builder has been missing a while with
// messages waiting, as nothing else would bring it back, such as a session that ended while a
// review's changes waited. Its status becomes waiting, as no builder works on it.
function noteMissing(db: Database, sessions: string, thread: Thread, why: string): void {
  if (why !== notRunning) return void missingSince.delete(thread.folder);
  const since = missingSince.get(thread.folder) ?? Date.now();
  missingSince.set(thread.folder, since);
  if (thread.needs_you || Date.now() - since < missingFor) return;
  const count = messagesWaiting(db, thread);
  const wait = count === 1 ? "a message waits" : `${count} messages wait`;
  const missing = `${notRunning}, so ${wait} for it`;
  record(db, thread.folder, { needs_you: true, status: "waiting" }, missing);
  typeLeadNotes(db, sessions);
}

// Returns why the thread's builder can't take a message right now, in plain words, or empty
// text when it can. A stopped builder keeps its messages for when sc start brings it back. One
// asking you a question waits too, as typing would answer it for you. One the status module
// knows to be working, from its harness's hooks, is mid-turn, even right after a message went
// in, before its status line shows. Otherwise its screen tells, whatever its state says: a
// turn can start with no hook, such as when a background task ends, and only the screen shows a
// person's draft. A builder whose host plugin is gone can't be reached at all.
export async function whyWaiting(db: Database, sessions: string, thread: Thread): Promise<string> {
  if (thread.status !== "working" && thread.status !== "waiting")
    return `the thread is ${thread.status}`;
  let session: Awaited<ReturnType<typeof builderSession>>;
  try {
    session = await builderSession(db, sessions, thread);
    if (!(await agentRuns(session.host, session.id))) return notRunning;
  } catch (error) {
    return errorText(error);
  }
  if (thread.asking) return "it is asking the human a question";
  if (thread.state === "working") return `${midTurn} (its harness says a turn runs)`;
  return whyBusy(session.host, session.id, builderHarness(thread).marks);
}

// Saves a message for the thread's builder and has the daemon type it in as soon as the builder
// can take it. Skelcrew's own message isn't saved twice while the same one still waits, such as
// a conflict found again after a submit, or a review's changes saved again as the daemon starts. The reviews and comments the second one carries join
// the waiting one, so each is still marked seen once it is typed in: two comments can say the
// same words.
export function queueMessage(
  db: Database,
  sessions: string,
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
  deliverMessages(db, sessions, folder);
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
function noteLate(db: Database, sessions: string, thread: Thread, why: string) {
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
    sessions,
    thread,
    `${name}'s builder hasn't got ${yours} after 10 minutes: ${why}. Skelcrew types ${it} in once it can.${sooner}`,
  );
}

// The attempt under way for each thread, by its folder, with what cancels it and what settles
// once it ends. A cancelled attempt stays here until it ends, so no second one starts while it
// may still be pressing Enter on a message it pasted, and type that message again. `typing`
// holds the ID of the message it is typing, if any: its paste may be on its way to a plugin's
// host, so the message is kept until the attempt ends.
type Attempt = { cancel: AbortController; ended: Promise<void>; typing: { id: number | null } };
const delivering = new Map<string, Attempt>();

// Types the thread's waiting messages into its builder, oldest first, while it can take them,
// and returns once none is left or it can't. The ones left wait for the next attempt. It notes
// in `typing` the message it is typing.
async function typeWaiting(
  db: Database,
  sessions: string,
  folder: string,
  signal: AbortSignal,
  typing: { id: number | null },
) {
  while (true) {
    const message = oldest(db, folder);
    if (message === null || signal.aborted) return;
    const thread = readThread(db, folder);
    const waits = await whyWaiting(db, sessions, thread);
    if (signal.aborted) return;
    if (thread.status === "working" || thread.status === "waiting")
      noteMissing(db, sessions, thread, waits);
    // A draft that is this message, left unsent for a question, is sent now, with Enter alone.
    // A bare prompt means a person sent or cleared it, so a draft after that is theirs.
    if (waits === "" && message.pasted)
      db.run("UPDATE messages SET pasted = 0 WHERE id = ?", [message.id]);
    const unsent = waits === "" ? false : message.pasted;
    const why = waits === draftReason && unsent ? "" : waits;
    if (why !== "") return noteLate(db, sessions, thread, why);
    // The builder looked ready a moment ago, so typing shouldn't wait long. If it does, the
    // message stays saved for the next attempt.
    const { marks } = builderHarness(thread);
    const { host, id } = await builderSession(db, sessions, thread);
    // Saved once pasted, so the draft it leaves is known for this message's even after a
    // restart, or when its Enter fails, as a plugin's host can fail it. The next attempt then
    // presses Enter alone rather than wait forever behind what looks like a person's draft.
    const pasted = () => db.run("UPDATE messages SET pasted = 1 WHERE id = ?", [message.id]);
    const waitsFor = { timeout: 10_000, signal, unsent, pasted };
    typing.id = message.id;
    const typed = await deliver(host, id, marks, message.text, waitsFor).finally(() => {
      typing.id = null;
    });
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

// How many ends of each thread's builder are under way, by its folder. Nothing is typed into it
// meanwhile: the end may still fail, and leave the builder running with its messages.
const paused = new Map<string, number>();

// Runs `end`, which ends the thread's builder, with typing into the builder paused all the while,
// and returns what it returns. Typing under way is cancelled first, and waited for: a message
// already pasted still gets its Enter, so the end never cuts a paste short, and nothing is typed
// once the end has started. The messages are kept,
// and typing goes on as before once `end` is over, such as after it failed.
export async function pauseDelivering<T>(
  db: Database,
  folder: string,
  end: () => Promise<T>,
): Promise<T> {
  paused.set(folder, (paused.get(folder) ?? 0) + 1);
  stopDelivering(db, folder, false);
  try {
    await delivering.get(folder)?.ended;
    return await end();
  } finally {
    const left = (paused.get(folder) ?? 1) - 1;
    if (left > 0) paused.set(folder, left);
    else paused.delete(folder);
  }
}

// Starts typing the thread's waiting messages into its builder, unless that is under way
// already, or paused while the builder is being ended, and returns at once. A failure, such as
// the session ending, is logged, and the messages wait for the next attempt. The promise it gives
// back settles once the attempt under way ends, so a test can tell when an attempt is over
// instead of waiting a fixed time.
export function deliverMessages(db: Database, sessions: string, folder: string): Promise<void> {
  const under = delivering.get(folder);
  if (under) return under.ended;
  if ((paused.get(folder) ?? 0) > 0) return Promise.resolve();
  const cancel = new AbortController();
  const typing: { id: number | null } = { id: null };
  const ended = typeWaiting(db, sessions, folder, cancel.signal, typing)
    .catch((error) => console.log(`couldn't type into ${folder}'s builder: ${errorText(error)}`))
    .finally(() => {
      if (delivering.get(folder) === attempt) delivering.delete(folder);
    });
  const attempt = { cancel, ended, typing };
  delivering.set(folder, attempt);
  return ended;
}

// Starts typing into every builder that has messages waiting. The daemon calls it every few
// seconds, so a message reaches its builder soon after the builder can take it: after its
// turn, its question, sc start or the daemon's start. The promise it gives back settles once
// every attempt it started has ended.
export async function deliverAllWaiting(db: Database, sessions: string): Promise<void> {
  const rows = db.query("SELECT DISTINCT folder FROM messages").all();
  const folders = z.array(z.object({ folder: z.string() })).parse(rows);
  await Promise.all(folders.map(({ folder }) => deliverMessages(db, sessions, folder)));
}

// Drops Skelcrew's waiting messages that tell only of the thread's events, such as a failed
// check or a merge conflict, and the review's changes, as a new round makes them about an older
// commit. A conflict still there is found and told again. The lead's messages stay, and so do
// those carrying a person's review or comment on the PR, as people's words stay true whatever
// the commit, and one left pasted at the prompt, as it would block the next as a draft. Typing
// under way is cancelled first, as it may be typing one of them, and starts again with what is
// left once it has ended. Notices still being prepared learn of the drop by noticeRound.
// The message the cancelled attempt is typing waits for it to end: its paste may already be on
// its way to a plugin's host, and deleting it then would leave its draft at the prompt unknown,
// blocking every later message. It is dropped once the attempt ends only if it never got in.
// Returns the texts dropped at once, and a promise of those dropped once the attempt ends, so
// what they told can be told again if it still holds.
export function dropOldEvents(
  db: Database,
  sessions: string,
  folder: string,
): { dropped: string[]; later: Promise<string[]> } {
  roundsDropped.set(folder, noticeRound(folder) + 1);
  const attempt = delivering.get(folder);
  const ended = attempt?.ended ?? Promise.resolve();
  const inFlight = attempt?.typing.id ?? null;
  stopDelivering(db, folder, false);
  // Drops each message that can go among the rows, and returns their texts.
  const drop = (rows: unknown[]) => {
    const dropped: string[] = [];
    for (const message of z.array(Message).parse(rows))
      if (message.typed_in.length === 0 && !message.pasted) {
        db.run("DELETE FROM messages WHERE id = ?", [message.id]);
        dropped.push(message.text);
      }
    return dropped;
  };
  const events = "folder = ? AND sender IN ('skelcrew', 'review')";
  const dropped = drop(
    db.query(`SELECT * FROM messages WHERE ${events} AND id IS NOT ?`).all(folder, inFlight),
  );
  // Once the attempt ends, the message it was typing is gone if it went in, and marked pasted if
  // it waits at the prompt. Otherwise it never got in, and is dropped too. Only it is looked at:
  // a message saved since belongs to the new round.
  const later = ended.then(() => {
    const left = drop(
      db.query(`SELECT * FROM messages WHERE ${events} AND id = ?`).all(folder, inFlight),
    );
    deliverMessages(db, sessions, folder);
    return left;
  });
  return { dropped, later };
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

// Types "continue" into a builder idle on its harness's usage limit, once it can take it, so it
// goes on with the turn the limit cut off. It goes around the builder's queue: the wake that
// calls it has its own rules, and gives up once anything else is typed to the builder. Throws
// after a minute without typing, or once `signal` aborts.
export async function typeContinue(
  db: Database,
  sessions: string,
  thread: Thread,
  signal: AbortSignal,
) {
  const { marks } = builderHarness(thread);
  const { host, id } = await builderSession(db, sessions, thread);
  return deliver(host, id, marks, "continue", { timeout: 60_000, signal });
}

// Returns an agent's text with any skelcrew tag removed, so it can't open or close Skelcrew's
// tag and pass what follows off as coming from someone else. A whole closing tag goes, and of
// any other only its start, which is enough to undo it. Spaces and case count for nothing, as
// </skelcrew > or < SKELCREW still read as a tag.
export function untagged(text: string): string {
  const tag = /<\s*\/\s*skelcrew\s*>|<\s*\/?\s*skelcrew/gi;
  let inside = text;
  // One pass isn't enough: removing the inner tag of </skel</skelcrew>crew> leaves a whole
  // </skelcrew>.
  while (inside.search(tag) >= 0) inside = inside.replace(tag, "");
  return inside;
}

// A control character other than a line break or a tab, which a paste would carry as typing.
const control = /(?![\n\t])\p{Cc}/gu;

// Returns text with each control character but a line break or a tab written as its code, such
// as &#x1b;. Everything typed into an agent is pasted, and the end of a bracketed paste in it
// would end the paste early and type the rest as if a person had, outside Skelcrew's tag.
export const controlsAsCodes = (text: string) =>
  text.replace(control, (code) => `&#x${(code.codePointAt(0) ?? 0).toString(16)};`);

// Returns the message wrapped in Skelcrew's tag, saying who it is from and the command to answer
// with, so the receiving agent never takes it for the human. The tag marks where it starts and
// ends, and the text inside stays plain, without tags or control characters of its own.
function wrapMessage(from: string, reply: string, text: string): string {
  return `<skelcrew from="${from}" reply="${reply}">\n${untagged(controlsAsCodes(text))}\n</skelcrew>`;
}

// Saves the lead's message for the thread's builder, to be typed in as soon as the builder can
// take it, and returns the line sc tell prints. Only a lead may tell a builder, and only one of
// its own repository's threads, so `from` is checked here whoever calls: a builder never steers
// another builder, and no lead reaches another repository. When it can't be typed in right away, the line
// says why, so the lead never waits without knowing. A message still waiting after 10 minutes
// brings the lead a note. Refuses a builder that isn't running rather than keeping the message,
// which could reach it long after it mattered. Refuses one asking you a question with its
// harness's question tool too: typing then would answer it for you. One that stopped without
// submitting may be told, as the lead can often answer what it waits on, and the message typed
// in ends its needing you.
export async function messageBuilder(
  db: Database,
  sessions: string,
  from: Caller,
  thread: Thread,
  text: string,
): Promise<string> {
  const name = threadName(db, thread);
  if (from === "you" || !("lead" in from))
    throw new Error(`Only a lead can tell ${name}'s builder.`);
  if (from.lead.owner !== thread.owner || from.lead.repo !== thread.repo)
    throw new Error(
      `${name} belongs to ${thread.owner}/${thread.repo}, so only that repository's lead can tell it.`,
    );
  // Refuse first: a stopped thread gets the command that brings it back, any other one without
  // a session gets its status.
  const live = thread.status === "working" || thread.status === "waiting";
  if (thread.status === "stopped")
    throw new Error(
      `${name}'s builder isn't running: the thread is stopped. sc start ${name} brings it back.`,
    );
  // A thread still setting up has no session yet, and one that failed or is done has none left.
  if (!live) throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  const { host, id } = await builderSession(db, sessions, thread);
  if (!(await agentRuns(host, id)))
    throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and typing now would answer it. Tell the human instead.`,
    );
  // Look before saving it, so the answer says whether it goes in now. Messages are typed in
  // order, so any still waiting go first.
  const ahead = messagesWaiting(db, thread);
  const why = await whyWaiting(db, sessions, thread);
  const message = wrapMessage("lead", "sc tell lead", text);
  queueMessage(db, sessions, thread.folder, {
    sender: "lead",
    text: message,
    said: text,
    typed_in: [],
  });
  if (why === "" && ahead === 0) return `Telling ${name}'s builder now: it is idle.`;
  const earlier = ahead === 1 ? "1 earlier message waits" : `${ahead} earlier messages wait`;
  const reasons = [why, ahead > 0 ? earlier : ""].filter((reason) => reason).join(", and ");
  return `${name}'s builder can't take it yet: ${reasons}. Skelcrew types it in once it can, and tells you if it still waits in 10 minutes.`;
}

// Has the daemon type a builder's message into its repository's lead, naming the thread it
// comes from and how to answer, and logs it in the thread's log. Returns at once, like any
// agent command. Only a builder may tell a lead, and only its own repository's: the lead is
// found from the thread in `from`, so no sender can pick another. A reviewer sends nothing.
// The thread keeps that its builder told the lead in this turn, so the turn's end doesn't send
// the lead its last message as well: the lead's chat would hold the same words twice.
export function messageLead(db: Database, sessions: string, from: Caller, text: string): void {
  if (from === "you" || "lead" in from || "review" in from)
    throw new Error("Only a thread's builder can tell its lead.");
  const thread = from;
  const name = threadName(db, thread);
  noteForLead(db, sessions, thread, wrapMessage(name, `sc tell ${name}`, text), null, true);
  record(db, thread.folder, { told_lead: true }, `its builder told the lead: ${text}`);
}

// Text that could break out of Skelcrew's wrapper: a skelcrew tag in any form, opening or
// closing, with spaces or in any case, or a control character.
const unsafe = /<\s*\/?\s*skelcrew|(?![\n\t])\p{Cc}/iu;

// Saves a lead's brief for another repository's lead, to be typed in once that lead can take
// it, as an urgent note. It is wrapped as from the sending lead, such as app:lead, with the
// command that answers it, so the other lead takes it for another agent's report, never for the
// human's say-so. `asked` is the human's own words, which the sending lead gave with
// --asked-file. Only then may the other lead start work on it, for exactly what those words
// ask, with the tag saying asked="yes", which only Skelcrew can write. The words and the brief
// both go in unchanged, unless one could break out of the wrapper. A skelcrew tag in any form,
// such as </skelcrew >, would end Skelcrew's own early or pass for another. A control
// character, such as the end of a bracketed paste, would end the paste and act as typing. So
// such text has each & written &amp;, each < &lt;, and each control character but a line break
// or tab as its code, such as &#x1b;, and its heading says so: the other lead reads back
// exactly what was written. Only a lead may brief, and never its own repository, which it plans
// itself.
export function briefLead(
  db: Database,
  sessions: string,
  from: Caller,
  to: { name: string; owner: string; repo: string },
  text: string,
  asked?: string,
): void {
  if (from === "you" || !("lead" in from))
    throw new Error("Only a lead can brief another repository's lead.");
  const { owner, repo } = from.lead;
  if (owner === to.owner && repo === to.repo)
    throw new Error(`${to.name} is your own repository: brief its threads with sc tell instead.`);
  const sender = repositories(db).find((r) => r.owner === owner && r.repo === repo);
  const name = sender?.name ?? `${owner}/${repo}`;
  // Returns text as it goes in, unchanged or escaped when it holds a tag or a control character,
  // with what its heading adds to say how it was escaped, if it was.
  const shown = (said: string) =>
    unsafe.test(said)
      ? {
          how: ", with each < written as &lt;, each & as &amp; and each control character as its code, such as &#x1b;, as it holds a skelcrew tag or a control character",
          as: controlsAsCodes(said.replaceAll("&", "&amp;").replaceAll("<", "&lt;")),
        }
      : { how: "", as: said };
  // The brief comes last, so it ends where Skelcrew's closing tag does, which it can't hold. A
  // brief with no tag and none of the human's words needs no heading, as it is all there is.
  const brief = shown(text);
  let body = brief.how ? `The brief${brief.how}:\n${brief.as}` : brief.as;
  // The human's words come first, between two lines of ~ longer than any run of ~ in them, so
  // nothing they hold, such as a line saying "The brief:", can pass for where they end.
  if (asked !== undefined) {
    const words = shown(asked);
    const longest = Math.max(0, ...(words.as.match(/~+/g) ?? []).map((run) => run.length));
    const fence = "~".repeat(Math.max(3, longest + 1));
    body = `The human's words, exactly as ${name}'s lead was given them${words.how}, between the two lines of ${fence}:\n${fence}\n${words.as}\n${fence}\n\nThe brief${brief.how}:\n${brief.as}`;
  }
  const tag = `<skelcrew from="${name}:lead" reply="sc tell lead ${name}"`;
  const message = `${tag}${asked === undefined ? "" : ' asked="yes"'}>\n${body}\n</skelcrew>`;
  noteForLead(db, sessions, to, message, null, true);
}

// Types the saved notes for a repository's lead into it, such as "started app-12 from github:
// Fix the login redirect" or "app-12 needs you: its builder asked a question", and forgets each
// once typed. The lead's chat is the human's too, so typing waits while the lead is busy, while
// a person's unsent draft is at its prompt, and while the human has scrolled back in it, as the
// paste would throw them back to the bottom. Everything that waited then goes in as one
// message, its notes a blank line apart, so the chat jumps once. Threads needing you come first,
// then urgent notes such as a builder's message, then the rest, as the human must see those
// soonest. A lead that isn't running, or never started, gets nothing: its notes stay saved until
// it starts.
async function typeNotes(
  db: Database,
  sessions: string,
  owner: string,
  repo: string,
): Promise<void> {
  const { name, harness } = leadOf(db, owner, repo);
  const where = "owner = ? AND repo = ?";
  // Returns what the lead would be told now: the threads needing you, the notes in the order
  // they go in, and the message they make together.
  const batch = () => {
    const sql = `SELECT id, text FROM notes WHERE ${where} ORDER BY urgent DESC, id`;
    const notes = z.array(Note).parse(db.query(sql).all(owner, repo));
    const rows = db
      .query(`SELECT * FROM task_threads WHERE noting IS NOT NULL AND ${where} ORDER BY rowid`)
      .all(owner, repo);
    const needing = z.array(Thread).parse(rows);
    const lines = [
      ...needing.map((thread) => `${threadName(db, thread)} needs you: ${thread.noting}`),
      ...notes.map(({ text }) => text),
    ];
    // Notes can quote outside text, such as a plugin's or a failed check's, so no control
    // character in them reaches the paste.
    return { notes, needing, text: controlsAsCodes(lines.join("\n\n")) };
  };
  while (true) {
    const now = batch();
    // Stop when nothing is left to say, or nobody is there to hear it.
    if (now.text === "") return;
    if (!(await agentRuns(sessions, name))) return;
    // A lead that is running has started, so it has a harness.
    const { marks } = harnessNamed(harness ?? "claude");
    // Typing asks this right before readying the paste and again right before it goes in. What
    // would be said may have changed while the lead was busy or scrolled back: a question you
    // answered, a thread's end note dropped as it starts over, or a new note to go in with the
    // rest. Then this typing is cancelled, and the next pass types what is said now.
    const cancel = new AbortController();
    const hold = () => {
      if (batch().text !== now.text) cancel.abort();
      return scrolledBack(sessions, name) ? "the human has scrolled back in it" : "";
    };
    // dropEndNotes cancels typing too, should it drop a note in the moment of the paste.
    for (const { id } of now.notes) typingNote.set(id, cancel);
    let typed: Typed;
    try {
      // However long the lead stays busy, the notes wait for it, as they must reach it.
      const waits = { signal: cancel.signal, hold, timeout: Number.POSITIVE_INFINITY };
      typed = await deliver(sessions, name, marks, now.text, waits);
    } finally {
      for (const { id } of now.notes) typingNote.delete(id);
    }
    if (typed !== "typed") continue;
    // A note's ID is never used twice, so a note saved meanwhile is never deleted as one of these.
    for (const { id } of now.notes) db.run("DELETE FROM notes WHERE id = ?", [id]);
    // A thread may have stopped needing you and started again while this was typed.
    for (const thread of now.needing)
      if (readThread(db, thread.folder).noting === thread.noting)
        record(db, thread.folder, { noting: null }, "told the lead it needs you");
  }
}

// The saved note being typed into a lead, by its ID, with what cancels its typing.
const typingNote = new Map<number, AbortController>();

// Drops the notes that a thread ended or failed which still wait for its lead, cancelling one
// being typed. A thread starting over in the same folder has the same name, and the lead would
// take the old end for the new thread's and drop it from what it holds open, or ask you to start
// it again. A note already pasted
// at the lead's prompt is still sent: typing presses Enter a moment after the paste, and
// leaving it there would block every later note behind an unsent draft.
export function dropEndNotes(db: Database, folder: string): void {
  const ids = z
    .array(z.object({ id: z.number() }))
    .parse(db.query("SELECT id FROM notes WHERE ended = ?").all(folder));
  for (const { id } of ids) typingNote.get(id)?.abort();
  db.run("DELETE FROM notes WHERE ended = ?", [folder]);
}

// The note typing under way for each repository's lead, by its owner/name.
const noteTyping = new Map<string, Promise<void>>();

// Types the saved notes into each repository's lead, and returns at once, so the round or
// request that saved a note never waits on a lead. Each lead's typing runs one after another,
// so a note is never pasted twice. A busy lead holds up no other lead. A note that fails to be
// typed stays saved. The next call tries it again: at the next note, the next time you open a
// lead with sc, or the daemon's next start.
export function typeLeadNotes(db: Database, sessions: string): void {
  for (const { owner, repo } of repositories(db)) {
    // Chain onto the lead's typing under way, so its notes go in one after another.
    const key = `${owner}/${repo}`;
    const before = noteTyping.get(key) ?? Promise.resolve();
    noteTyping.set(
      key,
      before
        .then(() => typeNotes(db, sessions, owner, repo))
        .catch((error) => console.log(`couldn't tell ${key}'s lead: ${errorText(error)}`)),
    );
  }
}

// Saves a note for the lead of a repository, and has the daemon type it in. Notes already
// wait while the lead is busy, and stay saved while it isn't running, so a note is never lost.
// `ended` is the folder of the thread whose end or failure the note reports, if it does. An `urgent` note,
// such as a builder's message, goes ahead of the rest when several wait.
export function noteForLead(
  db: Database,
  sessions: string,
  repository: { owner: string; repo: string },
  text: string,
  ended: string | null = null,
  urgent = false,
): void {
  db.run("INSERT INTO notes (owner, repo, text, ended, urgent) VALUES (?, ?, ?, ?, ?)", [
    repository.owner,
    repository.repo,
    text,
    ended,
    urgent ? 1 : 0,
  ]);
  typeLeadNotes(db, sessions);
}
