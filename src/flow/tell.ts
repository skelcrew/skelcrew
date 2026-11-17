// Messages between a repository's lead and its threads' builders, for sc tell: typed into the
// other's session once it can take them, and kept in the thread's log. They never go to a tracker or
// forge.
import type { Database } from "bun:sqlite";
import { agentRuns } from "../agents/tmux.ts";
import { noteForLead } from "./lead.ts";
import { messagesWaiting, queueMessage, whyWaiting } from "./messages.ts";
import { log, readThread, type Thread, threadName } from "./thread.ts";

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
// take it, and returns the line sc tell prints. When it can't be typed in right away, the line
// says why, so the lead never waits without knowing. A message still waiting after 10 minutes
// brings the lead a note. Refuses a builder that isn't running rather than keeping the message,
// which could reach it long after it mattered. Refuses one asking you a question with its
// harness's question tool too: typing then would answer it for you. One that stopped without
// submitting may be told, as the lead can often answer what it waits on, and the message typed
// in ends its needing you.
export async function messageBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  text: string,
): Promise<string> {
  // Refuse first: a stopped thread gets the command that brings it back, any other one without
  // a session gets its status.
  const name = threadName(db, thread);
  const live = thread.status === "working" || thread.status === "waiting";
  if (thread.status === "stopped")
    throw new Error(
      `${name}'s builder isn't running: the thread is stopped. sc start ${name} brings it back.`,
    );
  // A thread still setting up has no session yet, and one that failed or is done has none left.
  if (!live || !agentRuns(tmux, thread.folder))
    throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and typing now would answer it. Tell the human instead.`,
    );
  // Look before saving it, so the answer says whether it goes in now. Messages are typed in
  // order, so any still waiting go first.
  const ahead = messagesWaiting(db, thread);
  const why = await whyWaiting(tmux, thread);
  const message = wrapMessage("lead", "sc tell lead", text);
  queueMessage(db, tmux, thread.folder, {
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
// agent command.
export function messageLead(db: Database, tmux: string, thread: Thread, text: string): void {
  const name = threadName(db, thread);
  noteForLead(db, tmux, thread, wrapMessage(name, `sc tell ${name}`, text));
  log(db, readThread(db, thread.folder), `its builder told the lead: ${text}`);
}
