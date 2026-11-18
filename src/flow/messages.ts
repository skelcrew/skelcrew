// The messages module: every message Skelcrew types into an agent goes through here, on the
// transport. It holds who may tell whom, the <skelcrew> tag around an agent's words, and each
// agent's queue. A builder's messages are the lead's sc tell and what Skelcrew tells it of its
// PR's events. They wait in the database until the builder can take them, so none is dropped
// while it is busy or stopped, or while the daemon restarts, and sc ps and the sidebar can count
// them. A lead's notes wait there too, until the lead is idle or has started.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { harnessNamed } from "../agents/harness.ts";
import { agentRuns } from "../agents/sessions.ts";
import { deliver, draftReason, idle, midTurn, whyBusy } from "../agents/transport.ts";
import { markSeen } from "../plugins/ask.ts";
import { errorText } from "../say.ts";
import { leadOf } from "./lead.ts";
import { repositories } from "./repo.ts";
import type { Caller } from "./requests.ts";
import {
  builderHarness,
  log,
  readThread,
  record,
  repositoryOf,
  Thread,
  threadName,
} from "./thread.ts";

// A note waiting to be typed into a lead, or null when none waits.
const Note = z.object({ id: z.number(), text: z.string() }).nullable();

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
// person's draft.
export async function whyWaiting(sessions: string, thread: Thread): Promise<string> {
  if (thread.status !== "working" && thread.status !== "waiting")
    return `the thread is ${thread.status}`;
  if (!agentRuns(sessions, thread.folder)) return notRunning;
  if (thread.asking) return "it is asking the human a question";
  if (thread.state === "working") return `${midTurn} (its harness says a turn runs)`;
  return whyBusy(sessions, thread.folder, builderHarness(thread).marks);
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
// may still be pressing Enter on a message it pasted, and type that message again.
const delivering = new Map<string, { cancel: AbortController; ended: Promise<void> }>();

// Types the thread's waiting messages into its builder, oldest first, while it can take them,
// and returns once none is left or it can't. The ones left wait for the next attempt.
async function typeWaiting(db: Database, sessions: string, folder: string, signal: AbortSignal) {
  while (true) {
    const message = oldest(db, folder);
    if (message === null || signal.aborted) return;
    const thread = readThread(db, folder);
    const waits = await whyWaiting(sessions, thread);
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
    const waitsFor = { timeout: 10_000, signal, unsent };
    const typed = await deliver(sessions, folder, marks, message.text, waitsFor);
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
export function deliverMessages(db: Database, sessions: string, folder: string): void {
  if (delivering.has(folder)) return;
  const cancel = new AbortController();
  const ended = typeWaiting(db, sessions, folder, cancel.signal)
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
export function deliverAllWaiting(db: Database, sessions: string): void {
  const rows = db.query("SELECT DISTINCT folder FROM messages").all();
  for (const { folder } of z.array(z.object({ folder: z.string() })).parse(rows))
    deliverMessages(db, sessions, folder);
}

// Drops Skelcrew's waiting messages that tell only of the thread's events, such as a failed
// check or a merge conflict, and the review's changes, as a new round makes them about an older
// commit. A conflict still there is found and told again. The lead's messages stay, and so do
// those carrying a person's review or comment on the PR, as people's words stay true whatever
// the commit, and one left pasted at the prompt, as it would block the next as a draft. Typing
// under way is cancelled first, as it may be typing one of them, and starts again with what is
// left once it has ended. Notices still being prepared learn of the drop by noticeRound.
// Returns the texts dropped, so what they told can be told again if it still holds.
export function dropOldEvents(db: Database, sessions: string, folder: string): string[] {
  roundsDropped.set(folder, noticeRound(folder) + 1);
  const ended = delivering.get(folder)?.ended ?? Promise.resolve();
  stopDelivering(db, folder, false);
  const rows = db
    .query("SELECT * FROM messages WHERE folder = ? AND sender IN ('skelcrew', 'review')")
    .all(folder);
  const dropped: string[] = [];
  for (const message of z.array(Message).parse(rows))
    if (message.typed_in.length === 0 && !message.pasted) {
      db.run("DELETE FROM messages WHERE id = ?", [message.id]);
      dropped.push(message.text);
    }
  ended.then(() => deliverMessages(db, sessions, folder));
  return dropped;
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
export function typeContinue(sessions: string, thread: Thread, signal: AbortSignal) {
  const { marks } = builderHarness(thread);
  return deliver(sessions, thread.folder, marks, "continue", { timeout: 60_000, signal });
}

// Returns an agent's text with any <skelcrew or </skelcrew> removed, so it can't open or close
// Skelcrew's tag and pass what follows off as coming from someone else.
export function untagged(text: string): string {
  let inside = text;
  // One pass isn't enough: removing the inner tag of </skel</skelcrew>crew> leaves a whole
  // </skelcrew>.
  while (/<\/skelcrew>|<skelcrew/i.test(inside))
    inside = inside.replace(/<\/skelcrew>|<skelcrew/gi, "");
  return inside;
}

// Returns the message wrapped in Skelcrew's tag, saying who it is from and the command to answer
// with, so the receiving agent never takes it for the human. The tag marks where it starts and
// ends, and the text inside stays plain, without tags of its own.
function wrapMessage(from: string, reply: string, text: string): string {
  return `<skelcrew from="${from}" reply="${reply}">\n${untagged(text)}\n</skelcrew>`;
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
  if (!live || !agentRuns(sessions, thread.folder))
    throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and typing now would answer it. Tell the human instead.`,
    );
  // Look before saving it, so the answer says whether it goes in now. Messages are typed in
  // order, so any still waiting go first.
  const ahead = messagesWaiting(db, thread);
  const why = await whyWaiting(sessions, thread);
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
export function messageLead(db: Database, sessions: string, from: Caller, text: string): void {
  if (from === "you" || "lead" in from || "review" in from)
    throw new Error("Only a thread's builder can tell its lead.");
  const thread = from;
  const name = threadName(db, thread);
  noteForLead(db, sessions, thread, wrapMessage(name, `sc tell ${name}`, text));
  log(db, readThread(db, thread.folder), `its builder told the lead: ${text}`);
}

// Types each saved note for a repository's lead into it, one at a time, such as "started
// app-12 from github: Fix the login redirect" or "app-12 needs you: its builder asked a
// question", and forgets it once typed. It waits as long as the lead is busy, checking again
// each time whether a note about a thread needing you is still wanted, so a question you
// answered meanwhile is never announced. A lead that isn't running, or never started, gets
// nothing: its notes stay saved until it starts.
async function typeNotes(
  db: Database,
  sessions: string,
  owner: string,
  repo: string,
): Promise<void> {
  const { name, harness } = leadOf(db, owner, repo);
  const where = "owner = ? AND repo = ?";
  // Each pass reads the oldest note and the first thread waiting to be announced, so what was
  // saved while typing is seen too.
  while (true) {
    const note = Note.parse(
      db.query(`SELECT id, text FROM notes WHERE ${where} ORDER BY id`).get(owner, repo),
    );
    const row = db
      .query(`SELECT * FROM task_threads WHERE noting IS NOT NULL AND ${where} ORDER BY rowid`)
      .get(owner, repo);
    const thread = Thread.nullable().parse(row);
    // Stop when nothing is left to say, or nobody is there to hear it. Wait while the lead is busy.
    if (note === null && (thread === null || thread.noting === null)) return;
    if (!agentRuns(sessions, name)) return;
    // A lead that is running has started, so it has a harness.
    const { marks } = harnessNamed(harness ?? "claude");
    if (!(await idle(sessions, name, marks))) continue;
    // Saved notes go first, then a thread that needs you. A note can be dropped while the lead
    // is busy, such as a thread's end note once the thread starts over, so it is looked for
    // again before typing, and its typing is cancelled if it goes meanwhile. A note's ID is never
    // used twice, so a note saved meanwhile is never taken for this one, nor deleted as it.
    if (note !== null) {
      if (!db.query("SELECT 1 FROM notes WHERE id = ?").get(note.id)) continue;
      const cancel = new AbortController();
      typingNote.set(note.id, cancel);
      try {
        await deliver(sessions, name, marks, note.text, { signal: cancel.signal });
      } finally {
        typingNote.delete(note.id);
      }
      db.run("DELETE FROM notes WHERE id = ?", [note.id]);
      continue;
    }
    if (thread === null || thread.noting === null) return;
    await deliver(sessions, name, marks, `${threadName(db, thread)} needs you: ${thread.noting}`);
    // The thread may have stopped needing you and started again while this was typed.
    if (readThread(db, thread.folder).noting === thread.noting)
      record(db, thread.folder, { noting: null }, "told the lead it needs you");
  }
}

// The saved note being typed into a lead, by its ID, with what cancels its typing.
const typingNote = new Map<number, AbortController>();

// Drops the notes that a thread ended which still wait for its lead, cancelling one being
// typed. A thread starting over in the same folder has the same name, and the lead would take
// the old end for the new thread's and drop it from what it holds open. A note already pasted
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
// request that saved a note never waits on a lead. Each lead's notes are typed one after
// another, so a note is never pasted twice, and two notes never share one Enter. A busy lead
// holds up no other lead. A note that fails to be typed stays saved. The next call tries it
// again: at the next note, the next time you open a lead with sc, or the daemon's next start.
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
// `ended` is the folder of the thread whose end the note reports, if it does.
export function noteForLead(
  db: Database,
  sessions: string,
  repository: { owner: string; repo: string },
  text: string,
  ended: string | null = null,
): void {
  db.run("INSERT INTO notes (owner, repo, text, ended) VALUES (?, ?, ?, ?)", [
    repository.owner,
    repository.repo,
    text,
    ended,
  ]);
  typeLeadNotes(db, sessions);
}
