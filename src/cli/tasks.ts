// The commands that show tasks and threads, and the one that files a task: sc ps, sc ls, sc show
// and sc task add.
import { bodyFor, readAsked, splitTaskName, taskFrom, usage } from "./input.ts";

export async function psCommand(args: string[], json: boolean): Promise<void> {
  const { askForRepositories, askForThreads } = await import("../client.ts");
  const { printThreads } = await import("../flow/list.ts");
  const all = args.includes("--all");
  const rest = args.filter((word) => word !== "--all");
  if (rest.length > 2) usage("ps");
  const { threads, slots } = await askForThreads(rest[1]);
  printThreads(all ? threads : threads.filter((row) => row.status !== "done"), json);
  if (json) return;
  if (slots.length > 0) console.log("");
  for (const { holder, since } of slots) {
    const minutes = Math.floor((Date.now() - since) / 60_000);
    const held = minutes === 0 ? "less than a minute" : `${minutes} min`;
    const who =
      holder === "you" ? "You hold" : `${holder.charAt(0).toUpperCase()}${holder.slice(1)} holds`;
    console.log(`${who} a check slot, for ${held}.`);
  }
  const waiting = (await askForRepositories()).filter(
    (r) => r.installWaiting && (rest[1] === undefined || [r.name, r.repository].includes(rest[1])),
  );
  for (const r of waiting)
    console.log(
      `${r.name} needs you: its plugins aren't all installed here, so its tasks wait. Run sc install.`,
    );
}

export async function lsCommand(command: string, words: string[], json: boolean): Promise<void> {
  const { askForTasks } = await import("../client.ts");
  const { printTasks } = await import("../flow/list.ts");
  const all = words.includes("--all");
  const rest = words.filter((word) => word !== "--all");
  if (rest.length > 1) usage(command);
  const tasks = await askForTasks(rest[0]);
  const shown = all ? tasks : tasks.filter((t) => t.stage !== "merged" && t.stage !== "closed");
  printTasks(shown, json);
}

export async function showCommand(command: string, words: string[], json: boolean): Promise<void> {
  const { askForTask } = await import("../client.ts");
  const { printTask } = await import("../flow/list.ts");
  const task = splitTaskName(words[0]);
  if (!task || words.length !== 1) usage(command);
  printTask(await askForTask({ repo: task[0], task: task[1] }), json);
}

export async function taskCommand(args: string[]): Promise<void> {
  const [command, sub, repository, ...rest] = args;
  const { createTask, fileTask } = await import("../client.ts");
  if (sub !== "add" || !repository) usage(command);
  const onStdin = rest[0] === "--issue" || rest[0] === "--asked-file";
  const words = onStdin ? [] : rest.slice(0, 2);
  const options = onStdin ? rest : rest.slice(2);
  const flags = new Map<string, string>();
  for (let at = 0; at < options.length; at++) {
    const [flag = "", value] = [options[at], options[at + 1]];
    if (flag === "--issue" && !flags.has(flag)) flags.set(flag, "");
    else if (flag === "--asked-file" && value && !flags.has(flag)) {
      flags.set(flag, value);
      at++;
    } else usage(command);
  }
  const issue = flags.has("--issue");
  const askedFile = flags.get("--asked-file");
  if (askedFile !== undefined && !issue) usage(command);
  const shown = issue ? "sc task add --issue" : "sc task add";
  const [title, body] = words;
  let given: { title: string; body: string } | undefined;
  if (title && body !== undefined && words.length === 2)
    given = { title, body: bodyFor(shown, body) };
  else if (words.length === 0 && !process.stdin.isTTY)
    given = taskFrom(await Bun.stdin.text(), shown);
  if (!given) usage(command);
  if (issue) {
    const asked = askedFile === undefined ? undefined : await readAsked(askedFile);
    const task = await createTask(repository, given.title, given.body, asked);
    console.log(`Opened ${task} as an issue in the tracker. sc start ${task} starts it.`);
    return;
  }
  const { task, already } = await fileTask(repository, given.title, given.body);
  console.log(
    already
      ? `${task} already holds this task in the backlog, so nothing more was filed. sc start ${task} starts it.`
      : `Filed ${task} in the backlog. sc start ${task} starts it.`,
  );
}
