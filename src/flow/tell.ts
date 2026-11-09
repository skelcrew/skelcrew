// Messages between the lead and a thread's builder, for skel tell: typed into the other's
// session once it is idle, and kept in the thread's log. They never go to GitHub.
import type { Database } from "bun:sqlite";
import { agentRuns, typeInto } from "../agents/tmux.ts";
import { errorText } from "../say.ts";
import { tellLead } from "./lead.ts";
import { log, readThread, type Thread, threadName } from "./thread.ts";

// Saves a note for the lead and has the daemon type it in. Notes already wait while the lead
// is busy, and stay saved while it isn't running, so a message to it is never lost.
function noteForLead(db: Database, tmux: string, text: string): void {
  db.run("INSERT INTO notes (text) VALUES (?)", [text]);
  tellLead(db, tmux);
}

// Returns the message wrapped in skel's tag, saying who it is from and the command to answer
// with, so the receiving agent never takes it for the human. The tag marks where it starts
// and ends, and the text inside stays plain. Any <skel or </skel> in the text is removed, so a
// message can't close its tag early and pass the rest off as coming from outside it.
function wrapped(from: string, reply: string, text: string): string {
  const inside = text.replace(/<\/skel>|<skel/gi, "");
  return `<skel from="${from}" reply="${reply}">\n${inside}\n</skel>`;
}

// Types the lead's message into the thread's builder once it is idle, and returns the
// thread's name at once, as an agent's command must answer quickly. Refuses a builder that
// isn't running rather than keeping the message, which could reach it long after it
// mattered. Refuses one asking you a question too: typing then would answer it for you.
// A message that can't be typed in, such as to a builder busy for half an hour, is logged,
// and the lead hears that it didn't arrive.
export function messageBuilder(db: Database, tmux: string, thread: Thread, text: string): string {
  const name = threadName(db, thread);
  const live = thread.status === "working" || thread.status === "waiting";
  if (thread.status === "stopped")
    throw new Error(
      `${name}'s builder isn't running: the thread is stopped. skel start ${name} brings it back.`,
    );
  // A thread still setting up has no session yet, and one that failed or is done has none left.
  if (!live || !agentRuns(tmux, thread.folder))
    throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and typing now would answer it. Tell the human instead.`,
    );
  const message = wrapped("lead", "skel tell lead", text);
  typeInto(tmux, thread.folder, message, { timeout: 30 * 60_000 }).then(
    () => log(readThread(db, thread.folder), `the lead told its builder: ${text}`),
    (error) => {
      const said = errorText(error);
      log(readThread(db, thread.folder), `couldn't tell its builder what the lead said: ${said}`);
      noteForLead(db, tmux, `${name}'s builder didn't get your message: ${said}`);
    },
  );
  return name;
}

// Has the daemon type a builder's message into the lead, naming the thread it comes from
// and how to answer, and logs it in the thread's log. Returns at once, like any agent
// command.
export function messageLead(db: Database, tmux: string, thread: Thread, text: string): void {
  const name = threadName(db, thread);
  noteForLead(db, tmux, wrapped(name, `skel tell ${name}`, text));
  log(readThread(db, thread.folder), `its builder told the lead: ${text}`);
}
