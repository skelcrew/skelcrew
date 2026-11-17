// Typing a message into an agent's session: waiting until its harness shows it is ready, then
// pasting the message and its Enter, one message at a time per session.
import { mustTmux, tmux } from "./tmux.ts";

// How typing waits, in milliseconds. `moment` is the pause between two looks at the screen,
// and between a paste and its Enter. `timeout` is how long to wait for the prompt to be ready
// before giving up, which may be Infinity. Once `signal` is aborted, nothing is typed.
type Waits = { moment?: number; timeout?: number; signal?: AbortSignal };

// How long to watch a still busy mark, in milliseconds, before taking it for the agent's own
// text. Claude Code's spinner and Codex's "Working" line count seconds, so they redraw at least
// once a second, and one and a half seconds always holds a redraw.
const statusLineWatch = 1500;
// What a harness's screen shows: `busy` while a turn runs, and a line holding only `prompt`
// once it is ready for a message.
export type Marks = { busy: string; prompt: string };

// Returns the visible pane text so Skelcrew can check whether the agent is ready for a
// message.
const readScreen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// The reason typing gives for waiting while a person has unsent text at the agent's prompt.
const draftReason = "an unsent draft is at its prompt";

// The start of the reason typing gives while the agent's turn runs, so whoever waits on it can
// tell that pressing Esc would end the turn.
export const midTurn = "it is mid-turn";

// Returns why one look at the screen shows the agent not ready, by its harness's marks, or
// empty text when it shows a bare prompt. A prompt line holding text is a person's unsent
// draft: a message pasted then would be sent along with it. A numbered menu, such as a
// permission question, also puts the mark before text, so that isn't taken for a draft. The
// busy mark only names the reason here: Claude Code and Codex show their input mid-turn too,
// so whether a turn runs is told by whyBusy, from two looks.
function notReady(shown: string, marks: Marks) {
  const lines = shown.split("\n").map((line) => line.trim());
  if (lines.includes(marks.prompt)) return "";
  if (shown.includes(marks.busy)) return `${midTurn} (it shows ${marks.busy})`;
  // The mark alone, without Codex's placeholder, which a draft replaces.
  const mark = marks.prompt.split(" ")[0] ?? marks.prompt;
  const input = lines.findLast((line) => line.startsWith(`${mark} `));
  if (input !== undefined && !/^\S+ \d+\. /.test(input)) return draftReason;
  return `it shows no ${marks.prompt} prompt`;
}

// Returns why the screen changed between two looks: mid-turn when a line holding the busy mark
// is new, as the harness's status line redraws, or else that it kept changing.
function whyChanged(before: string, after: string, marks: Marks): string {
  const earlier = new Set(before.split("\n"));
  const live = after.split("\n").some((line) => line.includes(marks.busy) && !earlier.has(line));
  return live ? `${midTurn} (it shows ${marks.busy})` : "its screen kept changing";
}

// Returns why the agent isn't ready for a message, in plain words, by its harness's marks, or
// empty text when it is. Skelcrew says why to whoever waits on the message.
// A turn runs while the harness's status line is live: Claude Code's spinner and Codex's
// "Working" line hold the busy mark and redraw at least every second, as their timer counts.
// The mark sitting still is the agent's own text, such as a builder's grep through Skelcrew's
// code or its reply quoting it, and never makes it look busy: it would then look busy forever,
// Esc or not. No hook stands in for this: a turn can start with nothing typed in, such as when
// a background task ends, and Esc runs none.
export async function whyBusy(
  socket: string,
  name: string,
  marks: Marks,
  waits: Waits = {},
): Promise<string> {
  // Look twice, a moment apart. A line holding the mark that changed is the live status line.
  const moment = waits.moment ?? 500;
  const before = readScreen(socket, name);
  await Bun.sleep(moment);
  const after = readScreen(socket, name);
  if (before !== after) return whyChanged(before, after, marks);
  const why = notReady(after, marks);
  if (why !== "") return why;
  // The mark sits still at a ready prompt. Look once more, long enough to see a status line
  // redraw, as the first two looks can fall between two ticks of its timer.
  if (after.includes(marks.busy)) {
    await Bun.sleep(statusLineWatch);
    const later = readScreen(socket, name);
    if (later !== after) return whyChanged(after, later, marks);
  }
  return "";
}

// Reports whether the agent shows a quiet, ready prompt, by its harness's marks, so Skelcrew can
// avoid interrupting work.
export async function isIdle(
  socket: string,
  name: string,
  marks: Marks,
  waits: Waits = {},
): Promise<boolean> {
  return (await whyBusy(socket, name, marks, waits)) === "";
}

// One message at a time per session, so two pastes can't land before either's Enter.
const typingQueues = new Map<string, Promise<void>>();

// Queues a message for the session and returns a promise that settles after its typing
// attempt, with whether it was typed. Messages wait their turn so two pastes cannot arrive
// before either message's Enter. `marks` are those of the harness running in the session.
export function typeInto(
  socket: string,
  name: string,
  marks: Marks,
  text: string,
  waits: Waits = {},
) {
  // This message's typing starts once the one queued before it for the same session settles.
  const key = `${socket}/${name}`;
  const earlier = typingQueues.get(key) ?? Promise.resolve();
  const turn = earlier.then(() => typeNow(socket, name, marks, text, waits));
  // The next message waits for this one whether or not it got through.
  const settled = turn.then(
    () => {},
    () => {},
  );
  // The queue's end is now this message. Once it settles with nothing queued after it, the
  // session's entry goes, so the map doesn't keep one per session ever typed into.
  typingQueues.set(key, settled);
  settled.then(() => {
    if (typingQueues.get(key) === settled) typingQueues.delete(key);
  });
  return turn;
}

// How many paste buffers this process has made, so each gets a name of its own.
let buffersMade = 0;

// Waits for the agent to be ready, then pastes and submits the message without losing long
// text, and returns true. Throws if it stays busy too long, and removes the temporary paste
// buffer after the attempt. Types nothing, and returns false, once the signal is aborted,
// however long it waited.
async function typeNow(
  socket: string,
  name: string,
  marks: Marks,
  text: string,
  waits: Waits,
): Promise<boolean> {
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // A paste buffer of its own, so two daemons or two messages never paste each other's text.
  const buffer = `skelcrew-${process.pid}-${buffersMade++}`;
  try {
    // Text typed while Claude Code is starting or busy can be lost, so wait until it is idle.
    // Check the signal after each wait too: the thread may have stopped meanwhile.
    while (true) {
      if (waits.signal?.aborted) return false;
      const why = await whyBusy(socket, name, marks, waits);
      if (waits.signal?.aborted) return false;
      if (why === "") {
        // Someone scrolled back would swallow the Enter below, and the message would never be
        // sent. Being scrolled back shows in neither the check above nor the pane's text, so
        // it is left here, whether or not anyone is. It fails when nobody is, which is fine.
        tmux(socket, ["send-keys", "-X", "-t", `=${name}:`, "cancel"]);
        mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
        // A person can start typing after the last look, and the paste would send their draft
        // along with the message. So look once more right before pasting, and wait again if
        // the prompt isn't bare. A moment remains, but only a tmux call long.
        if (notReady(readScreen(socket, name), marks) === "") break;
      } else if (Date.now() > deadline) {
        const waited = `${timeout / 1000}s`;
        // A person's draft gets a plain answer, as it isn't the agent being busy.
        if (why === draftReason)
          throw new Error(
            `${name} had an unsent draft at its prompt for ${waited}, so nothing was typed`,
          );
        throw new Error(`${name} wasn't idle for ${waited} (${why}), so nothing was typed`);
      }
    }
    // Without the paste marks, Claude Code reads the Enter after a long message as a new
    // line, and the message is never sent. So the Enter goes on its own, a moment after the
    // paste.
    mustTmux(socket, ["paste-buffer", "-p", "-b", buffer, "-t", `=${name}:`]);
    await Bun.sleep(moment);
    mustTmux(socket, ["send-keys", "-t", `=${name}:`, "Enter"]);
    return true;
  } finally {
    tmux(socket, ["delete-buffer", "-b", buffer]);
  }
}
