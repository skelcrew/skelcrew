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

// Each sc command an agent isn't allowed to run, with the start of the error it gets. Most
// need the database, settings or logins that the sandbox hides. Trusting a repository is
// refused because a prompt injection could trick an agent into it.
const agentRefusals: Record<string, string> = {
  "": "attaching to the lead",
  serve: "running the daemon",
  "repo add": "adding a repository",
  "repo rm": "removing a repository",
  init: "setting up a repository for Skelcrew",
  "repo trust": "trusting a repository",
  attach: "attaching to a thread",
  sidebar: "showing the sidebar",
  list: "showing a list",
  "first-run": "setting up this machine",
  "remote add": "setting up a machine",
  "plugin install": "installing a plugin",
  "plugin update": "updating a plugin",
  "plugin setup": "setting up a plugin",
  "plugin rm": "removing a plugin",
  "plugin ls": "listing plugins",
};

// Splits a task's name, such as app-13, or app-t1 for a thread with no tracker, into its
// repository and task. Gives nothing when the word isn't a task's name. Repository names can
// hold dashes, so the task is what follows the last one.
function splitTaskName(word?: string): [string, string] | undefined {
  // The greedy first group takes every dash but the last.
  const parts = word?.match(/^(.+)-(t?\d+)$/);
  return parts?.[1] && parts[2] ? [parts[1], parts[2]] : undefined;
}

// Splits a task given on stdin to sc start <repo>, such as a file or a lead's heredoc: the
// first line is its title, without a markdown heading's "# ", and the rest is its body, from
// its first line that isn't blank. Throws saying which is missing, as a builder needs both.
function taskFrom(text: string): { title: string; body: string } {
  const [first = "", ...rest] = text.split("\n");
  const title = first.replace(/^#\s+/, "").trim();
  const body = rest.join("\n").replace(/^(?:[ \t]*\n)+/, "");
  if (!title)
    throw new Error(
      "sc start read no title on stdin: give the title on the first line, then the body",
    );
  if (!body.trim())
    throw new Error(
      "sc start read a title but no body on stdin: give the body on the lines after the title",
    );
  return { title, body };
}

// Returns a task's body as given, or throws when it is blank, before anything reaches the
// tracker or starts a thread. A builder sees only the title and body. A heredoc that failed
// inside "$(...)" leaves the body empty while the command still runs.
function bodyFor(command: string, body: string): string {
  if (!body.trim())
    throw new Error(`${command} needs a body, which is all a builder sees besides its title.`);
  return body;
}

// Prints why a command can't run as given, and exits with an error. For a command Skelcrew
// knows, it blames the arguments rather than saying the command doesn't exist.
function usage(command?: string): never {
  // The commands that have words after them, so a mistake there is in the arguments.
  const known = [
    "serve",
    "init",
    "repo",
    "ps",
    "issue",
    "start",
    "stop",
    "rm",
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

// Sets up Skelcrew if needed, then opens the screen on a lead. The lead is for the repository
// you ran sc from, the one --from names, or else the one you opened last. With no repositories
// there is no lead to open, and bringInFrom has already said so.
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

// Runs sc first-run, which sets up this machine, or sc serve, which runs the daemon.
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

// Runs a pane of the screen: the sidebar, or a list and its pages on the right. The screen
// starts these, not people, so usage leaves them out.
async function screenCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { runPane } = await import("./screen/pane.ts");
  const { runSidebar } = await import("./screen/sidebar.ts");
  // `where` is the remote Skelcrew runs on, and empty on this machine, so check it against
  // undefined.
  if (command === "sidebar" && rest.length === 4) {
    const [agents, session, where, repository] = rest;
    if (agents && session && where !== undefined && repository) {
      await runSidebar(agents, session, where, repository);
      return;
    }
  }
  if (command === "list" && rest.length === 5) {
    const [agents, session, entry, where, repository] = rest;
    if (
      agents &&
      session &&
      (entry === "issues" || entry === "threads" || entry === "prs") &&
      where !== undefined &&
      repository
    ) {
      await runPane(agents, session, entry, where, repository);
      return;
    }
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
    await initRepo("skelcrew");
    return;
  }
  if (sub === "add" && rest.length <= 1) {
    await addRepo(rest[0], "skelcrew");
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
  // sc plugin setup sets the plugin up for the checkout you are in, as install does.
  if (sub === "setup" && rest[0] && rest.length === 1) {
    const { originHere } = await import("./machine/origin.ts");
    setUpPlugin(rest[0], originHere());
    console.log(`Ran ${rest[0]}'s setup.`);
    return;
  }
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
  // Leads started by an older Skelcrew run this hook with each message until they restart.
  // It does nothing now. It must print nothing, since Claude Code adds a hook's output to the
  // message.
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

// Lists issues, shows one or creates one, for sc issue. The words a user types say issue, as
// the sidebar does, while Skelcrew calls each one a task. --json changes only what ls and show
// print.
async function issueCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForTask, askForTasks, createTask } = await import("./client.ts");
  const { printTask, printTasks } = await import("./flow/list.ts");
  if (sub === "ls" && rest.length <= 1) {
    printTasks(await askForTasks(rest[0]), json);
    return;
  }
  // sc issue show takes an issue's name, such as app-13. sc issue create takes a repository
  // with a title and a body.
  const task = splitTaskName(rest[0]);
  if (sub === "show" && task && rest.length === 1) {
    printTask(await askForTask(...task), json);
    return;
  }
  const [repository, title, body] = rest;
  if (sub === "create" && repository && title && body !== undefined && rest.length === 3) {
    console.log(await createTask(repository, title, bodyFor("sc issue create", body)));
    return;
  }
  usage(command);
}

// Starts, stops, removes, re-reviews or attaches to the thread on a task such as app-13. sc
// start also takes a repository, a title and a body, to start a thread with no tracker.
async function threadCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { attachToThread } = await import("./attach.ts");
  const { previewRemoval, removeOn, reviewAgain, startNew, startOn, stopOn } = await import(
    "./client.ts"
  );
  const task = splitTaskName(sub);
  // --short takes the thread's short title for the sidebar, on every form of sc start, and is
  // taken out before the other words are read. A blank one would show nothing, so it is a
  // mistake, like a --short with no words after it.
  const shortAt = command === "start" ? rest.indexOf("--short") : -1;
  const short = shortAt === -1 ? undefined : rest[shortAt + 1]?.trim();
  if (shortAt !== -1 && !short) usage(command);
  const words = rest.filter((_, i) => shortAt === -1 || (i !== shortAt && i !== shortAt + 1));
  // --from takes a branch, and only sc start <issue> takes it.
  const from = words[0] === "--from" && words[1] && words.length === 2 ? words[1] : undefined;
  if (command === "start" && task && (words.length === 0 || from)) {
    console.log(await startOn(...task, from, short));
    return;
  }
  // A first word that isn't a task's name is a repository, for a thread on what you said, with
  // no task in the tracker.
  const [title, body] = words;
  if (command === "start" && sub && !task && title && body !== undefined && words.length === 2) {
    console.log(await startNew(sub, title, bodyFor("sc start", body), short));
    return;
  }
  // With no title and body as words, they come on stdin, so a long body needs no shell
  // quoting. A terminal is never waited on: there, a missing title and body is a mistake.
  if (command === "start" && sub && !task && words.length === 0 && !process.stdin.isTTY) {
    const given = taskFrom(await Bun.stdin.text());
    console.log(await startNew(sub, given.title, given.body, short));
    return;
  }
  if (command === "stop" && task && rest.length === 0) {
    const name = await stopOn(...task);
    console.log(
      `Stopped ${name}. Its clone, branch and pull request stay, and sc start ${name} brings its builder back.`,
    );
    return;
  }
  if (command === "rm" && task && rest.length <= 1) {
    // At a terminal, say what goes and ask first, as closing a PR can't be taken back. An agent,
    // such as the lead, has no terminal, and confirms with you in its conversation instead. A
    // thread that is done is left for the daemon to refuse.
    if (process.stdin.isTTY) {
      const { thread: name, status, pr } = await previewRemoval(...task);
      const goes =
        pr === null
          ? "This deletes its branch and clone."
          : `This closes PR #${pr} and deletes its branch and clone.`;
      // Bun's prompt answers a bare Enter with null, which is no, as the question says.
      const answer = status === "done" ? "y" : prompt(`Remove ${name}? ${goes} [y/N]`);
      if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
        console.log(`Skelcrew didn't remove ${name}.`);
        return;
      }
    }
    // An empty reason is no reason, so the PR closes with no comment.
    const { removed: name, issue } = await removeOn(...task, rest[0] || undefined);
    // The issue stays open in the tracker, so starting over needs no new one. GitHub writes a
    // number as #12, while a tracker such as Linear has IDs like JOTT-12 that stand alone.
    if (issue === null) console.log(`Removed ${name}. sc start ${name} starts it over.`);
    else {
      const id = /^\d+$/.test(issue) ? `#${issue}` : issue;
      console.log(`Removed ${name}. Issue ${id} stays open, and sc start ${name} starts it over.`);
    }
    return;
  }
  if (command === "review" && task && rest.length === 0) {
    const name = await reviewAgain(...task);
    console.log(
      `Reviewing ${name}'s last commit again. Skelcrew posts the review on its pull request, and types any changes into its builder.`,
    );
    return;
  }
  if (command === "attach" && task && rest.length === 0) {
    await attachToThread("skelcrew", ...task);
    return;
  }
  usage(command);
}

// Types a message from the lead into a builder, or from a builder into the lead. The daemon
// decides who may tell whom, from the socket the call comes in on. In your terminal it only
// says how to type to a builder yourself.
async function tellCommand(args: string[]): Promise<void> {
  const [command, to, text, ...rest] = args;
  const { tellOn, tellTheLead } = await import("./client.ts");
  if (process.env.SKELCREW_SANDBOX !== "1")
    throw new Error(
      "sc tell is for the lead and builders. To type to a builder, pick it in the sidebar.",
    );
  const task = splitTaskName(to);
  if (to === "lead" && text && rest.length === 0) {
    await tellTheLead(text);
    console.log("Telling the lead. Skelcrew types it in once the lead is idle.");
    return;
  }
  if (task && text && rest.length === 0) {
    const name = await tellOn(...task, text);
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
  // Answered before the out-of-date check, so a server whose Skelcrew differs from the
  // laptop's can still say which version it runs.
  if (args.length === 1 && command === "--version") {
    console.log(versionLine());
    return;
  }
  // Sidebars and lists skip the out-of-date check. The Skelcrew that started them already
  // passed it, and tmux may hand them another laptop's build, which would make them refuse.
  const onScreen = command === "sidebar" || command === "list";
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
  // --json can go anywhere, since tools add it last and people type it where they like. Every
  // command accepts it, and one that only acts prints the same line either way. sc --remote
  // above keeps it, so the sc it runs on the remote gets it too.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const [first, second] = words;
  // The command as agentRefusals names it: two words for repo, remote and plugin, and "" for
  // attaching to the lead.
  const named = first === undefined || first === "--from" ? "" : first;
  const refusal =
    agentRefusals[
      first === "repo" || first === "remote" || first === "plugin" ? `${first} ${second}` : named
    ];
  if (process.env.SKELCREW_SANDBOX === "1" && refusal)
    throw new Error(`${refusal} is only for your own terminal, not for agents`);
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
  // On a remote, refuse to run until the machine is set up. Sidebars, lists and agents skip
  // this: they can inherit the remote's name from whoever started tmux, and an agent's sandbox
  // hides what setupDone reads.
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
    case "list":
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
    case "issue":
      return issueCommand(words, json);
    case "start":
    case "stop":
    case "rm":
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
