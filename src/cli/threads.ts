// The commands that act on one thread: starting, stopping, removing, reviewing, peeking at,
// interrupting and attaching to it, merging its PR, and running the checks.
import { readAsked, splitTaskName, usage } from "./input.ts";

export async function mergeCommand(args: string[]): Promise<void> {
  const [, how, named, ...rest] = args;
  const { planMerge, previewMerge } = await import("../client.ts");
  const commands = {
    "--when-ready": "merge when ready",
    "--skip-review": "merge skip review",
    "--cancel": "merge cancel",
  } as const;
  const command =
    how === "--when-ready" || how === "--skip-review" || how === "--cancel"
      ? commands[how]
      : undefined;
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag = "", value] = [rest[i], rest[i + 1]];
    if (!["--from", "--asked-file"].includes(flag) || !value || options.has(flag)) usage("merge");
    options.set(flag, value);
  }
  const given = options.get("--from");
  const asked = options.get("--asked-file");
  if (!command || named === undefined) usage("merge");
  if (asked !== undefined && command === "merge cancel") usage("merge");
  const number = named.match(/^#?(\d+)$/)?.[1];
  const task = splitTaskName(named);
  let which: { repo?: string; task?: string; pr?: number; from?: string };
  if (number !== undefined) {
    const { originHere } = await import("../machine/origin.ts");
    const from = given ?? originHere() ?? undefined;
    which = { pr: Number(number), ...(from ? { from } : {}) };
  } else if (task && !given) which = { repo: task[0], task: task[1] };
  else usage("merge", named);
  if (asked !== undefined) {
    console.log(await planMerge(command, { ...which, asked: await readAsked(asked) }));
    return;
  }
  if (command !== "merge cancel") {
    if (!process.stdin.isTTY)
      throw new Error(`sc merge ${how} asks you first, so run it at your own terminal`);
    const skip = command === "merge skip review";
    const { thread, pr, title, started, merging, head, asks, agents, ready } =
      await previewMerge(which);
    if (pr === null) throw new Error(`${thread} has no PR yet: ask again once it opens one`);
    if (merging !== null) {
      console.log(merging);
      return;
    }
    if (skip && head === null)
      throw new Error(`Skelcrew hasn't seen #${pr}'s newest commit yet: ask again shortly`);
    const { removeControlCodes } = await import("../screen/look.ts");
    const shown = title ? ` ${removeControlCodes(title)}` : "";
    const question = skip
      ? `Merge #${pr} (${thread}${shown}) without Skelcrew's approval? CI must still pass. ${removeControlCodes(asks)}`
      : `Merge #${pr} (${thread}${shown}) when ${ready}?`;
    const answer = prompt([question, agents, "[y/N]"].filter(Boolean).join(" "));
    if (answer !== "y") {
      const now = await previewMerge(which);
      console.log(now.merging ?? `Not merging: ${now.thread} waits for you to merge it.`);
      return;
    }
    const seen = { pr, started, ...(skip && head !== null ? { head } : {}) };
    console.log(await planMerge(command, { ...which, seen }));
    return;
  }
  console.log(await planMerge(command, which));
}

export async function checkCommand(args: string[]): Promise<void> {
  if (args.length !== 1) usage(args[0]);
  const { takeCheckSlot } = await import("../client.ts");
  const { originHere } = await import("../machine/origin.ts");
  const from = process.env.SKELCREW_SOCKET ? undefined : (originHere() ?? undefined);
  let suite: number | null = null;
  const slot = await takeCheckSlot({
    queued: (place) =>
      console.log(
        `Waiting for a check slot: number ${place} in line. The tests start once one is free.`,
      ),
    ended: (why) => {
      if (suite !== null)
        try {
          process.kill(-suite, "SIGKILL");
        } catch {}
      console.error(`The check ended, as ${why}.`);
      process.exit(1);
    },
    from,
  });
  if (slot.test.length === 0) {
    console.log("This repository is configured with no tests, so there is nothing to run.");
    return;
  }
  const watched = `(cat <&4 >/dev/null; kill -KILL 0) & exec 4<&-; ${slot.test.join(" && ")}`;
  const run = Bun.spawn(["sh", "-c", watched], {
    stdio: ["inherit", "inherit", "inherit", "ignore", "pipe"],
    detached: true,
  });
  suite = run.pid;
  process.exit(await run.exited);
}

export async function startCommand(args: string[]): Promise<void> {
  const [, sub, ...rest] = args;
  const { namesRepository, startOn } = await import("../client.ts");
  const task = splitTaskName(sub);
  if (sub !== undefined && (!task || (await namesRepository(sub))))
    throw new Error(
      `sc start takes only a task now, such as sc start APP-12. To start new work in ${sub}, run sc add ${sub} "<title>" "<body>" --start, or sc add ${sub} --start with the title and body on stdin. It takes --short and --flow as sc start did.`,
    );
  if (!task) return usage("start");
  const option = (name: string) => {
    const at = rest.indexOf(name);
    const value = at === -1 ? undefined : rest[at + 1]?.trim();
    if (at !== -1 && !value) usage("start");
    return { at, value };
  };
  const { at: shortAt, value: short } = option("--short");
  const { at: flowAt, value: flow } = option("--flow");
  const nowAt = rest.indexOf("--now");
  const setupAt = rest.indexOf("--setup");
  const keepAts = rest.flatMap((word, at) => (word === "--keep" ? [at] : []));
  const keep = keepAts.map((at) => rest[at + 1] ?? "");
  if (keep.some((item) => !item.trim()) || keep.length === 1 || keep.length > 4) usage("start");
  const taken = [
    ...[shortAt, flowAt, ...keepAts].flatMap((at) => (at === -1 ? [] : [at, at + 1])),
    ...[nowAt, setupAt].filter((at) => at !== -1),
  ];
  const words = rest.filter((_, i) => !taken.includes(i));
  const from = words[0] === "--from" && words[1] && words.length === 2 ? words[1] : undefined;
  if (words.length > 0 && !from) return usage("start");
  const now = nowAt === -1 ? undefined : true;
  const setup = setupAt === -1 ? undefined : true;
  console.log(await startOn(...task, from, short, flow, now, keep, setup));
}

async function removeCommand(task: [string, string], rest: string[]): Promise<void> {
  const { previewRemoval, removeOn } = await import("../client.ts");
  const keepAt = rest.indexOf("--keep-issue");
  const askedAt = rest.indexOf("--asked-file");
  const askedFile = askedAt === -1 ? undefined : rest[askedAt + 1];
  const reasons = rest.filter(
    (_, i) => i !== keepAt && (askedAt === -1 || (i !== askedAt && i !== askedAt + 1)),
  );
  if (
    reasons.length > 1 ||
    (askedAt !== -1 && !askedFile) ||
    rest.lastIndexOf("--keep-issue") !== keepAt ||
    rest.lastIndexOf("--asked-file") !== askedAt
  )
    usage("rm");
  const keepIssue = keepAt !== -1;
  const reason = reasons[0] || undefined;
  if (process.stdin.isTTY) {
    const { thread: name, status, pr, issue } = await previewRemoval(...task, keepIssue);
    const goes =
      status === "not started"
        ? issue === null
          ? "It never started, and this deletes it from the backlog on every machine."
          : `It never started, and this closes issue ${issue}.`
        : status === "done"
          ? `Its work ended already, and this closes issue ${issue ?? ""}.`
          : pr === null
            ? `This deletes its branch and clone${issue === null ? "" : `, and closes issue ${issue}`}.`
            : issue === null
              ? `This closes PR #${pr} and deletes its branch and clone.`
              : `This closes PR #${pr} and issue ${issue}, and deletes its branch and clone.`;
    const answer =
      status === "done" && issue === null ? "y" : prompt(`Remove ${name}? ${goes} [y/N]`);
    if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
      console.log(`Skelcrew didn't remove ${name}.`);
      return;
    }
  }
  const asked = askedFile === undefined ? undefined : await readAsked(askedFile);
  const {
    removed: name,
    issue,
    unfiled,
    closed,
  } = await removeOn(...task, {
    reason,
    keepIssue,
    asked,
  });
  if (unfiled) console.log(`Removed ${name} from the backlog.`);
  else if (issue === null) console.log(`Removed ${name}. sc start ${name} starts it over.`);
  else if (closed) console.log(`Removed ${name} and closed issue ${issue}.`);
  else
    console.log(`Removed ${name}. Issue ${issue} stays open, and sc start ${name} starts it over.`);
}

export async function threadCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  if (command === "rm" || command === "review") {
    const task = splitTaskName(sub);
    if (!task) return usage(command);
    if (command === "rm") return removeCommand(task, rest);
    if (rest.length > 0) usage(command);
    const { reviewAgain } = await import("../client.ts");
    const name = await reviewAgain(...task);
    console.log(
      `Reviewing ${name}'s last commit again. Skelcrew posts the review on its pull request, and types any changes into its builder.`,
    );
    return;
  }
  const thread = splitTaskName(sub);
  if (!thread || rest.length > 0) return usage(command, sub);
  const { interruptOn, peekAt, stopOn } = await import("../client.ts");
  if (command === "stop") {
    const name = await stopOn(...thread);
    console.log(
      `Stopped ${name}. Its clone, branch and pull request stay, and sc start ${name} brings its builder back.`,
    );
    return;
  }
  if (command === "peek") {
    const { screen } = await peekAt(...thread);
    console.log(screen.trimEnd());
    return;
  }
  if (command === "interrupt") {
    const name = await interruptOn(...thread);
    console.log(`Stopped ${name}'s turn, as Esc does. sc tell ${name} gives it what to do next.`);
    return;
  }
  if (command === "attach") {
    const { attachToThread } = await import("../attach.ts");
    await attachToThread("skelcrew", ...thread);
    return;
  }
  usage(command);
}
