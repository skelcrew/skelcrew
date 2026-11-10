// Typing a message into an agent's session: waiting until its harness shows it is ready, then
// pasting the message and its Enter, one message at a time per session.
import { mustTmux, tmux } from "./tmux.ts";

type Waits = { moment?: number; timeout?: number; signal?: AbortSignal };
// What a harness's screen shows: `busy` while a turn runs, and a line holding only `prompt`
// once it is ready for a message.
export type Marks = { busy: string; prompt: string };

// Returns the visible pane text so skel can check whether the agent is ready for a
// message.
const screen = (socket: string, name: string) =>
  mustTmux(socket, ["capture-pane", "-p", "-t", `=${name}:`]);

// Returns why the agent is busy, by its harness's marks, or empty text when it is ready to
// accept a message. A quiet pane alone isn't enough: Claude Code can sit still mid-turn while
// a tool runs.
async function notIdle(socket: string, name: string, marks: Marks, moment: number) {
  const before = screen(socket, name);
  await Bun.sleep(moment);
  const after = screen(socket, name);
  if (after.includes(marks.busy)) return `it shows ${marks.busy}`;
  if (before !== after) return "its screen kept changing";
  if (!after.split("\n").some((line) => line.trim() === marks.prompt))
    return `it shows no ${marks.prompt} prompt`;
  return "";
}

// Reports whether the agent shows a quiet, ready prompt, by its harness's marks, so skel can
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
  const key = `${socket}/${name}`;
  const earlier = typingQueues.get(key) ?? Promise.resolve();
  const turn = earlier.then(() => typeNow(socket, name, marks, text, waits));
  // The next message waits for this one whether or not it got through.
  const settled = turn.then(
    () => {},
    () => {},
  );
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
  // Text typed while Claude Code is starting or busy can be lost.
  for (;;) {
    if (waits.signal?.aborted) return;
    const why = await notIdle(socket, name, marks, moment);
    if (waits.signal?.aborted) return;
    if (why === "") break;
    if (Date.now() > deadline)
      throw new Error(`${name} wasn't idle for ${timeout / 1000}s (${why}), so nothing was typed`);
  }
  const buffer = `skel-${process.pid}-${buffers++}`;
  // Someone scrolled back would swallow the Enter below, and the message would never be
  // sent. Being scrolled back shows in neither the check above nor the pane's text, so it
  // is left here, whether or not anyone is. It fails when nobody is, which is fine.
  tmux(socket, ["send-keys", "-X", "-t", `=${name}:`, "cancel"]);
  try {
    mustTmux(socket, ["load-buffer", "-b", buffer, "-"], text);
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
