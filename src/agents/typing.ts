// Typing a message into an agent's session: waiting until its harness shows it is ready, then
// pasting the message and its Enter, one message at a time per session.
import { mustTmux, tmux } from "./tmux.ts";

type Waits = { moment?: number; timeout?: number; signal?: AbortSignal };
// What a harness's screen shows: `busy` while a turn runs, and a line holding only `prompt`
// once it is ready for a message.
export type Marks = { busy: string; prompt: string };

// Returns the visible pane text so Skelcrew can check whether the agent is ready for a
// message.
const screen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// Why typing waits while a person has text at the agent's prompt.
const draft = "an unsent draft is at its prompt";

// Returns why one look at the screen shows the agent not ready, by its harness's marks, or
// empty text when it shows a bare prompt. A prompt line holding text is a person's unsent
// draft: a message pasted then would be sent along with it. A numbered menu, such as a
// permission question, also puts the mark before text, so that isn't taken for a draft.
function notReady(shown: string, marks: Marks) {
  if (shown.includes(marks.busy)) return `it shows ${marks.busy}`;
  const lines = shown.split("\n").map((line) => line.trim());
  if (lines.includes(marks.prompt)) return "";
  // The mark alone, without Codex's placeholder, which a draft replaces.
  const mark = marks.prompt.split(" ")[0] ?? marks.prompt;
  const input = lines.findLast((line) => line.startsWith(`${mark} `));
  if (input !== undefined && !/^\S+ \d+\. /.test(input)) return draft;
  return `it shows no ${marks.prompt} prompt`;
}

// Returns why the agent is busy, by its harness's marks, or empty text when it is ready to
// accept a message. A quiet pane alone isn't enough: Claude Code can sit still mid-turn while
// a tool runs.
async function notIdle(socket: string, name: string, marks: Marks, moment: number) {
  // Look twice, a moment apart, so a screen still drawing shows as busy.
  const before = screen(socket, name);
  await Bun.sleep(moment);
  const after = screen(socket, name);
  if (after.includes(marks.busy)) return `it shows ${marks.busy}`;
  if (before !== after) return "its screen kept changing";
  return notReady(after, marks);
}

// Reports whether the agent shows a quiet, ready prompt, by its harness's marks, so Skelcrew can
// avoid interrupting work.
export async function isIdle(
  socket: string,
  name: string,
  marks: Marks,
  waits: Waits = {},
): Promise<boolean> {
  return (await notIdle(socket, name, marks, waits.moment ?? 500)) === "";
}

// One message at a time per session, so two pastes can't land before either's Enter.
const typingQueues = new Map<string, Promise<void>>();

// Queues a message for the session and returns a promise that settles after its typing
// attempt. Messages wait their turn so two pastes cannot arrive before either message's
// Enter. `marks` are those of the harness running in the session.
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

let buffers = 0;

// Waits for the agent to be ready, then pastes and submits the message without losing long
// text. Throws if it stays busy too long, and removes the temporary paste buffer after the
// attempt. Types nothing once the signal is aborted, however long it waited.
async function typeNow(socket: string, name: string, marks: Marks, text: string, waits: Waits) {
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // A paste buffer of its own, so two daemons or two messages never paste each other's text.
  const buffer = `skelcrew-${process.pid}-${buffers++}`;
  try {
    // Text typed while Claude Code is starting or busy can be lost, so wait until it is idle.
    // Check the signal after each wait too: the thread may have stopped meanwhile.
    while (true) {
      if (waits.signal?.aborted) return;
      const why = await notIdle(socket, name, marks, moment);
      if (waits.signal?.aborted) return;
      if (why === "") {
        // Someone scrolled back would swallow the Enter below, and the message would never be
        // sent. Being scrolled back shows in neither the check above nor the pane's text, so
        // it is left here, whether or not anyone is. It fails when nobody is, which is fine.
        tmux(socket, ["send-keys", "-X", "-t", `=${name}:`, "cancel"]);
        mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
        // A person can start typing after the last look, and the paste would send their draft
        // along with the message. So look once more right before pasting, and wait again if
        // the prompt isn't bare. A moment remains, but only a tmux call long.
        if (notReady(screen(socket, name), marks) === "") break;
      } else if (Date.now() > deadline) {
        const waited = `${timeout / 1000}s`;
        // A person's draft gets a plain answer, as it isn't the agent being busy.
        if (why === draft)
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
  } finally {
    tmux(socket, ["delete-buffer", "-b", buffer]);
  }
}
