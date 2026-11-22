// The commands agents run: a builder submitting its work, the hooks that tell the daemon what an
// agent is doing, and what the lead and builders use to tell each other and mark a thread as needing you.
import { runByAgent } from "../agents/sandbox.ts";
import { readAsked, splitTaskName, usage } from "./input.ts";

const oldHookNames = new Map([
  ["question asked", "question-asked"],
  ["question closed", "question-closed"],
  ["question answered", "prompt"],
  ["turn ended", "turn-ended"],
  ["turn failed", "turn-failed"],
  ["turn interrupted", "turn-interrupted"],
]);

export async function agentCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const {
    reportQuestion,
    reportTurnEnded,
    reportTurnFailed,
    reportTurnInterrupted,
    submitForReview,
  } = await import("../client.ts");
  if (command === "submit" && sub && rest.length === 0) {
    const thread = await submitForReview(sub);
    console.log(
      `Submitted ${thread} for review. Skelcrew pushes it and opens or updates the pull request. If the reviewer asks for changes, Skelcrew types them in here.`,
    );
    return;
  }
  const event = command === "hook" ? sub : oldHookNames.get(`${command} ${sub}`);
  const report = new Map([
    ["question-asked", () => reportQuestion("asked")],
    ["question-closed", () => reportQuestion("closed")],
    ["prompt", () => reportQuestion("answered")],
    ["turn-ended", reportTurnEnded],
    [
      "turn-failed",
      async () => reportTurnFailed(process.stdin.isTTY ? "" : await Bun.stdin.text()),
    ],
    ["turn-interrupted", reportTurnInterrupted],
  ]).get(event ?? "");
  if (report && rest.length === 0) return report();
  usage(command);
}

export async function askCommand(args: string[]): Promise<void> {
  const [command, first, ...rest] = args;
  const { postItem } = await import("../client.ts");
  if (first === "--clear") {
    if (rest.length !== 1) usage(command);
    const about = rest[0] ?? "";
    const [repository, task] = splitTaskName(about) ?? [about, undefined];
    console.log(`Took the item on ${await postItem(repository, task, "clear")} off.`);
    return;
  }
  const [text, ...flags] = rest;
  const options: string[] = [];
  let title: string | undefined;
  for (let at = 0; at < flags.length; at += 1) {
    const flag = flags[at];
    if (flag === "--yes-no") {
      options.push("yes", "no");
      continue;
    }
    const value = flags[at + 1];
    at += 1;
    if (value === undefined) usage(command);
    if (flag === "--option") options.push(value);
    else if (flag === "--title" && title === undefined) title = value;
    else usage(command);
  }
  if (!first || !text?.trim()) usage(command);
  const [repository, task] = splitTaskName(first) ?? [first, undefined];
  const about = await postItem(repository, task, {
    ...(title === undefined ? {} : { title }),
    text,
    options,
  });
  console.log(`Asked the human about ${about}. Their answer comes back to you as a note.`);
}

export async function tellCommand(args: string[]): Promise<void> {
  const command = args[0];
  const { briefOtherLead, tellOn, tellTheLead } = await import("../client.ts");
  if (!runByAgent())
    throw new Error(
      "sc tell is for the lead and builders. To type to a builder, pick it in the sidebar, or press Enter on it in sc --list.",
    );
  const flag = args.indexOf("--asked-file");
  const askedFile = flag < 0 ? undefined : args[flag + 1];
  if (flag >= 0 && (askedFile === undefined || args.lastIndexOf("--asked-file") !== flag))
    usage(command);
  const [, to, text, ...rest] = flag < 0 ? args : args.toSpliced(flag, 2);
  const words = rest[0];
  if (to === "lead" && text !== undefined && words !== undefined && rest.length === 1) {
    const brief = words === "-" ? await Bun.stdin.text() : words;
    if (!brief.trim())
      throw new Error(`sc tell lead ${text} needs the brief, as words or on stdin`);
    const asked = askedFile === undefined ? undefined : await readAsked(askedFile);
    const name = await briefOtherLead(text, brief, asked);
    console.log(`Telling ${name}'s lead. Skelcrew types it in once that lead is idle.`);
    return;
  }
  if (askedFile !== undefined) usage(command);
  const task = to === "lead" ? undefined : splitTaskName(to);
  if (to === "lead" && text && rest.length === 0) {
    await tellTheLead(text);
    console.log("Telling the lead. Skelcrew types it in once the lead is idle.");
    return;
  }
  if (task && text && rest.length === 0) {
    const message = text === "-" ? await Bun.stdin.text() : text;
    if (!message.trim()) throw new Error(`sc tell ${to} needs the message, as words or on stdin`);
    console.log(await tellOn(...task, message));
    return;
  }
  usage(command, to);
}
