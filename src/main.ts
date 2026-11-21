// Skelcrew's command line: reads the command and hands it to the file that does it.
import { help } from "./help.ts";
import { outdated, outOfDate, remote, unfinished } from "./machine/remote.ts";
import { errorText } from "./say.ts";
import { versionLine } from "./version.ts";

// Each sc command an agent isn't allowed to run, with the start of the error it gets. Most
// need the database, settings or logins that the sandbox hides. Trusting a repository is
// refused because a prompt injection could trick an agent into it.
const agentRefusals: Record<string, string> = {
  "": "attaching to the lead",
  "--list": "showing the list",
  up: "running the daemon",
  restart: "restarting the engine",
  serve: "running the daemon",
  "repo add": "adding a repository",
  "repo rm": "removing a repository",
  init: "setting up a repository for Skelcrew",
  "repo trust": "trusting a repository",
  attach: "attaching to a thread",
  sidebar: "showing the sidebar",
  list: "showing a list",
  install: "setting up this machine",
  add: "adding a plugin",
  remove: "removing a plugin",
  update: "updating a plugin",
  setup: "setting up a plugin",
  plugins: "listing plugins",
  "plugin install": "installing a plugin",
  "plugin update": "updating a plugin",
  "plugin setup": "setting up a plugin",
  "plugin rm": "removing a plugin",
  "plugin ls": "listing plugins",
};

// Splits a task's name, such as app-13, or app-t1 for a thread with no tracker, into its
// repository and task. Gives nothing when the word isn't a task's name. Repository names can
// hold dashes, so the task is what follows the last one. A name may be typed in any case, such
// as APP-T100. The task comes back lowercase: an ID with letters can only be Skelcrew's own, as
// the copy of the tracker leaves out issues shaped like one in any case, and Skelcrew keeps its
// own in lowercase. The daemon finds the repository in any case.
function splitTaskName(word?: string): [string, string] | undefined {
  // The greedy first group takes every dash but the last.
  const parts = word?.match(/^(.+)-([a-z]{0,2}\d+)$/i);
  return parts?.[1] && parts[2] ? [parts[1], parts[2].toLowerCase()] : undefined;
}

// Splits a thread's name into its repository and task, as splitTaskName does. A thread is its
// task with its role after a slash, such as app-12/builder, and the task alone means its
// builder. A task's name never ends in a slash and a plain word, so app-12/builder can't be read
// as a repository named with its owner. Every task's one thread is its builder, so another role
// is refused, saying so.
function splitThreadName(word?: string): [string, string] | undefined {
  const parts = word?.match(/^(.+)\/([a-z]+)$/i);
  const task = splitTaskName(parts?.[1] ?? word);
  if (task && parts?.[2] && parts[2].toLowerCase() !== "builder")
    throw new Error(`${parts[1]} has no ${parts[2]} thread: a task's only thread is its builder`);
  return task;
}

// Splits a task given on stdin to sc start <repo> or sc task add, such as a file or a lead's
// heredoc: the first line is its title, without a markdown heading's "# ", and the rest is its
// body, from its first line that isn't blank. Throws saying which is missing, as a builder needs
// both. `command` names the command in what it says.
function taskFrom(text: string, command = "sc start"): { title: string; body: string } {
  const [first = "", ...rest] = text.split("\n");
  const title = first.replace(/^#\s+/, "").trim();
  const body = rest.join("\n").replace(/^(?:[ \t]*\n)+/, "");
  if (!title)
    throw new Error(
      `${command} read no title on stdin: give the title on the first line, then the body`,
    );
  if (!body.trim())
    throw new Error(
      `${command} read a title but no body on stdin: give the body on the lines after the title`,
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

// Returns the human's words a lead gives with --asked-file, read unchanged, a last line break
// included. The lead writes them to the file with its own file tool, so they never pass through
// a shell, which could run or change them. Throws when the file holds no words.
async function readAsked(file: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const words = readFileSync(file, "utf8");
  if (!words.trim())
    throw new Error(`${file} is empty: write the human's words in it, exactly as they wrote them`);
  return words;
}

// Prints why a command can't run as given, and exits with an error. For a command Skelcrew
// knows, it blames the arguments rather than saying the command doesn't exist.
function usage(command?: string): never {
  // The commands that have words after them, so a mistake there is in the arguments.
  const known = [
    "up",
    "serve",
    "restart",
    "init",
    "repo",
    "ps",
    "ls",
    "show",
    "task",
    "start",
    "stop",
    "rm",
    "merge",
    "attach",
    "peek",
    "interrupt",
    "needs-you",
    "ask",
    "review",
    "submit",
    "check",
    "tell",
    "install",
    "add",
    "remove",
    "update",
    "setup",
    "plugins",
    "plugin",
  ];
  const first = command ?? "";
  console.error(
    first === "--remote"
      ? "Skelcrew: --remote needs a host, such as sc --remote simon@workbox."
      : first === "remote"
        ? "Skelcrew: sc remote add is now sc --remote <host> install, such as sc --remote simon@workbox install."
        : first === "issue" || first === "pr"
          ? 'Skelcrew: issues and PRs are parts of tasks now: sc ls lists them, sc show <task> or sc show \'#<pr>\' shows one, and sc task add <repo> "<title>" "<body>" --issue opens an issue.'
          : known.includes(first)
            ? `Skelcrew: sc ${first} was given arguments it doesn't take. Run sc --help to see how to use it.`
            : "Skelcrew: that isn't a Skelcrew command. Run sc --help to see them.",
  );
  process.exit(1);
}

// Sets up Skelcrew if needed and runs the daemon in the background, as sc up --bg does, then
// opens the screen on a lead, or with `list` shows its repository as a list. The lead is for
// the repository you ran sc from, the one --from names, or else the one you opened last. With
// no repositories there is no lead to open, and bringInFrom has already said so.
async function leadCommand(list: boolean, from?: string): Promise<void> {
  // Loaded only here, so sc --remote on your laptop never loads them.
  const { attachToLead, upInBackground } = await import("./attach.ts");
  const { openDb } = await import("./db.ts");
  const { bringInFrom, checkoutTop, repositories } = await import("./flow/repo.ts");
  const { originHere } = await import("./machine/origin.ts");
  const { firstRun, install, installFinished } = await import("./machine/setup.ts");
  // A machine where sc install never ran to its end gets all of it, your plugins included.
  if (installFinished()) firstRun(from);
  else install(from, true);
  await upInBackground();
  // In a repository with no remote, sc opens nothing, even with tabs open or no repositories
  // yet. Opening another repository there would look as if Skelcrew had ignored where you are.
  const origin = originHere();
  // It is a step to take, not an error, so it goes to stdout like the first run's steps.
  if (from === undefined && origin === null && checkoutTop() !== null) {
    const { toRun } = await import("./say.ts");
    const steps = toRun(["git remote add origin <url>", "git push -u origin HEAD"]);
    console.log(`This git repository has no remote. To add a remote and push it:\n${steps}`);
    console.log("Then run sc again.");
    process.exit(1);
  }
  // Adds the repository you ran sc from if Skelcrew doesn't have it yet.
  const found = await bringInFrom(from);
  // Your config may still use keys a newer shape replaced, which sc names once. The repository's
  // skelcrew.yaml is named as its lead opens.
  const { tellOldKeys } = await import("./config.ts");
  tellOldKeys(undefined);
  if (repositories(openDb()).length === 0) return;
  // Outside any repository, sc opens the repository you opened last only while it has a tab.
  // With every tab closed, you closed them on purpose, so it opens none and says what sc needs.
  const away = from === undefined && origin === null;
  if (await attachToLead("skelcrew", list, found, away)) return;
  console.error("No git repository found. Run sc inside a git repository to open it.");
  process.exit(1);
}

// Runs sc up, which runs the daemon: in the foreground, or with --bg as the background service.
// sc serve is the older name of sc up, kept for services installed before sc up. sc restart
// restarts the daemon wherever it runs.
async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "restart" && args.length === 1) {
    const { restartEngine } = await import("./attach.ts");
    await restartEngine();
    return;
  }
  const { serve } = await import("./flow/daemon.ts");
  if (command === "up" && args.length === 1) {
    await serve("skelcrew");
    return;
  }
  if (command === "up" && args.length === 2 && args[1] === "--bg") {
    // The service has no one to answer the first run's questions, so it would only fail.
    const { setupDone } = await import("./machine/setup.ts");
    if (!setupDone()) throw new Error("the first run isn't done on this machine: run sc first");
    const { upInBackground } = await import("./attach.ts");
    const outside = await upInBackground();
    console.log(
      outside
        ? "Skelcrew's daemon already runs outside its service, such as with sc up in a terminal. Stop it to run it in the background."
        : "Skelcrew's daemon is running in the background.",
    );
    return;
  }
  // A service installed by an older Skelcrew runs sc serve until the next sc rewrites it.
  if (command === "serve" && args.length === 1) {
    console.error("sc serve is now sc up, and sc serve will go in a later release.");
    await serve("skelcrew");
    return;
  }
  usage(command);
}

// Runs a part of the screen: the sidebar, a task's details on the right, or the footer across
// the bottom. The screen starts these, not people, so usage leaves them out.
async function screenCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { runSidebar } = await import("./screen/sidebar.ts");
  const { runFooter } = await import("./screen/footer.ts");
  if (command === "footer" && rest.length === 2) {
    const [agents, session] = rest;
    if (agents && session) {
      await runFooter(agents, session);
      return;
    }
  }
  // `where` is the remote Skelcrew runs on, and empty on this machine, and the sidebar's last
  // word is empty for a lead on tmux, so check them against undefined.
  if (command === "sidebar" && rest.length === 5) {
    const [agents, session, where, repository, onHost] = rest;
    if (agents && session && where !== undefined && repository && onHost !== undefined) {
      await runSidebar(agents, session, where, repository, onHost);
      return;
    }
  }
  if (command === "details" && rest.length === 3) {
    const [agents, repository, name] = rest;
    if (agents && repository && name) {
      const { runTaskDetails } = await import("./screen/task.ts");
      await runTaskDetails(agents, repository, name);
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
  // Once sc init pushed its files, the lead opens on them, as plain sc would open it.
  if (command === "init" && args.length === 1) {
    if (await initRepo("skelcrew")) await leadCommand(false);
    return;
  }
  if (sub === "add" && rest.length <= 1) {
    const added = await addRepo(rest[0], "skelcrew");
    if (added) console.log(`Added ${added.owner}/${added.repo}, as ${added.name}.`);
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

// Runs sc install, sc add, sc remove, sc update, sc setup and sc plugins. -g marks your personal
// plugins. sc add without it adds a plugin to the repository you are in. sc remove and sc update
// without it would change a repository's plugins, which they can't yet, so they refuse rather
// than act on your files instead. --json changes only what sc plugins prints.
async function pluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, ...rest] = args;
  const { addPlugin, listPlugins, removeYourPlugin, setUpPlugin, updatePlugins } = await import(
    "./plugins/install.ts"
  );
  const yours = rest[0] === "-g";
  const [name, ...more] = yours ? rest.slice(1) : rest;
  if (command === "install") {
    // sc --remote <host> install passes these, not people, so usage leaves them out. --from is
    // the checkout it ran in on your laptop, handed to each plugin's setup as on the laptop,
    // such as for the GitHub plugin to pick that repository. --files is the folder your
    // personal files were sent to, put in place before anything else.
    const options = new Map<string, string>();
    for (let at = 0; at < rest.length; at += 2) {
      const [flag = "", value] = rest.slice(at, at + 2);
      if (!["--from", "--files"].includes(flag) || !value || options.has(flag)) usage(command);
      else options.set(flag, value);
    }
    const files = options.get("--files");
    if (files) {
      const { putSentFiles } = await import("./machine/your-files.ts");
      putSentFiles(files);
    }
    const { install } = await import("./machine/setup.ts");
    // A plugin left out fails the command, so a script, or sc --remote on your laptop, can tell
    // the machine isn't set up yet.
    if (!install(options.get("--from"))) process.exitCode = 1;
    return;
  }
  if (command === "add" && name && more.length === 0 && !yours) {
    const { addRepositoryPlugin } = await import("./plugins/repository.ts");
    const added = addRepositoryPlugin(name);
    if (added) console.log(added);
    return;
  }
  if ((command === "remove" || command === "update") && !yours)
    throw new Error(
      `sc ${command} without -g is for a repository's plugins, which Skelcrew can't ${command} yet. sc ${command} -g is for your own`,
    );
  if (command === "add" && name && more.length === 0) {
    addPlugin(name);
    return;
  }
  if (command === "remove" && name && more.length === 0) {
    const { repositoryNeeds } = await import("./plugins/repository.ts");
    return removeYourPlugin(name, repositoryNeeds(true));
  }
  if (command === "update" && more.length === 0) return updatePlugins(name);
  // sc setup sets the plugin up for the checkout you are in, as sc add does.
  if (command === "setup" && rest[0] && rest.length === 1) {
    const { originHere } = await import("./machine/origin.ts");
    setUpPlugin(rest[0], originHere());
    console.log(`Ran ${rest[0]}'s setup.`);
    return;
  }
  if (command === "plugins" && rest.length === 0) {
    const { cantTell, everyNamed, repositoryNeeds } = await import("./plugins/repository.ts");
    // What any repository names stays, so sc plugins doesn't say sc install removes it. A
    // repository that can't be read keeps every plugin, and its row says why, rather than stop
    // the list of all the others.
    const anywhere: string[] = [];
    const needed = everyNamed(anywhere);
    return listPlugins(json, repositoryNeeds(false, []), cantTell(anywhere) ?? needed);
  }
  usage(command);
}

// Runs sc plugin install, update, setup, rm and ls, the names these commands had before sc add
// -g, sc update -g, sc setup, sc remove -g and sc plugins, which they stand for.
async function oldPluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const now: Record<string, string[]> = {
    install: ["add", "-g"],
    update: ["update", "-g"],
    setup: ["setup"],
    rm: ["remove", "-g"],
    ls: ["plugins"],
  };
  const words = sub === undefined ? undefined : now[sub];
  if (!words) return usage(command);
  return pluginCommand([...words, ...rest], json);
}

// Runs what agents and their hooks call: a builder submitting its work, and the hooks that
// tell the daemon what an agent is doing.
async function agentCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const {
    reportQuestion,
    reportTurnEnded,
    reportTurnFailed,
    reportTurnInterrupted,
    submitForReview,
  } = await import("./client.ts");
  if (command === "submit" && sub && rest.length === 0) {
    const thread = await submitForReview(sub);
    console.log(
      `Submitted ${thread} for review. Skelcrew pushes it and opens or updates the pull request. If the reviewer asks for changes, Skelcrew types them in here.`,
    );
    return;
  }
  // Run by an agent's hooks, not by people, so usage leaves it out. It prints nothing: Claude
  // Code adds what a UserPromptSubmit hook prints to the agent's message.
  if (command === "question" && rest.length === 0) {
    if (sub === "asked" || sub === "answered" || sub === "closed") {
      await reportQuestion(sub);
      return;
    }
  }
  // Run by an agent's Stop hook, on Claude Code or Codex, not by people, so usage leaves it
  // out. It prints nothing, as both harnesses read what a Stop hook prints.
  if (command === "turn" && sub === "ended" && rest.length === 0) {
    await reportTurnEnded();
    return;
  }
  // Run by a Claude Code agent's StopFailure hook, not by people, so usage leaves it out.
  // Claude Code ignores what that hook prints. It hands the hook the error on stdin.
  if (command === "turn" && sub === "failed" && rest.length === 0) {
    await reportTurnFailed(process.stdin.isTTY ? "" : await Bun.stdin.text());
    return;
  }
  // Run by a Codex agent's Interrupt hook, when you press Esc, not by people, so usage leaves
  // it out. It prints nothing.
  if (command === "turn" && sub === "interrupted" && rest.length === 0) {
    await reportTurnInterrupted();
    return;
  }
  // Leads started by an older Skelcrew run this hook with each message until they restart.
  // It does nothing now. It must print nothing, since Claude Code adds a hook's output to the
  // message.
  if (command === "attached" && args.length === 1) return;
  usage(command);
}

// Prints the threads, or one repository's, for sc ps. Below them goes a line for each check slot
// taken, saying who holds it and for how long, then one for each repository that needs you to
// run sc install, as its tasks can't start until then. --json gives the threads alone, as tools
// read them.
async function psCommand(args: string[], json: boolean): Promise<void> {
  const { askForRepositories, askForThreads } = await import("./client.ts");
  const { printThreads } = await import("./flow/list.ts");
  // Done threads pile up forever and would bury the live ones, so only --all shows them.
  const all = args.includes("--all");
  // What is left is ps and, at most, a repository.
  const rest = args.filter((word) => word !== "--all");
  if (rest.length > 2) usage("ps");
  const { threads, slots } = await askForThreads(rest[1]);
  printThreads(all ? threads : threads.filter((row) => row.status !== "done"), json);
  if (json) return;
  // Who holds each check slot, so a check that waits in line long shows what it waits on.
  if (slots.length > 0) console.log("");
  for (const { holder, since } of slots) {
    const minutes = Math.floor((Date.now() - since) / 60_000);
    const held = minutes === 0 ? "less than a minute" : `${minutes} min`;
    // A holder starts the line, and "another repository" is one too.
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

// Prints the tasks, or one repository's, for sc ls. Merged and closed tasks pile up forever and
// would bury the rest, so only --all shows them. A task whose work ended without a merge while
// its issue is open, as after sc rm --keep-issue, is back in stage issue, so it shows, to start
// again. A merged one stays out even while the tracker hasn't closed its
// issue yet. `words` are what follows the command.
async function lsCommand(command: string, words: string[], json: boolean): Promise<void> {
  const { askForTasks } = await import("./client.ts");
  const { printTasks } = await import("./flow/list.ts");
  const all = words.includes("--all");
  // What is left is, at most, a repository.
  const rest = words.filter((word) => word !== "--all");
  if (rest.length > 1) usage(command);
  const tasks = await askForTasks(rest[0]);
  const shown = all ? tasks : tasks.filter((t) => t.stage !== "merged" && t.stage !== "closed");
  printTasks(shown, json);
}

// Shows one task, for sc show, named such as app-12, or by its PR's number, such as #31 or 31.
// A number is in the repository of the checkout sc runs in, or the one --from names, which sc
// --remote passes from your laptop's checkout. For the lead, it is always its own.
async function showCommand(command: string, words: string[], json: boolean): Promise<void> {
  const { askForTask } = await import("./client.ts");
  const { printTask } = await import("./flow/list.ts");
  const [named, ...rest] = words;
  const given = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (named === undefined || (rest.length > 0 && !given)) usage(command);
  const number = named.match(/^#?(\d+)$/)?.[1];
  const task = splitTaskName(named);
  if (number !== undefined) {
    const { originHere } = await import("./machine/origin.ts");
    const from = given ?? originHere() ?? undefined;
    printTask(await askForTask({ pr: Number(number), ...(from ? { from } : {}) }), json);
    return;
  }
  if (!task || given) usage(command);
  printTask(await askForTask({ repo: task[0], task: task[1] }), json);
}

// Files a task, for sc task add, with the title and description as words, or on stdin as sc
// start <repo> takes them. It starts nothing. It goes in Skelcrew's backlog, or with --issue in
// the repository's tracker as an issue, such as on GitHub. From a lead, --issue needs
// --asked-file, a file holding the human's words asking for an issue.
async function taskCommand(args: string[]): Promise<void> {
  const [command, sub, repository, ...rest] = args;
  const { createTask, fileTask } = await import("./client.ts");
  if (sub !== "add" || !repository) usage(command);
  // --issue and --asked-file come after the title and body, each at most once, and
  // --asked-file only with --issue. A description that reads "--issue" is the task's own words.
  const flags = new Map<string, string>();
  let words = rest;
  while (words.length > 0) {
    const [flag = "", value = ""] = words.slice(-2);
    if (words.at(-1) === "--issue" && !flags.has("--issue")) {
      flags.set("--issue", "");
      words = words.slice(0, -1);
    } else if (flag === "--asked-file" && value && !flags.has(flag)) {
      flags.set(flag, value);
      words = words.slice(0, -2);
    } else break;
  }
  const issue = flags.has("--issue");
  const askedFile = flags.get("--asked-file");
  if (askedFile !== undefined && !issue) usage(command);
  const shown = issue ? "sc task add --issue" : "sc task add";
  const [title, body] = words;
  let given: { title: string; body: string } | undefined;
  if (title && body !== undefined && words.length === 2)
    given = { title, body: bodyFor(shown, body) };
  // A terminal is never waited on: there, a missing title and body is a mistake.
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

// Arms a merge when ready or without Skelcrew's approval, or cancels one, for sc merge. The thread
// is named by its task, such as app-12, or by its PR's number, such as #7, in the repository of the
// checkout sc runs in or the one --from names. Arming merges a PR later with nobody watching, so it
// asks you first at your terminal, naming the PR, and when skipping the review what it still asks
// for. It refuses with no terminal, as a script has none. A lead you let arm merges has no terminal
// either: it gives --asked-file, a file holding your words, instead, and the daemon checks that it
// may, by the socket the call comes in on, and refuses every other agent. Cancelling is always
// safe, so it asks nothing.
async function mergeCommand(args: string[]): Promise<void> {
  const [, how, named, ...rest] = args;
  const { planMerge, previewMerge } = await import("./client.ts");
  const commands = {
    "--when-ready": "merge when ready",
    "--skip-review": "merge skip review",
    "--cancel": "merge cancel",
  } as const;
  const command =
    how === "--when-ready" || how === "--skip-review" || how === "--cancel"
      ? commands[how]
      : undefined;
  // --from and --asked-file, each at most once, in either order. --asked-file arms, so not
  // with --cancel.
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
  // The thread, by its PR's number or by its task.
  const number = named.match(/^#?(\d+)$/)?.[1];
  const task = splitThreadName(named);
  let which: { repo?: string; task?: string; pr?: number; from?: string };
  if (number !== undefined) {
    const { originHere } = await import("./machine/origin.ts");
    const from = given ?? originHere() ?? undefined;
    which = { pr: Number(number), ...(from ? { from } : {}) };
  } else if (task && !given) which = { repo: task[0], task: task[1] };
  else usage("merge");
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
    // Asking again about a merge already on its way could only mislead: a "no" would leave it
    // merging while sounding like it stopped. So it says so, and how to stop it.
    if (merging !== null) {
      console.log(merging);
      return;
    }
    if (skip && head === null)
      throw new Error(`Skelcrew hasn't seen #${pr}'s newest commit yet: ask again shortly`);
    // The title and findings come from the tracker and the reviewer, so their control codes go
    // before they reach your terminal.
    const { removeControlCodes } = await import("./screen/look.ts");
    const shown = title ? ` ${removeControlCodes(title)}` : "";
    const question = skip
      ? `Merge #${pr} (${thread}${shown}) without Skelcrew's approval? CI must still pass. ${removeControlCodes(asks)}`
      : `Merge #${pr} (${thread}${shown}) when ${ready}?`;
    // A PR that changes .agents/ says so, as the merge approves nothing there. Only y arms it.
    // Anything else, a bare Enter, which Bun's prompt gives as null, Y or yes included, arms
    // nothing.
    const answer = prompt([question, agents, "[y/N]"].filter(Boolean).join(" "));
    // Another terminal or the lead may have asked for the merge while you read the question,
    // so the daemon is asked again before saying it won't merge. The thread may also have been
    // started over meanwhile, with another PR, so the answer names the one it has now.
    if (answer !== "y") {
      const now = await previewMerge(which);
      console.log(now.merging ?? `Not merging: ${now.thread} waits for you to merge it.`);
      return;
    }
    // Armed only if the daemon still has the PR, thread and, when skipping the review, head you
    // said y to.
    const seen = { pr, started, ...(skip && head !== null ? { head } : {}) };
    console.log(await planMerge(command, { ...which, seen }));
    return;
  }
  console.log(await planMerge(command, which));
}

// Runs the repository's whole test suite in this folder once one of the machine's check slots
// is free, for sc check, and exits with the suite's own exit code. Builders, reviewers and you
// all go through it, so at most limits.checks suites run at once. The test commands run joined
// with `&&` in one shell, so a `cd` or an `export` in one still holds for the next.
async function checkCommand(args: string[]): Promise<void> {
  if (args.length !== 1) usage(args[0]);
  const { takeCheckSlot } = await import("./client.ts");
  const { originHere } = await import("./machine/origin.ts");
  // An agent's socket names its repository, and only your checkout's remote names yours.
  const from = process.env.SKELCREW_SOCKET ? undefined : (originHere() ?? undefined);
  const slot = await takeCheckSlot({
    queued: (place) =>
      console.log(
        `Waiting for a check slot: number ${place} in line. The tests start once one is free.`,
      ),
    from,
  });
  if (slot.test.length === 0) {
    console.log("This repository is configured with no tests, so there is nothing to run.");
    return;
  }
  // The suite's process group never outlives sc check, so a check that is stopped, by Ctrl-C or
  // a killed agent, never leaves a suite running on that nobody waits for. A process that
  // detaches itself into a group of its own is outside the check, as only Linux could follow it. The suite runs in a process group of
  // its own, and a watcher in it reads a pipe, descriptor 4, whose other end only sc check
  // holds. However sc check ends, even killed outright, the pipe closes and the watcher ends the
  // whole group. The shell closes its own copy once the watcher
  // has it, so the suite keeps your input, and only the watcher reads the pipe.
  const watched = `(cat <&4 >/dev/null; kill -KILL 0) & exec 4<&-; ${slot.test.join(" && ")}`;
  // The connection to the daemon stays with sc check, as Bun hands a child only the descriptors
  // it names. So the slot is freed when sc check ends, even when a process the suite started,
  // such as a tmux server, keeps running in a session of its own: holding the connection, it
  // would keep the slot for as long as the sandbox lives.
  const run = Bun.spawn(["sh", "-c", watched], {
    stdio: ["inherit", "inherit", "inherit", "ignore", "pipe"],
    detached: true,
  });
  // A daemon that restarts meanwhile forgets the slot, and the suite finishes on its own.
  process.exit(await run.exited);
}

// Has the lead ask you to say yes in the list, under its row, for sc ask. sc ask start takes what
// sc start takes, and your yes starts it. sc ask repo add <owner/repo> asks you to add a
// repository, which your yes only tells the lead, as only you add one, at your terminal.
async function askCommand(args: string[]): Promise<void> {
  const [, first, second, repository, ...more] = args;
  if (first === "start") return threadCommand(args);
  if (first !== "repo" || second !== "add" || !repository || more.length > 0) usage("ask");
  const { askHuman } = await import("./client.ts");
  console.log(await askHuman({ kind: "repo add", repository }));
}

// Starts, stops, removes, re-reviews, peeks at, interrupts or attaches to the thread on a task
// such as app-13. sc start also takes a repository, a title and a body, to start a thread with
// no tracker. sc ask start takes what sc start takes, but has the lead ask you in the list, and
// starts only once you say yes there.
async function threadCommand(args: string[]): Promise<void> {
  const asking = args[0] === "ask";
  const [command, sub, ...rest] = asking ? args.slice(1) : args;
  if (asking && command !== "start") usage("ask");
  const { attachToThread } = await import("./attach.ts");
  const {
    askHuman,
    interruptOn,
    namesRepository,
    peekAt,
    previewRemoval,
    removeOn,
    reviewAgain,
    startNew,
    startOn,
    stopOn,
  } = await import("./client.ts");
  // sc start takes a repository or a task, and a repository's name can end like a task's, such
  // as api-v2. A word that names a repository is that repository, and only another word is read
  // as a task. Commands that take only tasks read every word as one.
  const named = command === "start" && sub !== undefined && (await namesRepository(sub));
  const task = named ? undefined : splitTaskName(sub);
  // stop, peek, interrupt and attach act on one thread, so they take its role too.
  const thread =
    command === "start" || command === "rm" || command === "review" ? task : splitThreadName(sub);
  // --short takes the thread's short title for the sidebar, and --flow the flow its task runs,
  // on every form of sc start. Each is taken out before the other words are read. A blank one
  // would say nothing, so it is a mistake, like one with no words after it.
  const option = (name: string) => {
    const at = command === "start" ? rest.indexOf(name) : -1;
    const value = at === -1 ? undefined : rest[at + 1]?.trim();
    if (at !== -1 && !value) usage(command);
    return { at, value };
  };
  const { at: shortAt, value: short } = option("--short");
  const { at: flowAt, value: flow } = option("--flow");
  const taken = [shortAt, flowAt].flatMap((at) => (at === -1 ? [] : [at, at + 1]));
  const words = rest.filter((_, i) => !taken.includes(i));
  // --from takes a branch, and only sc start <issue> takes it.
  const from = words[0] === "--from" && words[1] && words.length === 2 ? words[1] : undefined;
  const options = { ...(short ? { short } : {}), ...(flow ? { flow } : {}) };
  if (asking && task && (words.length === 0 || from)) {
    const action = { kind: "start" as const, task: task[1], ...(from ? { from } : {}), ...options };
    console.log(await askHuman(action, task[0]));
    return;
  }
  if (!asking && command === "start" && task && (words.length === 0 || from)) {
    console.log(await startOn(...task, from, short, flow));
    return;
  }
  // --from names the branch an issue's thread starts from. A task with no issue has no such
  // choice, so --from there is refused before anything starts, never taken as its title. Only
  // the first word is an option: a description that reads "--from" is the task's own words.
  if (command === "start" && sub && !task && words[0] === "--from")
    throw new Error(
      "sc start <repo> takes no --from. Only sc start <issue> starts from another branch.",
    );
  // A first word that isn't a task's name is a repository, for a thread on what you said, with
  // no task in the tracker.
  const [title, body] = words;
  if (command === "start" && sub && !task && title && body !== undefined && words.length === 2) {
    const checked = bodyFor(asking ? "sc ask start" : "sc start", body);
    console.log(
      asking
        ? await askHuman({ kind: "start new", title, body: checked, ...options }, sub)
        : await startNew(sub, title, checked, short, flow),
    );
    return;
  }
  // With no title and body as words, they come on stdin, so a long body needs no shell
  // quoting. A terminal is never waited on: there, a missing title and body is a mistake.
  if (command === "start" && sub && !task && words.length === 0 && !process.stdin.isTTY) {
    const given = taskFrom(await Bun.stdin.text(), asking ? "sc ask start" : "sc start");
    console.log(
      asking
        ? await askHuman({ kind: "start new", ...given, ...options }, sub)
        : await startNew(sub, given.title, given.body, short, flow),
    );
    return;
  }
  if (asking) usage("ask");
  if (command === "stop" && thread && rest.length === 0) {
    const name = await stopOn(...thread);
    console.log(
      `Stopped ${name}. Its clone, branch and pull request stay, and sc start ${name} brings its builder back.`,
    );
    return;
  }
  if (command === "rm" && task) {
    // --keep-issue and --asked-file go anywhere, each at most once, and leave at most a reason.
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
      usage(command);
    const keepIssue = keepAt !== -1;
    // An empty reason is no reason, so the PR and issue close with no comment.
    const reason = reasons[0] || undefined;
    // At a terminal, say what goes and ask first, as closing a PR or an issue can't be taken
    // back. An agent, such as the lead, has no terminal, and confirms with you in its
    // conversation instead. A thread that is done with no issue to close is left for the daemon
    // to refuse. GitHub writes a number as #12, while a tracker such as Linear has IDs like
    // JOTT-12 that stand alone.
    const issueId = (issue: string) => (/^\d+$/.test(issue) ? `#${issue}` : issue);
    if (process.stdin.isTTY) {
      const { thread: name, status, pr, issue } = await previewRemoval(...task, keepIssue);
      const goes =
        status === "not started"
          ? issue === null
            ? "It never started, and this deletes it from the backlog on every machine."
            : `It never started, and this closes issue ${issueId(issue)}.`
          : status === "done"
            ? `Its work ended already, and this closes issue ${issueId(issue ?? "")}.`
            : pr === null
              ? `This deletes its branch and clone${issue === null ? "" : `, and closes issue ${issueId(issue)}`}.`
              : issue === null
                ? `This closes PR #${pr} and deletes its branch and clone.`
                : `This closes PR #${pr} and issue ${issueId(issue)}, and deletes its branch and clone.`;
      // Bun's prompt answers a bare Enter with null, which is no, as the question says.
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
    else if (closed) console.log(`Removed ${name} and closed issue ${issueId(issue)}.`);
    else
      console.log(
        `Removed ${name}. Issue ${issueId(issue)} stays open, and sc start ${name} starts it over.`,
      );
    return;
  }
  if (command === "review" && task && rest.length === 0) {
    const name = await reviewAgain(...task);
    console.log(
      `Reviewing ${name}'s last commit again. Skelcrew posts the review on its pull request, and types any changes into its builder.`,
    );
    return;
  }
  // The screen comes without the blank lines below what the builder drew.
  if (command === "peek" && thread && rest.length === 0) {
    const { screen } = await peekAt(...thread);
    console.log(screen.trimEnd());
    return;
  }
  if (command === "interrupt" && thread && rest.length === 0) {
    const name = await interruptOn(...thread);
    console.log(`Stopped ${name}'s turn, as Esc does. sc tell ${name} gives it what to do next.`);
    return;
  }
  if (command === "attach" && thread && rest.length === 0) {
    await attachToThread("skelcrew", ...thread);
    return;
  }
  usage(command);
}

// Marks a thread as needing you, with the action you must take, as sc needs-you <thread>
// "<action>", or clears its mark, as sc needs-you --clear <thread>. The lead runs it when only you
// can unblock a thread, and you can too. The daemon refuses a builder.
async function needsYouCommand(args: string[]): Promise<void> {
  const [command, first, second, ...rest] = args;
  const { markNeedsYou } = await import("./client.ts");
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

// Types a message from the lead into a builder, from a builder into the lead, or from a lead
// into another repository's lead, as sc tell lead <repo> "<text>". A brief or a message to a
// builder can be long, so with - as its text it comes on stdin instead, which needs no shell
// quoting. Without that, a lead's - would reach the builder as the message. A builder's sc tell lead
// "<text>" has one word after lead, so only a second word makes a brief, and a builder's message
// never waits on stdin. --asked-file gives the human's words with a brief, in a file the lead
// wrote, as sc merge --when-ready takes them. The daemon decides who may tell whom, from the
// socket the call comes in on. In your terminal it only says how to type to a builder yourself.
async function tellCommand(args: string[]): Promise<void> {
  const command = args[0];
  const { briefOtherLead, tellOn, tellTheLead } = await import("./client.ts");
  if (process.env.SKELCREW_SANDBOX !== "1")
    throw new Error(
      "sc tell is for the lead and builders. To type to a builder, pick it in the sidebar, or press Enter on it in sc --list.",
    );
  // --asked-file, at most once and anywhere, then the words left.
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
  // Sidebars, footers and the details of a task skip the out-of-date check. The Skelcrew that
  // started them already passed it, and tmux may hand them another laptop's build, which would
  // make them refuse.
  const onScreen = ["sidebar", "footer", "details"].includes(command ?? "");
  // On a remote, refuse to run until the machine is set up, with the exit code that lets the
  // laptop offer to finish it. This comes before the build check, since its answer would copy
  // Skelcrew there, and --remote must ask before setting a machine up. The screen's parts and
  // agents skip it: they can inherit the remote's name from whoever started tmux, and an agent's
  // sandbox hides what setupDone reads. Only a remote loads setup.ts this early, so sc --remote
  // on the laptop still starts quickly.
  if (
    process.env.SKELCREW_REMOTE_NAME &&
    command !== "install" &&
    !onScreen &&
    process.env.SKELCREW_SANDBOX !== "1"
  ) {
    const { setupDone } = await import("./machine/setup.ts");
    if (!setupDone()) process.exit(unfinished);
  }
  if (!onScreen && outOfDate()) process.exit(outdated);
  // A machine whose lock differs from the laptop's says so, and the command runs anyway. It
  // goes to stderr, so --json output stays clean. sc install there is about to make them match,
  // and an agent's sandbox hides the lock.
  if (
    !onScreen &&
    command !== "install" &&
    process.env.SKELCREW_LAPTOP_LOCK &&
    process.env.SKELCREW_SANDBOX !== "1"
  ) {
    const { lockDiffers } = await import("./machine/your-files.ts");
    const where = process.env.SKELCREW_REMOTE_NAME;
    if (lockDiffers())
      console.error(
        `Your lock on ${where} differs from your laptop's. To send yours there, run on your laptop:\n  sc --remote ${where} install`,
      );
  }
  if (args.length === 1 && ["--help", "-h", "help"].includes(command ?? "")) {
    console.log(help());
    return;
  }
  // An agent never needs another machine, and Skelcrew there couldn't tell an agent asked.
  if (process.env.SKELCREW_SANDBOX === "1" && command === "--remote")
    throw new Error("running sc on a server is only for your own terminal, not for agents");
  if (command === "--remote" && sub) process.exit(await remote(sub, rest));
  // --json can go anywhere, since tools add it last and people type it where they like. Every
  // command accepts it, and one that only acts prints the same line either way. sc --remote
  // above keeps it, so the sc it runs on the remote gets it too.
  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const [first, second] = words;
  // The command as agentRefusals names it: two words for repo and plugin, and "" for
  // attaching to the lead.
  const named = first === undefined || first === "--from" ? "" : first;
  const refusal =
    agentRefusals[first === "repo" || first === "plugin" ? `${first} ${second}` : named];
  if (process.env.SKELCREW_SANDBOX === "1" && refusal)
    throw new Error(`${refusal} is only for your own terminal, not for agents`);
  // Plain sc, or sc --from <remote> as sc --remote sends it. Either one with --list first shows
  // the list in place of the screen.
  const list = first === "--list";
  const lead = list ? words.slice(1) : words;
  if (lead.length === 0 || (lead[0] === "--from" && lead[1] && lead.length === 2))
    return leadCommand(list, lead[1]);
  switch (first) {
    case "up":
    case "serve":
    case "restart":
      return machineCommand(words);
    case "sidebar":
    case "footer":
    case "details":
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
    case "ls":
      return lsCommand(first, words.slice(1), json);
    case "show":
      return showCommand(first, words.slice(1), json);
    case "task":
      return taskCommand(words);
    case "start":
    case "stop":
    case "rm":
    case "review":
    case "peek":
    case "interrupt":
    case "attach":
      return threadCommand(words);
    case "ask":
      return askCommand(words);
    case "needs-you":
      return needsYouCommand(words);
    case "tell":
      return tellCommand(words);
    case "check":
      return checkCommand(words);
    case "merge":
      return mergeCommand(words);
    case "install":
    case "add":
    case "remove":
    case "update":
    case "setup":
    case "plugins":
      return pluginCommand(words, json);
    case "plugin":
      return oldPluginCommand(words, json);
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
