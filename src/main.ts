// skel's command line: reads the command and hands it to the file that does it.
import { remote } from "./remote.ts";

const usage = `Usage:
  skel [--from <owner/repo>]
  skel --remote <host> [command]
  skel serve
  skel repo ls
  skel repo rm <name>
  skel repo trust <name>
  skel ps [<repo>] [--json]
  skel task ls [<repo>] [--json]
  skel task create <repo> "<title>" "<body>"
  skel start <repo>-<task> [--from <branch>]
  skel attach <repo>-<task>
  skel submit "<summary>"`;

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and attaches you to the lead.
async function run(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  if (command === "--remote" && sub) process.exit(await remote(sub, rest));
  // Loaded only for commands that run here, so skel --remote never loads the parts made for
  // the Linux server, such as the sandbox and the daemon's lock, on a laptop that can be a
  // Mac.
  const { attachToLead, createTask, serve, startOn, submitForReview, tasks, threads } =
    await import("./daemon.ts");
  const { printTasks, printThreads } = await import("./list.ts");
  const { bringInFrom, listRepos, removeRepo, trustRepo } = await import("./repo.ts");
  const { firstRun } = await import("./setup.ts");
  const { attachToThread } = await import("./thread.ts");
  if (args.length === 0 || (command === "--from" && sub && rest.length === 0)) {
    firstRun();
    await attachToLead("skel", await bringInFrom(sub));
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
  if (command === "submit" && sub && rest.length === 0) {
    const thread = await submitForReview(sub);
    console.log(
      `Submitted ${thread} for review. skel pushes it and opens or updates the pull request. If the reviewer asks for changes, skel types them in here.`,
    );
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
  if (command === "attach" && thread?.[1] && rest.length === 0) {
    await attachToThread("skel", thread[1], Number(thread[2]));
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
