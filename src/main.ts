// skel's command line: reads the command and hands it to the file that does it.
import { attachToLead, createTask, serve, startOn, tasks, threads } from "./daemon.ts";
import { printTasks, printThreads } from "./list.ts";
import { bringInFrom, listRepos, removeRepo, trustRepo } from "./repo.ts";
import { firstRun } from "./setup.ts";

const usage = `Usage:
  skel [--from <owner/repo>]
  skel serve
  skel repo ls
  skel repo rm <name>
  skel repo trust <name>
  skel ps [<repo>] [--json]
  skel task ls [<repo>] [--json]
  skel task create <repo> "<title>" "<body>"
  skel start <repo>-<task> [--from <branch>]`;

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and attaches you to the lead.
async function run(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  if (args.length === 0 || (command === "--from" && sub && rest.length === 0)) {
    firstRun();
    await bringInFrom(sub);
    await attachToLead("skel");
    return;
  }
  if (command === "serve" && args.length === 1) {
    await serve("skel");
    return;
  }
  if (command === "repo" && sub === "ls" && rest.length === 0) {
    listRepos();
    return;
  }
  if (command === "repo" && sub === "rm" && rest[0] && rest.length === 1) {
    removeRepo(rest[0]);
    return;
  }
  if (command === "repo" && sub === "trust" && rest[0] && rest.length === 1) {
    await trustRepo(rest[0]);
    return;
  }
  // --json can go anywhere, as tools add it last and people type it where they like.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  if (command === "ps" && words.length <= 2) {
    printThreads(await threads(words[1]), json);
    return;
  }
  if (command === "task" && sub === "ls" && words.length <= 3) {
    printTasks(await tasks(words[2]), json);
    return;
  }
  const [repo, title, body] = rest;
  if (
    command === "task" &&
    sub === "create" &&
    repo &&
    title &&
    body !== undefined &&
    rest.length === 3
  ) {
    console.log(await createTask(repo, title, body));
    return;
  }
  // Repository names can hold dashes, so the task is the number after the last one.
  const thread = sub?.match(/^(.+)-(\d+)$/);
  const from = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (command === "start" && thread?.[1] && (rest.length === 0 || from)) {
    console.log(`Started ${await startOn(thread[1], Number(thread[2]), from)}.`);
    return;
  }
  console.error(usage);
  process.exit(1);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
