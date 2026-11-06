// skel's command line: reads the command and hands it to the file that does it.
import { help } from "./help.ts";
import { addServer, keepingTitle, notSetUp, outdated, outOfDate, remote } from "./remote.ts";
import { addSprite, remoteSprite } from "./sprite.ts";
import { versionLine } from "./version.ts";

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
  sidebar: "showing the sidebar",
  "first-run": "setting up this machine",
  "remote add": "setting up a machine",
};

// Returns the repository and task in a name such as app-13, or nothing when it isn't one.
// Repository names can hold dashes, so the task is the number after the last one.
function taskName(word?: string): [string, number] | undefined {
  const parts = word?.match(/^(.+)-(\d+)$/);
  return parts?.[1] ? [parts[1], Number(parts[2])] : undefined;
}

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and opens the screen on the lead.
async function run(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  // Before the check below, so a server whose skel differs from the laptop's still says what
  // it is.
  if (args.length === 1 && command === "--version") {
    console.log(versionLine());
    return;
  }
  // A sidebar is started by a skel that passed this check, and its tmux server can hand it
  // the build of whichever laptop started the server, so it would refuse to run.
  if (command !== "sidebar" && outOfDate()) process.exit(outdated);
  if (args.length === 1 && ["--help", "-h", "help"].includes(command ?? "")) {
    console.log(help());
    return;
  }
  if (command === "--remote" && sub)
    process.exit(
      await keepingTitle(() =>
        sub.startsWith("sprite:")
          ? remoteSprite(sub.slice("sprite:".length), rest)
          : remote(sub, rest),
      ),
    );
  const named = command === undefined || command === "--from" ? "" : command;
  const refused =
    yoursOnly[command === "repo" || command === "remote" ? `${command} ${sub}` : named];
  if (process.env.SKEL_SANDBOX === "1" && refused)
    throw new Error(`${refused} is only for your own terminal, not for agents`);
  if (command === "remote" && sub === "add" && rest[0] && rest.length === 1) {
    const host = rest[0];
    process.exit(
      await keepingTitle(() =>
        host.startsWith("sprite:") ? addSprite(host.slice("sprite:".length)) : addServer(host),
      ),
    );
  }
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
    screenOpened,
    serve,
    startOn,
    stopOn,
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
  const { firstRun, setupDone } = await import("./setup.ts");
  const { runSidebar } = await import("./sidebar.ts");
  const { attachToThread } = await import("./thread.ts");
  // A sidebar or an agent can inherit this name from whoever started tmux, and its sandbox
  // hides what setupDone reads.
  const remoteName = process.env.SKEL_REMOTE_NAME;
  if (
    remoteName &&
    command !== "first-run" &&
    command !== "sidebar" &&
    process.env.SKEL_SANDBOX !== "1" &&
    !setupDone()
  )
    throw new Error(notSetUp(remoteName));
  if (args.length === 0 || (command === "--from" && sub && rest.length === 0)) {
    firstRun();
    await attachToLead("skel", await bringInFrom(sub));
    return;
  }
  // Run by skel remote add on the machine it sets up, not by people, so usage leaves it out.
  if (command === "first-run" && args.length === 1) {
    firstRun();
    return;
  }
  if (command === "serve" && args.length === 1) {
    await serve("skel");
    return;
  }
  // Run by the screen in its left pane, not by people, so usage leaves it out.
  // The last word is the remote skel runs on, and empty on this machine.
  if (command === "sidebar" && sub && rest[0] && rest[1] !== undefined && rest.length === 2) {
    // Not waited on, so the sidebar draws at once.
    screenOpened();
    await runSidebar(sub, rest[0], rest[1]);
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
    console.log(await startOn(...thread, from));
    return;
  }
  if (command === "stop" && thread && rest.length === 0) {
    const name = await stopOn(...thread);
    console.log(
      `Stopped ${name}. Its clone, branch and pull request stay, and skel start ${name} brings its builder back.`,
    );
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
  const known = ["serve", "repo", "ps", "task", "start", "stop", "attach", "review", "submit"];
  const first = command ?? "";
  console.error(
    first === "--remote"
      ? "skel: --remote needs a host, such as skel --remote simon@workbox or skel --remote sprite:demo."
      : first === "remote"
        ? "skel: skel remote add needs a host, such as skel remote add simon@workbox or skel remote add sprite:demo."
        : known.includes(first)
          ? `skel: skel ${first} was given arguments it doesn't take. Run skel --help to see how to use it.`
          : "skel: that isn't a skel command. Run skel --help to see them.",
  );
  process.exit(1);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
