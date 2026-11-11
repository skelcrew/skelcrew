// Skelcrew's command line: reads the command and hands it to the file that does it.
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

// What an agent may not run, in its words. Its sandbox hides Skelcrew's database, your settings
// and your logins, so these would act on an empty database or ask what nobody can answer.
// Trusting a repository is yours alone even with the database at hand: a yes passed on by
// the lead could come from an injected instruction.
const yoursOnly: Record<string, string> = {
  "": "attaching to the lead",
  serve: "running the daemon",
  "repo add": "adding a repository",
  "repo rm": "removing a repository",
  init: "setting up a repository for Skelcrew",
  "repo trust": "trusting a repository",
  attach: "attaching to a thread",
  sidebar: "showing the sidebar",
  page: "showing a page",
  "first-run": "setting up this machine",
  "remote add": "setting up a machine",
  "plugin install": "installing a plugin",
  "plugin update": "updating a plugin",
  "plugin setup": "setting up a plugin",
  "plugin rm": "removing a plugin",
  "plugin ls": "listing plugins",
};

// Returns the repository and task in a name such as app-13, or app-t1 for a thread with no
// tracker, or nothing when it isn't one. Repository names can hold dashes, so the task is what
// follows the last one.
function taskName(word?: string): [string, string] | undefined {
  // The greedy first group takes every dash but the last.
  const parts = word?.match(/^(.+)-(t?\d+)$/);
  return parts?.[1] && parts[2] ? [parts[1], parts[2]] : undefined;
}

// Prints why a command can't run as given, and ends Skelcrew with an error. People who mistype a
// command Skelcrew knows hear to check its arguments, not that the command doesn't exist.
function usage(command?: string): never {
  // The commands that have words after them, so a mistake there is in the arguments.
  const known = [
    "serve",
    "init",
    "repo",
    "ps",
    "task",
    "start",
    "stop",
    "attach",
    "review",
    "submit",
    "tell",
    "plugin",
  ];
  const first = command ?? "";
  console.error(
    first === "--remote"
      ? "Skelcrew: --remote needs a host, such as sc --remote simon@workbox or sc --remote sprite:demo."
      : first === "remote"
        ? "Skelcrew: sc remote add needs a host, such as sc remote add simon@workbox or sc remote add sprite:demo."
        : known.includes(first)
          ? `Skelcrew: sc ${first} was given arguments it doesn't take. Run sc --help to see how to use it.`
          : "Skelcrew: that isn't a Skelcrew command. Run sc --help to see them.",
  );
  process.exit(1);
}

// Sets up Skelcrew if it needs it and opens the screen on the lead of the repository you ran sc
// from, or the one --from names, or else the one you opened last. While Skelcrew has no
// repositories, bringInFrom has said so, and there is no lead to open.
async function leadCommand(from?: string): Promise<void> {
  // Loaded only here, so sc --remote on your laptop never loads them.
  const { attachToLead } = await import("./attach.ts");
  const { openDb } = await import("./db.ts");
  const { bringInFrom, repositories } = await import("./flow/repo.ts");
  const { firstRun } = await import("./machine/setup.ts");
  firstRun(from);
  // Adds the repository you ran sc from if Skelcrew doesn't have it yet.
  const found = await bringInFrom(from);
  if (repositories(openDb()).length > 0) await attachToLead("skelcrew", found);
}

// Runs what keeps this machine going: its setup, then the daemon.
async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  const { serve } = await import("./flow/daemon.ts");
  const { firstRun } = await import("./machine/setup.ts");
  // Run by sc remote add on the machine it sets up, not by people, so usage leaves it out.
  if (command === "first-run" && args.length === 1) {
    firstRun();
    return;
  }
  if (command === "serve" && args.length === 1) {
    await serve("skelcrew");
    return;
  }
  usage(command);
}

// Runs a pane of the screen: the sidebar or a page. The screen starts these, not people, so
// usage leaves them out.
async function screenCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { openDb } = await import("./db.ts");
  const { readPage } = await import("./flow/page.ts");
  const { runPage } = await import("./screen/page.ts");
  const { runSidebar } = await import("./screen/sidebar.ts");
  // A sidebar's third word, and a page's second, is the remote Skelcrew runs on, and empty on
  // this machine. A sidebar's last is the owner/name of the repository the screen opened on.
  const [session, where, repository] = rest;
  if (
    command === "sidebar" &&
    sub &&
    session &&
    where !== undefined &&
    repository &&
    rest.length === 3
  ) {
    await runSidebar(sub, session, where, repository);
    return;
  }
  if (command === "page" && sub && session !== undefined && rest.length === 1) {
    await runPage(sub, session, () => readPage(openDb(), sub));
    return;
  }
  usage(command);
}

// Adds, lists, removes or trusts a repository, for sc repo, or sets one up with sc init.
// --json changes only what ls prints.
async function repoCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForRepositories } = await import("./client.ts");
  const { openDb } = await import("./db.ts");
  const { listRepositories, printRepositories } = await import("./flow/list.ts");
  const { addRepo, initRepo, removeRepo, trustRepo } = await import("./flow/repo.ts");
  if (command === "init" && args.length === 1) {
    await initRepo();
    return;
  }
  if (sub === "add" && rest.length <= 1) {
    await addRepo(rest[0]);
    return;
  }
  if (sub === "ls" && rest.length === 0) {
    // An agent's sandbox hides Skelcrew's database, so there the daemon answers. In your
    // terminal it is read here, so the list shows even while the daemon is down.
    printRepositories(
      process.env.SKELCREW_SANDBOX === "1"
        ? await askForRepositories()
        : listRepositories(openDb()),
      json,
    );
    return;
  }
  if (sub === "rm" && rest[0] && rest.length === 1) {
    await removeRepo(rest[0], "skelcrew");
    return;
  }
  if (sub === "trust" && rest[0] && rest.length === 1) {
    await trustRepo(rest[0]);
    return;
  }
  usage(command);
}

// Installs, updates, sets up again, removes or lists plugins, for sc plugin. --json changes
// only what ls prints.
async function pluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { installPlugin, listPlugins, removePlugin, setUpPlugin, updatePlugins } = await import(
    "./plugins/install.ts"
  );
  // Each takes a name or a source as its one word, except update, where it is optional.
  if (sub === "install" && rest[0] && rest.length === 1) return installPlugin(rest[0]);
  if (sub === "update" && rest.length <= 1) return updatePlugins(rest[0]);
  if (sub === "setup" && rest[0] && rest.length === 1) return setUpPlugin(rest[0]);
  if (sub === "rm" && rest[0] && rest.length === 1) return removePlugin(rest[0]);
  if (sub === "ls" && rest.length === 0) return listPlugins(json);
  usage(command);
}

// Runs what agents and their hooks call: a builder submitting its work, and the hooks that
// tell the daemon about questions.
async function agentCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { reportQuestion, reportTurnEnded, submitForReview } = await import("./client.ts");
  if (command === "submit" && sub && rest.length === 0) {
    const thread = await submitForReview(sub);
    console.log(
      `Submitted ${thread} for review. Skelcrew pushes it and opens or updates the pull request. If the reviewer asks for changes, Skelcrew types them in here.`,
    );
    return;
  }
  // Run by a builder's Claude Code hooks, not by people, so usage leaves it out. It prints
  // nothing: Claude Code adds what a UserPromptSubmit hook prints to the builder's message.
  if (command === "question" && (sub === "asked" || sub === "answered") && rest.length === 0) {
    await reportQuestion(sub === "asked");
    return;
  }
  // Run by a Codex builder's Stop hook, not by people, so usage leaves it out. It prints
  // nothing, as Codex reads what a Stop hook prints.
  if (command === "turn" && sub === "ended" && rest.length === 0) {
    await reportTurnEnded();
    return;
  }
  // A lead started before each repository had its own runs this hook with each message,
  // until it restarts. It prints nothing, as Claude Code adds what it prints to the message,
  // and a lead with one repository needs no note of where you are.
  if (command === "attached" && args.length === 1) return;
  usage(command);
}

// Prints the threads, or one repository's, for sc ps.
async function psCommand(args: string[], json: boolean): Promise<void> {
  const { askForThreads } = await import("./client.ts");
  const { printThreads } = await import("./flow/list.ts");
  // Done threads pile up forever and would bury the live ones, so only --all shows them.
  const all = args.includes("--all");
  // What is left is ps and, at most, a repository.
  const rest = args.filter((word) => word !== "--all");
  if (rest.length > 2) usage("ps");
  const rows = await askForThreads(rest[1]);
  printThreads(all ? rows : rows.filter((row) => row.status !== "done"), json);
}

// Lists tasks, shows one or creates one, for sc task. --json changes only what ls and show
// print.
async function taskCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForTask, askForTasks, createTask } = await import("./client.ts");
  const { printTask, printTasks } = await import("./flow/list.ts");
  if (sub === "ls" && rest.length <= 1) {
    printTasks(await askForTasks(rest[0]), json);
    return;
  }
  // sc task show takes a task's name, such as app-13. sc task create takes a repository
  // with a title and a body, which may be empty.
  const shown = taskName(rest[0]);
  if (sub === "show" && shown && rest.length === 1) {
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
  const { attachToThread } = await import("./attach.ts");
  const { reviewAgain, startNew, startOn, stopOn } = await import("./client.ts");
  const thread = taskName(sub);
  // --from takes a branch, and only sc start <task> takes it.
  const from = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (command === "start" && thread && (rest.length === 0 || from)) {
    console.log(await startOn(...thread, from));
    return;
  }
  // A first word that isn't a task's name is a repository, for a thread with no tracker.
  const [title, body] = rest;
  if (command === "start" && sub && !thread && title && body !== undefined && rest.length === 2) {
    console.log(await startNew(sub, title, body));
    return;
  }
  if (command === "stop" && thread && rest.length === 0) {
    const name = await stopOn(...thread);
    console.log(
      `Stopped ${name}. Its clone, branch and pull request stay, and sc start ${name} brings its builder back.`,
    );
    return;
  }
  if (command === "review" && thread && rest.length === 0) {
    const name = await reviewAgain(...thread);
    console.log(
      `Reviewing ${name}'s last commit again. Skelcrew posts the review on its pull request, and types any changes into its builder.`,
    );
    return;
  }
  if (command === "attach" && thread && rest.length === 0) {
    await attachToThread("skelcrew", ...thread);
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
  if (process.env.SKELCREW_SANDBOX !== "1")
    throw new Error(
      "sc tell is for the lead and builders. To type to a builder, pick it in the sidebar.",
    );
  const thread = taskName(to);
  if (to === "lead" && text && rest.length === 0) {
    await tellTheLead(text);
    console.log("Telling the lead. Skelcrew types it in once the lead is idle.");
    return;
  }
  if (thread && text && rest.length === 0) {
    const name = await tellOn(...thread, text);
    console.log(`Telling ${name}'s builder. Skelcrew types it in once the builder is idle.`);
    return;
  }
  usage(command);
}

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up Skelcrew and opens the screen on the lead. The checks here come first,
// in this order, and the functions above run the commands that are left.
async function runCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  // Before the check below, so a server whose Skelcrew differs from the laptop's still says what
  // it is.
  if (args.length === 1 && command === "--version") {
    console.log(versionLine());
    return;
  }
  // A sidebar or page is started by a Skelcrew that passed this check, and its tmux server can hand
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
  // --json can go anywhere, as tools add it last and people type it where they like. Every
  // command takes it, and one that only does something prints the same line with it. It is
  // left in above, so sc --remote hands it on to the sc it runs.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const [first, second] = words;
  // The command as yoursOnly names it: two words for repo, remote and plugin, and "" for
  // attaching to the lead.
  const named = first === undefined || first === "--from" ? "" : first;
  const refused =
    yoursOnly[
      first === "repo" || first === "remote" || first === "plugin" ? `${first} ${second}` : named
    ];
  if (process.env.SKELCREW_SANDBOX === "1" && refused)
    throw new Error(`${refused} is only for your own terminal, not for agents`);
  const host = words[2];
  if (first === "remote" && second === "add" && host && words.length === 3) {
    process.exit(
      await keepingTitle(() =>
        host.startsWith("sprite:") ? addSprite(host.slice("sprite:".length)) : addServer(host),
      ),
    );
  }
  // Commands that run here load what they need only from this point on, so sc --remote
  // starts quickly and loads no part of the daemon on your laptop.
  const { setupDone } = await import("./machine/setup.ts");
  // A sidebar, a page or an agent can inherit this name from whoever started tmux, and its
  // sandbox hides what setupDone reads.
  const remoteName = process.env.SKELCREW_REMOTE_NAME;
  if (
    remoteName &&
    first !== "first-run" &&
    !onScreen &&
    process.env.SKELCREW_SANDBOX !== "1" &&
    !setupDone()
  )
    throw new Error(notSetUp(remoteName));
  // Plain sc, or sc --from <remote> as sc --remote sends it.
  if (words.length === 0 || (first === "--from" && second && words.length === 2))
    return leadCommand(second);
  switch (first) {
    case "first-run":
    case "serve":
      return machineCommand(words);
    case "sidebar":
    case "page":
      return screenCommand(words);
    case "repo":
    case "init":
      return repoCommand(words, json);
    case "submit":
    case "question":
    case "turn":
    case "attached":
      return agentCommand(words);
    case "ps":
      return psCommand(words, json);
    case "task":
      return taskCommand(words, json);
    case "start":
    case "stop":
    case "review":
    case "attach":
      return threadCommand(words);
    case "tell":
      return tellCommand(words);
    case "plugin":
      return pluginCommand(words, json);
    default:
      usage(first);
  }
}

try {
  await runCommand(process.argv.slice(2));
} catch (error) {
  console.error(`Skelcrew: ${errorText(error)}`);
  process.exit(1);
}
