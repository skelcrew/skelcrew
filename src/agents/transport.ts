// The transport module: gets text into an agent and says when the agent is idle. The built-in
// works on any host's sessions, as it uses only the sessions module's paste, keys and read. It
// tells idle from the screen: the harness's status line isn't live and a bare prompt shows,
// which also shows a person's unsent draft. It delivers one message at a time per session, as a
// paste then Enter. A runtime plugin that provides the transport is asked instead, for the
// sessions on its own host: its `idle` says whether the agent is idle, and its `deliver` types a
// message once it is, never on top of a person's draft.
import { z } from "zod";
import { askHost, type Host, type PluginHost } from "../plugins/runtime.ts";
import { dropStaged, pasteStaged, readSession, sendKey, stagePaste } from "./sessions.ts";

// How typing waits, in milliseconds. `moment` is the pause between two looks at the screen,
// and between a paste and its Enter. `timeout` is how long to wait for the prompt to be ready
// before giving up, which may be Infinity. Once `signal` is aborted, nothing is typed. `unsent`
// says the message was pasted before and left unsent for a question, so a draft at the prompt
// is it, not a person's. `hold` gives a reason of the caller's to wait, or empty text for none,
// such as a person scrolled back in the lead's chat. It is asked right before the text is
// readied and again right before the paste, so a reason that comes up while typing waits still
// counts, and after the paste, before its Enter. It may abort `signal`, such as when the message
// it would send went stale, which stops typing only until the paste.
type Waits = {
  moment?: number;
  timeout?: number;
  signal?: AbortSignal;
  unsent?: boolean;
  hold?: () => string;
};

// What became of a message typed in: sent, left pasted at the prompt unsent for a question, or
// not typed at all.
export type Typed = "typed" | "left unsent" | "not typed";

// How long to watch a still busy mark, in milliseconds, before taking it for the agent's own
// text. Claude Code's spinner and Codex's "Working" line count seconds, so they redraw at least
// once a second, and one and a half seconds always holds a redraw.
const statusLineWatch = 1500;
// What a harness's screen shows: `busy` while a turn runs, and a line holding only `prompt`
// once it is ready for a message.
export type Marks = { busy: string; prompt: string };

// The reason typing gives for waiting while a person has unsent text at the agent's prompt.
export const draftReason = "an unsent draft is at its prompt";

// The reason to cancel typing with when the agent asks you a question. A message already pasted
// is then left at the prompt unsent, as its Enter would answer the question, and the next
// typing of it, told so by `unsent`, sends it with Enter alone.
export const forQuestion = "the agent asked a question";

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
  return statusLineLive(before, after, marks.busy)
    ? `${midTurn} (it shows ${marks.busy})`
    : "its screen kept changing";
}

// Reports whether a line holding the busy mark is new since the earlier look, as the harness's
// status line redraws while a turn runs. The same line again is the agent's own text.
function statusLineLive(before: string, after: string, busy: string): boolean {
  const earlier = new Set(before.split("\n"));
  return after.split("\n").some((line) => line.includes(busy) && !earlier.has(line));
}

// Reports whether a look at the screen shows the agent out of a turn, given the look before it,
// taken at least two seconds earlier, or undefined for none: its busy mark is gone, or it sits
// still at a bare prompt, as the agent's own text. A live status line redraws every second.
// The status module's screen check uses it, by the same rule as typing.
export function quietSince(before: string | undefined, after: string, marks: Marks): boolean {
  if (!after.includes(marks.busy)) return true;
  if (before === undefined || notReady(after, marks) !== "") return false;
  return !statusLineLive(before, after, marks.busy);
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
  socket: Host,
  name: string,
  marks: Marks,
  waits: Waits = {},
): Promise<string> {
  // A host with its own transport knows itself whether its agent is idle.
  const own = hostTransport(socket);
  if (own) {
    const said = await askHost(own, { ask: "idle", id: name }, z.object({ idle: z.boolean() }));
    return said.idle ? "" : `${midTurn} (its host says so)`;
  }
  // Look twice, a moment apart. A line holding the mark that changed is the live status line.
  const moment = waits.moment ?? 500;
  const before = await readSession(socket, name);
  await Bun.sleep(moment);
  const after = await readSession(socket, name);
  if (before !== after) return whyChanged(before, after, marks);
  const why = notReady(after, marks);
  if (why !== "") return why;
  // The mark sits still at a ready prompt. Look once more, long enough to see a status line
  // redraw, as the first two looks can fall between two ticks of its timer.
  if (after.includes(marks.busy)) {
    await Bun.sleep(statusLineWatch);
    const later = await readSession(socket, name);
    if (later !== after) return whyChanged(after, later, marks);
  }
  return "";
}

// Reports whether the agent is idle: its screen is quiet and shows a bare prompt, by its
// harness's marks. Skelcrew checks it before typing a lead's notes, so it never interrupts work.
export async function idle(
  socket: Host,
  name: string,
  marks: Marks,
  waits: Waits = {},
): Promise<boolean> {
  return (await whyBusy(socket, name, marks, waits)) === "";
}

// One message at a time per session, so two pastes can't land before either's Enter.
const typingQueues = new Map<string, Promise<void>>();

// Delivers a message into the agent once it is idle, never into a turn still running and never
// on top of a person's unsent draft. Returns a promise that settles after the attempt, with
// what became of the message, and rejects if the agent stays busy too long. Messages to one
// session wait their turn, so two pastes cannot arrive before either message's Enter. `marks`
// are the harness's in the session.
export function deliver(socket: Host, name: string, marks: Marks, text: string, waits: Waits = {}) {
  // This message's typing starts once the one queued before it for the same session settles.
  const key = `${typeof socket === "string" ? socket : socket.plugin}/${name}`;
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

// Waits for the agent to be ready, then pastes and submits the message without losing long
// text, and returns "typed". Throws if it stays busy too long, and forgets the text it readied
// for pasting after the attempt. Types nothing once the signal is aborted, however long it waited.
// Aborted between the paste and its Enter, it still sends the message, which is in: unless for
// a question, which the Enter would answer. Then it leaves the message at the prompt and returns
// "left unsent", and the next typing of it, told so by `unsent`, presses Enter alone.
async function typeNow(
  socket: Host,
  name: string,
  marks: Marks,
  text: string,
  waits: Waits,
): Promise<Typed> {
  const own = hostTransport(socket);
  if (own) return deliverOnHost(own, name, text, waits);
  const moment = waits.moment ?? 500;
  const timeout = waits.timeout ?? 60_000;
  const deadline = Date.now() + timeout;
  // The text readied on each pass, the last of which is pasted.
  const staged: string[] = [];
  try {
    // Text typed while Claude Code is starting or busy can be lost, so wait until it is idle.
    // Check the signal after each wait too: the thread may have stopped meanwhile.
    let unsent = waits.unsent ?? false;
    while (true) {
      if (waits.signal?.aborted) return "not typed";
      const why = await whyBusy(socket, name, marks, waits);
      if (waits.signal?.aborted) return "not typed";
      // The draft is this message, left unsent for a question that is over now: send it. A bare
      // prompt means a person sent or cleared it, so it is typed afresh, and a draft after that
      // is a person's.
      if (why === draftReason && unsent) {
        await sendKey(socket, name, "Enter");
        return "typed";
      }
      if (why === "") unsent = false;
      // The caller's reason is asked before readying the text, as readying it leaves copy mode.
      const held = why === "" ? (waits.hold?.() ?? "") : "";
      if (waits.signal?.aborted) return "not typed";
      if (why === "" && held === "") {
        staged.push(stagePaste(socket, name, text));
        // A person can start typing after the last look, and the paste would send their draft
        // along with the message. So the text is readied first, then the screen looked at once
        // more right before pasting, and typing waits again if the prompt isn't bare. A moment
        // remains, but only as long as the paste itself.
        if (
          notReady(await readSession(socket, name), marks) === "" &&
          (waits.hold?.() ?? "") === ""
        )
          break;
      } else if (Date.now() > deadline) {
        const waited = `${timeout / 1000}s`;
        // A person's draft gets a plain answer, as it isn't the agent being busy.
        if (why === draftReason)
          throw new Error(
            `${name} had an unsent draft at its prompt for ${waited}, so nothing was typed`,
          );
        throw new Error(`${name} wasn't idle for ${waited} (${why || held}), so nothing was typed`);
      }
    }
    // The hold's last look may have cancelled the message, such as one that went stale. The
    // last look can also take a while on a plugin's host, and the agent may have asked a
    // question meanwhile, which the paste would land in.
    if (waits.signal?.aborted) return "not typed";
    // Without the paste marks, Claude Code reads the Enter after a long message as a new line,
    // and the message is never sent. So the Enter goes on its own, a moment after the paste.
    await pasteStaged(socket, name, staged.at(-1) ?? "");
    await Bun.sleep(moment);
    // Someone who scrolled back since the paste would take the Enter into copy mode, and the
    // message would sit at the prompt unsent. So the Enter waits while the caller holds it. The
    // message is in by now, so a hold that cancels it no longer stops the Enter.
    while ((waits.hold?.() ?? "") !== "") await Bun.sleep(moment);
    if (waits.signal?.aborted && waits.signal.reason === forQuestion) return "left unsent";
    await sendKey(socket, name, "Enter");
    return "typed";
  } finally {
    for (const readied of staged) dropStaged(socket, readied);
  }
}

// Returns the session's host when it is a plugin that provides the transport, so it is asked to
// carry text itself, or nothing when the built-in carries it.
const hostTransport = (host: Host): PluginHost | undefined =>
  typeof host !== "string" && host.transport ? host : undefined;

// Has a host with its own transport type the message once its agent is idle, and returns
// "typed", or "not typed" once the signal aborts first. The host waits for a person's draft
// itself, and gives up after the timeout, which throws its reason. Its command is killed on the
// abort, so it types nothing after: a host such as herdr types in one step, so nothing is left
// pasted unsent for a question.
async function deliverOnHost(
  host: PluginHost,
  id: string,
  text: string,
  waits: Waits,
): Promise<Typed> {
  if (waits.signal?.aborted) return "not typed";
  const timeout = waits.timeout ?? 60_000;
  const question = { ask: "deliver", id, text, timeout: Number.isFinite(timeout) ? timeout : null };
  // The host gets half a minute past its own timeout to say it gave up, then is ended.
  const limit = Number.isFinite(timeout) ? timeout + 30_000 : Infinity;
  try {
    await askHost(host, question, z.unknown(), { signal: waits.signal, timeout: limit });
  } catch (error) {
    if (waits.signal?.aborted) return "not typed";
    throw error;
  }
  return "typed";
}
