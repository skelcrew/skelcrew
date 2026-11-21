// The commands agents run: a builder submitting its work, the hooks that tell the daemon what an
// agent is doing, and what the lead and builders use to ask, tell and mark a thread as needing you.
import { readAsked, splitThreadName, usage } from "./input.ts";
import { startCommand } from "./threads.ts";

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
  if (command === "question" && rest.length === 0) {
    if (sub === "asked" || sub === "answered" || sub === "closed") {
      await reportQuestion(sub);
      return;
    }
  }
  if (command === "turn" && sub === "ended" && rest.length === 0) {
    await reportTurnEnded();
    return;
  }
  if (command === "turn" && sub === "failed" && rest.length === 0) {
    await reportTurnFailed(process.stdin.isTTY ? "" : await Bun.stdin.text());
    return;
  }
  if (command === "turn" && sub === "interrupted" && rest.length === 0) {
    await reportTurnInterrupted();
    return;
  }
  if (command === "attached" && args.length === 1) return;
  usage(command);
}

export async function askCommand(args: string[]): Promise<void> {
  const [, first, second, repository, ...more] = args;
  if (first === "start") return startCommand(args.slice(1), true);
  if (first !== "repo" || second !== "add" || !repository || more.length > 0) usage("ask");
  const { askHuman } = await import("../client.ts");
  console.log(await askHuman({ kind: "repo add", repository }));
}

export async function needsYouCommand(args: string[]): Promise<void> {
  const [command, first, second, ...rest] = args;
  const { markNeedsYou } = await import("../client.ts");
  if (first === "--clear" && rest.length === 0) {
    const thread = splitThreadName(second);
    if (!thread) usage(command);
    const { thread: name, needsYou } = await markNeedsYou(...thread, null);
    console.log(
      needsYou
        ? `Cleared ${name}'s mark. It still needs you for something Skelcrew sees itself.`
        : `${name} no longer needs you.`,
    );
    return;
  }
  const thread = splitThreadName(first);
  if (!thread || !second?.trim() || rest.length > 0) usage(command);
  const { thread: name } = await markNeedsYou(...thread, second.trim());
  console.log(`${name} needs you: ${second.trim()}. sc needs-you --clear ${name} clears it.`);
}

export async function tellCommand(args: string[]): Promise<void> {
  const command = args[0];
  const { briefOtherLead, tellOn, tellTheLead } = await import("../client.ts");
  if (process.env.SKELCREW_SANDBOX !== "1")
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
  const task = to === "lead" ? undefined : splitThreadName(to);
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
  usage(command);
}
