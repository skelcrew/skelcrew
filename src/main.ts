// skel's command line: reads the command and hands it to the file that does it.
import { remote, updateServer } from "./remote.ts";
import { remoteSprite, updateSprite } from "./sprite.ts";

const usage = `Usage:
  skel [--from <owner/repo>]
  skel --remote <host> [command]
  skel --remote sprite:<name> [command]
  skel update --remote <host>
  skel update --remote sprite:<name>
  skel serve
  skel repo ls
  skel repo rm <name>
  skel repo trust <name>
  skel ps [<repo>] [--all] [--json]
  skel task ls [<repo>] [--json]
  skel task show <repo>-<task> [--json]
  skel task create <repo> "<title>" "<body>"
  skel start <repo>-<task> [--from <branch>]
  skel attach <repo>-<task>
  skel review <repo>-<task>
  skel submit "<summary>"`;

// What an agent may not run, in its words. Its sandbox hides skel's database, your settings
// and your logins, so these would act on an empty database or ask what nobody can answer.
// Trusting a repository is yours alone even with the database at hand: a yes passed on by
// the lead could come from an injected instruction.
const yoursOnly: Record<string, string> = {
  "": "attaching to the lead",
  serve: "running the daemon",
  "repo rm": "removing a repository",
  "repo trust": "trusting a repository",
  attach: "attaching to a thread",
};

// Returns the repository and task in a name such as app-13, or nothing when it isn't one.
// Repository names can hold dashes, so the task is the number after the last one.
function taskName(word?: string): [string, number] | undefined {
  const parts = word?.match(/^(.+)-(\d+)$/);
  return parts?.[1] ? [parts[1], Number(parts[2])] : undefined;
}

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and attaches you to the lead.
async function run(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  if (command === "--remote" && sub?.startsWith("sprite:"))
    process.exit(await remoteSprite(sub.slice("sprite:".length), rest));
  if (command === "--remote" && sub) process.exit(await remote(sub, rest));
  // update builds skel here and puts it on the other machine, so it only makes sense with
  // --remote, and runs on the laptop rather than over there.
  if (command === "update") {
    const where = sub === "--remote" && rest.length === 1 ? rest[0] : undefined;
    if (!where)
      throw new Error(
        "update puts a new skel on a server or Sprite: skel update --remote <host>, or skel update --remote sprite:<name>",
      );
    process.exit(
      where.startsWith("sprite:")
        ? await updateSprite(where.slice("sprite:".length))
        : await updateServer(where),
    );
  }
  const named = command === undefined || command === "--from" ? "" : command;
  const refused = yoursOnly[command === "repo" ? `repo ${sub}` : named];
  if (process.env.SKEL_SANDBOX === "1" && refused)
    throw new Error(`${refused} is only for your own terminal, not for agents`);
  // Loaded only for commands that run here, so skel --remote never loads the parts made for
  // the Linux server, such as the sandbox and the daemon's lock, on a laptop that can be a
  // Mac.
  const {
    attached,
    attachToLead,
    createTask,
    question,
    repos,
    reviewAgain,
    serve,
    startOn,
    submitForReview,
    task,
    tasks,
    threads,
  } = await import("./daemon.ts");
  const { openDb } = await import("./db.ts");
  const { listRepositories, printRepositories, printTask, printTasks, printThreads } = await import(
    "./list.ts"
  );
  const { bringInFrom, removeRepo, trustRepo } = await import("./repo.ts");
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
    // An agent's sandbox hides skel's database, so there the daemon answers. In your
    // terminal it is read here, so the list shows even while the daemon is down.
    printRepositories(
      process.env.SKEL_SANDBOX === "1" ? await repos() : listRepositories(openDb()),
    );
    return;
  }
  if (command === "repo" && sub === "rm" && rest[0] && rest.length === 1) {
    await removeRepo(rest[0]);
    return;
  }
  if (command === "submit" && sub && rest.length === 0) {
    const thread = await submitForReview(sub);
    console.log(
      `Submitted ${thread} for review. skel pushes it and opens or updates the pull request. If the reviewer asks for changes, skel types them in here.`,
    );
    return;
  }
  // Run by a builder's Claude Code hooks, not by people, so usage leaves it out. It prints
  // nothing: Claude Code adds what a UserPromptSubmit hook prints to the builder's message.
  if (command === "question" && (sub === "asked" || sub === "answered") && rest.length === 0) {
    await question(sub === "asked");
    return;
  }
  // Run by the lead's Claude Code hook with each message, not by people, so usage leaves it
  // out. What it prints goes into the message, unseen, so the lead hears where you attached
  // from without a turn of its own.
  if (command === "attached" && args.length === 1) {
    process.stdout.write(await attached());
    return;
  }
  if (command === "repo" && sub === "trust" && rest[0] && rest.length === 1) {
    await trustRepo(rest[0]);
    return;
  }
  // --json can go anywhere, as tools add it last and people type it where they like.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  if (command === "ps") {
    // Done threads pile up forever and would bury the live ones, so only --all shows them.
    const all = words.includes("--all");
    const rest = words.filter((word) => word !== "--all");
    if (rest.length <= 2) {
      const rows = await threads(rest[1]);
      printThreads(all ? rows : rows.filter((row) => row.status !== "done"), json);
      return;
    }
  }
  if (command === "task" && sub === "ls" && words.length <= 3) {
    printTasks(await tasks(words[2]), json);
    return;
  }
  const shown = taskName(words[2]);
  if (command === "task" && sub === "show" && shown && words.length === 3) {
    printTask(await task(...shown), json);
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
  const thread = taskName(sub);
  const from = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (command === "start" && thread && (rest.length === 0 || from)) {
    console.log(`Started ${await startOn(...thread, from)}.`);
    return;
  }
  if (command === "review" && thread && rest.length === 0) {
    const name = await reviewAgain(...thread);
    console.log(
      `Reviewing ${name}'s last commit again. skel posts the review on its pull request, and types any changes into its builder.`,
    );
    return;
  }
  if (command === "attach" && thread && rest.length === 0) {
    await attachToThread("skel", ...thread);
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
