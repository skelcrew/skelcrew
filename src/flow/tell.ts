// The lead reaching its threads' builders. Messages between a repository's lead and its
// threads' builders, for sc tell, are typed into the other's session once it is idle, and kept in
// the thread's log. They never go to a tracker or forge. sc peek shows a builder's screen, and
// sc interrupt stops its turn.
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { agentRuns, mustTmux, tmux as tmuxCommand } from "../agents/tmux.ts";
import { typeInto } from "../agents/typing.ts";
import { errorText } from "../say.ts";
import { noteForLead } from "./lead.ts";
import { builderHarness, log, readThread, record, type Thread, threadName } from "./thread.ts";

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

// Returns the thread's name when its builder has a session to type into or look at, and
// otherwise throws why not, for sc tell, sc peek and sc interrupt. A stopped thread gets the
// command that brings it back, any other one without a session gets its status.
function runningBuilder(db: Database, tmux: string, thread: Thread): string {
  const name = threadName(db, thread);
  const live = thread.status === "working" || thread.status === "waiting";
  if (thread.status === "stopped")
    throw new Error(
      `${name}'s builder isn't running: the thread is stopped. sc start ${name} brings it back.`,
    );
  // A thread still setting up has no session yet, and one that failed or is done has none left.
  if (!live || !agentRuns(tmux, thread.folder))
    throw new Error(`${name}'s builder isn't running: the thread is ${thread.status}.`);
  return name;
}

// Types the lead's message into the thread's builder once it is idle, and keeps it with the
// thread as a change to its task. Returns the thread's name at once, as an agent's command
// must answer quickly. Refuses a builder that isn't running rather than keeping the message,
// which could reach it long after it mattered. Refuses one asking you a question with its
// harness's question tool too: typing then would answer it for you. One that stopped without
// submitting may be told, as the lead can often answer what it waits on, and the message typed
// in ends its needing you.
// A message that can't be typed in, such as to a builder busy for half an hour, is logged,
// and the lead hears that it didn't arrive.
export function messageBuilder(db: Database, tmux: string, thread: Thread, text: string): string {
  // Refuse first, while the lead's command still waits for an answer.
  const name = runningBuilder(db, tmux, thread);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and typing now would answer it. Tell the human instead.`,
    );
  // Typing waits until the builder is idle, up to half an hour, so it runs on without being
  // awaited. Either way the thread's log says what happened, and the lead hears of a failure,
  // since by then its command has long returned. A message typed in becomes a change to the
  // thread's task, so its reviewer judges the builder by what the lead last said. It is kept
  // only once typed: then the reviewer never sees what the builder didn't, and messages keep
  // their order, as typing into a session goes one message at a time.
  const message = wrapMessage("lead", "sc tell lead", text);
  typeInto(tmux, thread.folder, builderHarness(thread).marks, message, {
    timeout: 30 * 60_000,
  }).then(
    () => {
      const { updates } = readThread(db, thread.folder);
      record(
        db,
        thread.folder,
        { updates: [...updates, { from: "lead", at: Date.now(), text }] },
        `the lead told its builder: ${text}`,
      );
    },
    (error) => {
      const said = errorText(error);
      log(
        db,
        readThread(db, thread.folder),
        `couldn't tell its builder what the lead said: ${said}`,
      );
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
  noteForLead(db, tmux, thread, wrapMessage(name, `sc tell ${name}`, text));
  log(db, readThread(db, thread.folder), `its builder told the lead: ${text}`);
}

// When the builder's current stretch of work began, by Skelcrew, and when its harness last said
// by a hook that a turn ended. Both are kept out of the thread's log, so they are read apart.
const Turn = z.object({ working_since: z.number().nullable(), turn_ended: z.number().nullable() });

// Returns what the builder is doing, for sc peek and sc interrupt: mid-turn, or else idle. The
// busy mark alone isn't enough, as a command's output above an idle prompt can hold the same
// words, and Esc there could clear a draft. Nor is the screen's layout: mid-turn, Claude Code
// and Codex both keep their prompt below the busy mark. So the mark must show, and either the
// hooks say a turn is running, or the screen moves. The hooks say so when the builder's last
// stretch of work began after its harness last ended a turn. That holds for a quiet builder
// running a long command too. The screen moving covers the turn Esc ended, which runs no hook
// on Claude Code: its busy mark is gone then. Only the visible screen counts, as an old busy
// mark can sit in the history above it.
async function builderState(
  db: Database,
  tmux: string,
  thread: Thread,
): Promise<"mid-turn" | "idle"> {
  const look = () => mustTmux(tmux, ["capture-pane", "-p", "-t", `=${thread.folder}:`]);
  const { busy } = builderHarness(thread).marks;
  const before = look();
  if (!before.includes(busy)) return "idle";
  const turn = Turn.parse(
    db.query("SELECT working_since, turn_ended FROM threads WHERE folder = ?").get(thread.folder),
  );
  if (turn.working_since !== null && turn.working_since > (turn.turn_ended ?? 0)) return "mid-turn";
  // A harness mid-turn redraws its spinner and timer. A little over a second, so a timer that
  // counts whole seconds has moved too.
  await Bun.sleep(1200);
  const after = look();
  return after.includes(busy) && after !== before ? "mid-turn" : "idle";
}

// Returns the last lines of the builder's screen, for sc peek, so the lead can see what a builder
// busy for a long time is doing without guessing from its PR. It is wrapped as a report from the
// thread, as a builder's screen holds whatever its commands printed, which must never pass for
// the human. Above the screen, one line says the thread's status and what the builder is doing.
// It doesn't say how long the screen has been still: Claude Code redraws its spinner every
// second mid-turn, so a builder stuck on a hung command would look as if it just moved. It
// changes nothing.
export async function peekAtBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  lines: number,
): Promise<string> {
  const name = runningBuilder(db, tmux, thread);
  // -J joins lines the pane wrapped, so a long line reads as one. -S reaches into the history
  // above the screen, for more lines than the pane is tall.
  const target = `=${thread.folder}:`;
  const screen = mustTmux(tmux, ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", target]);
  // Control characters could move the lead's own cursor or ring its bell, so they go, but for
  // line ends and tabs. -J keeps the spaces at each line's end, which say nothing. The blank
  // rows below the last line drawn go too, so the last lines are the ones that show something.
  const shown = screen
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()
    .split("\n")
    .slice(-lines);
  const doing = thread.asking
    ? "asking the human a question"
    : await builderState(db, tmux, thread);
  const heading = `${name} · ${thread.status} · ${doing}`;
  return `<skelcrew from="${name}" kind="peek">\n${untagged([heading, ...shown].join("\n"))}\n</skelcrew>`;
}

// Presses Esc in the builder's session to stop its turn, for sc interrupt, such as when a test
// run or an ssh hangs and sc tell would wait forever for it to be idle. Returns what it did. A
// builder that is idle already is left alone, as Esc there could clear a draft. One asking the
// human a question is refused, as Esc would sweep away a question only the human can answer.
// Each interrupt goes in the thread's log, saying who did it. A message sc tell queued for the
// builder is typed in once it is idle, as usual.
export async function interruptBuilder(
  db: Database,
  tmux: string,
  thread: Thread,
  who: "you" | "the lead",
): Promise<string> {
  const name = runningBuilder(db, tmux, thread);
  if (thread.asking)
    throw new Error(
      `${name}'s builder is asking the human a question, and Esc would sweep it away. Tell the human instead.`,
    );
  if ((await builderState(db, tmux, thread)) === "idle")
    return `${name}'s builder is idle already, so Skelcrew did nothing.`;
  // Looking at the screen takes a moment, and the builder may have asked a question meanwhile.
  // So the thread is read again right before the Esc, which would sweep that question away.
  const now = readThread(db, thread.folder);
  if (now.asking)
    throw new Error(
      `${name}'s builder started asking the human a question just now, so Skelcrew didn't press Esc. Tell the human instead.`,
    );
  // Someone scrolled back would have tmux's copy mode take the Esc, and the builder would never
  // get it. So copy mode is left first. It fails when nobody is scrolled back, which is fine.
  tmuxCommand(tmux, ["send-keys", "-X", "-t", `=${thread.folder}:`, "cancel"]);
  mustTmux(tmux, ["send-keys", "-t", `=${thread.folder}:`, "Escape"]);
  log(db, readThread(db, thread.folder), `${who} interrupted its builder`);
  return `Interrupted ${name}'s builder. A message told to it is typed in once it is idle.`;
}
