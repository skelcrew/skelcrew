// skel's command line: reads the command and hands it to the file that does it.
import { help } from "./help.ts";
import {
  addServer,
  keepingTitle,
  notSetUp,
  outdated,
  outOfDate,
  remote,
} from "./machine/remote.ts";
import { addSprite, remoteSprite } from "./machine/sprite.ts";
import { errorText } from "./say.ts";
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
  page: "showing a page",
  "first-run": "setting up this machine",
  "remote add": "setting up a machine",
};

// Returns the repository and task in a name such as app-13, or nothing when it isn't one.
// Repository names can hold dashes, so the task is the number after the last one.
function taskName(word?: string): [string, number] | undefined {
  const parts = word?.match(/^(.+)-(\d+)$/);
  return parts?.[1] ? [parts[1], Number(parts[2])] : undefined;
}

// Prints why a command can't run as given, and ends skel with an error. People who mistype a
// command skel knows hear to check its arguments, not that the command doesn't exist.
function usage(command?: string): never {
  const known = [
    "serve",
    "repo",
    "ps",
    "task",
    "start",
    "stop",
    "attach",
    "review",
    "submit",
    "tell",
  ];
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

// Sets up skel if it needs it and opens the screen on the lead, with the repository you ran
// skel from as its default, or the one --from names.
async function leadCommand(from?: string): Promise<void> {
  const { attachToLead } = await import("./client.ts");
  const { bringInFrom } = await import("./flow/repo.ts");
  const { firstRun } = await import("./machine/setup.ts");
  firstRun();
  await attachToLead("skel", await bringInFrom(from));
}

// Runs what keeps this machine going: its setup, then the daemon.
async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  const { serve } = await import("./flow/daemon.ts");
  const { firstRun } = await import("./machine/setup.ts");
  // Run by skel remote add on the machine it sets up, not by people, so usage leaves it out.
  if (command === "first-run" && args.length === 1) {
    firstRun();
    return;
  }
  if (command === "serve" && args.length === 1) {
    await serve("skel");
    return;
  }
  usage(command);
}

// Runs a pane of the screen: the sidebar or a page. The screen starts these, not people, so
// usage leaves them out.
async function screenCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { pageOf, screenOpened } = await import("./client.ts");
  const { runPage } = await import("./screen/page.ts");
  const { runSidebar } = await import("./screen/sidebar.ts");
  // The last word is the remote skel runs on, and empty on this machine.
  if (command === "sidebar" && sub && rest[0] && rest[1] !== undefined && rest.length === 2) {
    // Not waited on, so the sidebar draws at once.
    screenOpened();
    await runSidebar(sub, rest[0], rest[1]);
    return;
  }
  if (command === "page" && sub && rest.length === 0) {
    await runPage(sub, pageOf(sub));
    return;
  }
  usage(command);
}

// Lists, removes or trusts a repository, for skel repo.
async function repoCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForRepositories } = await import("./client.ts");
  const { openDb } = await import("./db.ts");
  const { listRepositories, printRepositories } = await import("./flow/list.ts");
  const { removeRepo, trustRepo } = await import("./flow/repo.ts");
  if (sub === "ls" && rest.length === 0) {
    // An agent's sandbox hides skel's database, so there the daemon answers. In your
    // terminal it is read here, so the list shows even while the daemon is down.
    printRepositories(
      process.env.SKEL_SANDBOX === "1" ? await askForRepositories() : listRepositories(openDb()),
    );
    return;
  }
  if (sub === "rm" && rest[0] && rest.length === 1) {
    await removeRepo(rest[0]);
    return;
  }
  if (sub === "trust" && rest[0] && rest.length === 1) {
    await trustRepo(rest[0]);
    return;
  }
  usage(command);
}

// Runs what agents and their hooks call: a builder submitting its work, and the hooks that
// tell the daemon about questions and bring back where you attached from.
async function agentCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForAttachedNote, reportQuestion, submitForReview } = await import("./client.ts");
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
    await reportQuestion(sub === "asked");
    return;
  }
  // Run by the lead's Claude Code hook with each message, not by people, so usage leaves it
  // out. What it prints goes into the message, unseen, so the lead hears where you attached
  // from without a turn of its own.
  if (command === "attached" && args.length === 1) {
    process.stdout.write(await askForAttachedNote());
    return;
  }
  usage(command);
}

// Prints the threads, or one repository's, for skel ps.
async function psCommand(args: string[]): Promise<void> {
  const { askForThreads } = await import("./client.ts");
  const { printThreads } = await import("./flow/list.ts");
  // --json can go anywhere, as tools add it last and people type it where they like.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  // Done threads pile up forever and would bury the live ones, so only --all shows them.
  const all = words.includes("--all");
  const rest = words.filter((word) => word !== "--all");
  if (rest.length > 2) usage("ps");
  const rows = await askForThreads(rest[1]);
  printThreads(all ? rows : rows.filter((row) => row.status !== "done"), json);
}

// Lists tasks, shows one or creates one, for skel task. Only ls and show take --json: to
// create, it is a word like any other.
async function taskCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForTask, askForTasks, createTask } = await import("./client.ts");
  const { printTask, printTasks } = await import("./flow/list.ts");
  // --json can go anywhere, as tools add it last and people type it where they like.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  if (sub === "ls" && words.length <= 3) {
    printTasks(await askForTasks(words[2]), json);
    return;
  }
  const shown = taskName(words[2]);
  if (sub === "show" && shown && words.length === 3) {
    printTask(await askForTask(...shown), json);
    return;
  }
  const [repository, title, body] = rest;
  if (sub === "create" && repository && title && body !== undefined && rest.length === 3) {
    console.log(await createTask(repository, title, body));
    return;
  }
  usage(command);
}

// Starts, stops, re-reviews or attaches to the thread on a task, named such as app-13.
async function threadCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { attachToThread, reviewAgain, startOn, stopOn } = await import("./client.ts");
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
  usage(command);
}

// Types a message into a thread's builder, for the lead, or into the lead, for a builder. Who
// may tell whom is the daemon's to decide, from the socket the call comes in on. You type to
// a builder yourself, so in your terminal it only says how.
async function tellCommand(args: string[]): Promise<void> {
  const [command, to, text, ...rest] = args;
  const { tellOn, tellTheLead } = await import("./client.ts");
  if (process.env.SKEL_SANDBOX !== "1")
    throw new Error(
      "skel tell is for the lead and builders. To type to a builder, pick it in the sidebar.",
    );
  const thread = taskName(to);
  if (to === "lead" && text && rest.length === 0) {
    await tellTheLead(text);
    console.log("Telling the lead. skel types it in once the lead is idle.");
    return;
  }
  if (thread && text && rest.length === 0) {
    const name = await tellOn(...thread, text);
    console.log(`Telling ${name}'s builder. skel types it in once the builder is idle.`);
    return;
  }
  usage(command);
}

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and opens the screen on the lead. The checks here come first,
// in this order, and the functions above run the commands that are left.
async function runCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  // Before the check below, so a server whose skel differs from the laptop's still says what
  // it is.
  if (args.length === 1 && command === "--version") {
    console.log(versionLine());
    return;
  }
  // A sidebar or page is started by a skel that passed this check, and its tmux server can hand
  // it the build of whichever laptop started the server, so it would refuse to run.
  const onScreen = command === "sidebar" || command === "page";
  if (!onScreen && outOfDate()) process.exit(outdated);
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
  // Commands that run here load what they need only from this point on, so skel --remote
  // starts quickly and loads no part of the daemon on your laptop.
  const { setupDone } = await import("./machine/setup.ts");
  // A sidebar, a page or an agent can inherit this name from whoever started tmux, and its
  // sandbox hides what setupDone reads.
  const remoteName = process.env.SKEL_REMOTE_NAME;
  if (
    remoteName &&
    command !== "first-run" &&
    !onScreen &&
    process.env.SKEL_SANDBOX !== "1" &&
    !setupDone()
  )
    throw new Error(notSetUp(remoteName));
  if (args.length === 0 || (command === "--from" && sub && rest.length === 0))
    return leadCommand(sub);
  switch (command) {
    case "first-run":
    case "serve":
      return machineCommand(args);
    case "sidebar":
    case "page":
      return screenCommand(args);
    case "repo":
      return repoCommand(args);
    case "submit":
    case "question":
    case "attached":
      return agentCommand(args);
    case "ps":
      return psCommand(args);
    case "task":
      return taskCommand(args);
    case "start":
    case "stop":
    case "review":
    case "attach":
      return threadCommand(args);
    case "tell":
      return tellCommand(args);
    default:
      usage(command);
  }
}

try {
  await runCommand(process.argv.slice(2));
} catch (error) {
  console.error(`skel: ${errorText(error)}`);
  process.exit(1);
}
