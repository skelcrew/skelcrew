// Messages between a repository's lead and its threads' builders, for sc tell: typed into the
// other's session once it is idle, and kept in the thread's log. They never go to a tracker or
// forge.
import type { Database } from "bun:sqlite";
import { agentRuns } from "../agents/tmux.ts";
import { typeInto } from "../agents/typing.ts";
import { errorText } from "../say.ts";
import { noteForLead } from "./lead.ts";
import { builderHarness, log, readThread, type Thread, threadName } from "./thread.ts";

// Returns the message wrapped in Skelcrew's tag, saying who it is from and the command to answer
// with, so the receiving agent never takes it for the human. The tag marks where it starts and
// ends, and the text inside stays plain. Any <skelcrew or </skelcrew> in the text is removed, so a
// message can't close its tag early and pass the rest off as coming from outside it.
function wrapped(from: string, reply: string, text: string): string {
  let inside = text;
  // One pass isn't enough: removing the inner tag of </skel</skelcrew>crew> leaves a whole
  // </skelcrew>.
  while (/<\/skelcrew>|<skelcrew/i.test(inside))
    inside = inside.replace(/<\/skelcrew>|<skelcrew/gi, "");
  return `<skelcrew from="${from}" reply="${reply}">\n${inside}\n</skelcrew>`;
}

// Types the lead's message into the thread's builder once it is idle, and returns the
// thread's name at once, as an agent's command must answer quickly. Refuses a builder that
// isn't running rather than keeping the message, which could reach it long after it
// mattered. Refuses one asking you a question too: typing then would answer it for you.
// A message that can't be typed in, such as to a builder busy for half an hour, is logged,
// and the lead hears that it didn't arrive.
export function messageBuilder(db: Database, tmux: string, thread: Thread, text: string): string {
  // Refuse first, while the lead's command still waits for an answer: a stopped thread gets
  // the command that brings it back, any other one without a session gets its status.
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
  // Typing waits until the builder is idle, up to half an hour, so it runs on without being
  // awaited. Either way the thread's log says what happened, and the lead hears of a failure,
  // since by then its command has long returned.
  const message = wrapped("lead", "sc tell lead", text);
  typeInto(tmux, thread.folder, builderHarness(thread).marks, message, {
    timeout: 30 * 60_000,
  }).then(
    () => log(readThread(db, thread.folder), `the lead told its builder: ${text}`),
    (error) => {
      const said = errorText(error);
      log(readThread(db, thread.folder), `couldn't tell its builder what the lead said: ${said}`);
      noteForLead(db, tmux, thread, `${name}'s builder didn't get your message: ${said}`);
    },
  );
  return name;
}

// Has the daemon type a builder's message into its repository's lead, naming the thread it
// comes from and how to answer, and logs it in the thread's log. Returns at once, like any
// agent command.
export function messageLead(db: Database, tmux: string, thread: Thread, text: string): void {
  const name = threadName(db, thread);
  noteForLead(db, tmux, thread, wrapped(name, `sc tell ${name}`, text));
  log(readThread(db, thread.folder), `its builder told the lead: ${text}`);
}
