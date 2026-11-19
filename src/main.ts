// Skelcrew's command line: reads the command and hands it to the file that does it.
import { help } from "./help.ts";
import {
  addServer,
  otherSetup,
  outdated,
  outOfDate,
  remote,
  unfinished,
} from "./machine/remote.ts";
import { errorText } from "./say.ts";
import { versionLine } from "./version.ts";

// Each sc command an agent isn't allowed to run, with the start of the error it gets. Most
// need the database, settings or logins that the sandbox hides. Trusting a repository is
// refused because a prompt injection could trick an agent into it.
const agentRefusals: Record<string, string> = {
  "": "attaching to the lead",
  "--list": "showing the list",
  up: "running the daemon",
  serve: "running the daemon",
  "repo add": "adding a repository",
  "repo rm": "removing a repository",
  init: "setting up a repository for Skelcrew",
  "repo trust": "trusting a repository",
  attach: "attaching to a thread",
  sidebar: "showing the sidebar",
  list: "showing a list",
  "first-run": "setting up this machine",
  "take-setup": "taking your laptop's setup",
  "remote add": "setting up a machine",
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

// Splits a task's name, such as app-13, or app-wr1 for a thread with no tracker, into its
// repository and task. Gives nothing when the word isn't a task's name. Repository names can
// hold dashes, so the task is what follows the last one.
function splitTaskName(word?: string): [string, string] | undefined {
  // The greedy first group takes every dash but the last.
  const parts = word?.match(/^(.+)-([a-z]{0,2}\d+)$/);
  return parts?.[1] && parts[2] ? [parts[1], parts[2]] : undefined;
}

// Splits a thread's name into its repository and task, as splitTaskName does. A thread is its
// task with its role after a slash, such as app-12/builder, and the task alone means its
// builder. A task's name never ends in a slash and a plain word, so app-12/builder can't be read
// as a repository named with its owner. Every task's one thread is its builder, so another role
// is refused, saying so.
function splitThreadName(word?: string): [string, string] | undefined {
  const parts = word?.match(/^(.+)\/([a-z]+)$/);
  const task = splitTaskName(parts?.[1] ?? word);
  if (task && parts?.[2] && parts[2] !== "builder")
    throw new Error(`${parts[1]} has no ${parts[2]} thread: a task's only thread is its builder`);
  return task;
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
    "up",
    "serve",
    "init",
    "repo",
    "ps",
    "ls",
    "show",
    "issue",
    "pr",
    "start",
    "stop",
    "rm",
    "merge",
    "attach",
    "peek",
    "interrupt",
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
        ? "Skelcrew: sc remote add needs a host, such as sc remote add simon@workbox."
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
  if (from === undefined && origin === null && checkoutTop() !== null) {
    console.error(
      "This git repository has no remote. To add a remote and push it:\n\n  git remote add origin <url>\n  git push -u origin HEAD\n\nThen run sc again.\n",
    );
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

// Runs sc first-run, which sets up this machine, sc take-setup, which takes the setup your laptop
// sent, or sc up, which runs the daemon: in the foreground, or with --bg as the background
// service. sc serve is the older name of sc up, kept for services installed before sc up.
async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  // Run by sc --remote and sc remote add from your laptop, not by people, so usage leaves it out.
  if (command === "take-setup" && args.length === 1) {
    const { takeSetup } = await import("./machine/copy-setup.ts");
    await takeSetup();
    return;
  }
  const { serve } = await import("./flow/daemon.ts");
  const { install } = await import("./machine/setup.ts");
  const { upInBackground } = await import("./attach.ts");
  // Run by sc remote add on the machine it sets up, not by people, so usage leaves it out. It is
  // all of sc install, as only that marks the machine set up. The daemon starts there too, so sc
  // --remote finds it running.
  if (command === "first-run" && args.length === 1) {
    install();
    await upInBackground();
    return;
  }
  if (command === "up" && args.length === 1) {
    await serve("skelcrew");
    return;
  }
  if (command === "up" && args.length === 2 && args[1] === "--bg") {
    // The service has no one to answer the first run's questions, so it would only fail.
    const { setupDone } = await import("./machine/setup.ts");
    if (!setupDone()) throw new Error("the first run isn't done on this machine: run sc first");
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

// Runs a part of the screen: the sidebar, a list and its pages on the right, or the footer
// across the bottom. The screen starts these, not people, so usage leaves them out.
async function screenCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { runPane } = await import("./screen/pane.ts");
  const { runSidebar } = await import("./screen/sidebar.ts");
  const { runFooter } = await import("./screen/footer.ts");
  if (command === "footer" && rest.length === 2) {
    const [agents, session] = rest;
    if (agents && session) {
      await runFooter(agents, session);
      return;
    }
  }
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
  if (command === "install" && rest.length === 0) {
    const { install } = await import("./machine/setup.ts");
    return install();
  }
  if (command === "add" && name && more.length === 0 && !yours) {
    const { addRepositoryPlugin } = await import("./plugins/repository.ts");
    addRepositoryPlugin(name);
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
    const { repositoryNeeds } = await import("./plugins/repository.ts");
    return listPlugins(json, repositoryNeeds());
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

// Prints the tasks, or one repository's, for sc ls and its short name sc issue ls. Merged and
// closed tasks pile up forever and would bury the rest, so only --all shows them. A task whose
// work ended without a merge while its issue is open, as after sc rm, is back in stage issue, so
// it shows, to start again. A merged one stays out even while the tracker hasn't closed its
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

// Shows one task, for sc show and its short name sc issue show, named such as app-12.
async function showCommand(command: string, words: string[], json: boolean): Promise<void> {
  const { askForTask } = await import("./client.ts");
  const { printTask } = await import("./flow/list.ts");
  const task = splitTaskName(words[0]);
  if (!task || words.length !== 1) usage(command);
  printTask(await askForTask({ repo: task[0], task: task[1] }), json);
}

// Lists tasks, shows one or creates an issue, for sc issue. sc issue ls and sc issue show are
// short names for sc ls and sc show, kept while people and leads still type them.
async function issueCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { createTask } = await import("./client.ts");
  if (sub === "ls") return lsCommand(command ?? "issue", rest, json);
  if (sub === "show") return showCommand(command ?? "issue", rest, json);
  // sc issue create takes a repository with a title and a body.
  const [repository, title, body] = rest;
  if (sub === "create" && repository && title && body !== undefined && rest.length === 3) {
    console.log(await createTask(repository, title, bodyFor("sc issue create", body)));
    return;
  }
  usage(command);
}

// Shows the task a PR belongs to, for sc pr show, a short name for sc show. The PR is named by
// its number, such as 31 or #31, or by its task, such as app-12. A number is in the repository
// of the checkout sc runs in, or the one --from names, which sc --remote passes from your
// laptop's checkout. For the lead, it is always its own.
async function prCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, named, ...rest] = args;
  const { askForTask } = await import("./client.ts");
  const { printTask } = await import("./flow/list.ts");
  const given = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (sub !== "show" || named === undefined || (rest.length > 0 && !given)) usage(command);
  const number = named.match(/^#?(\d+)$/)?.[1];
  const task = splitTaskName(named);
  if (number !== undefined) {
    const { originHere } = await import("./machine/origin.ts");
    const from = given ?? originHere() ?? undefined;
    printTask(await askForTask({ pr: Number(number), ...(from ? { from } : {}) }), json);
    return;
  }
  if (task && !given) {
    printTask(await askForTask({ repo: task[0], task: task[1] }), json);
    return;
  }
  usage(command);
}

// Arms a merge when ready, or cancels one, for sc merge. The thread is named by its task, such
// as app-12, or by its PR's number, such as #7, in the repository of the checkout sc runs in or
// the one --from names. Arming merges a PR later with nobody watching, so it asks you first at
// your terminal, naming the PR, and refuses with no terminal, as a script has none. A lead you
// let arm merges has no terminal either: it gives --asked-file, a file holding your words,
// instead, and the daemon checks that it may, by the socket the call comes in on, and refuses
// every other agent.
// Cancelling is always safe, so it asks nothing.
async function mergeCommand(args: string[]): Promise<void> {
  const [, how, named, ...rest] = args;
  const { planMerge, previewMerge } = await import("./client.ts");
  const command =
    how === "--when-ready" ? "merge when ready" : how === "--cancel" ? "merge cancel" : undefined;
  // --from and --asked-file, each at most once, in either order. --asked-file arms, so only
  // with --when-ready.
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [flag = "", value] = [rest[i], rest[i + 1]];
    if (!["--from", "--asked-file"].includes(flag) || !value || options.has(flag)) usage("merge");
    options.set(flag, value);
  }
  const given = options.get("--from");
  const asked = options.get("--asked-file");
  if (!command || named === undefined) usage("merge");
  if (asked !== undefined && command !== "merge when ready") usage("merge");
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
  // Your words come in a file the lead wrote with its own file tool, so they never pass through
  // a shell, which could run or change them. They are read unchanged, a last line break included.
  if (asked !== undefined) {
    const { readFileSync } = await import("node:fs");
    const words = readFileSync(asked, "utf8");
    if (!words.trim())
      throw new Error(
        `${asked} is empty: write the human's words in it, exactly as they wrote them`,
      );
    console.log(await planMerge(command, { ...which, asked: words }));
    return;
  }
  if (command === "merge when ready") {
    if (!process.stdin.isTTY)
      throw new Error("sc merge --when-ready asks you first, so run it at your own terminal");
    // The title comes from the tracker, so its control codes go before it reaches your terminal.
    const { thread, pr, title, started } = await previewMerge(which);
    if (pr === null)
      throw new Error(`${thread} has no PR yet: arm a merge when ready once it opens one`);
    const { removeControlCodes } = await import("./screen/look.ts");
    const shown = title ? ` ${removeControlCodes(title)}` : "";
    // Only y arms it. Anything else, a bare Enter, which Bun's prompt gives as null, Y or yes
    // included, arms nothing.
    const answer = prompt(`Merge #${pr} (${thread}${shown}) when it's approved and green? [y/N]`);
    if (answer !== "y") {
      console.log(`Nothing is armed: ${thread} waits for you to merge it.`);
      return;
    }
    // Armed only if the daemon still has the PR and thread you said y to.
    console.log(await planMerge(command, { ...which, seen: { pr, started } }));
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
  // The shell gets the connection too, as its descriptor 3, so the daemon frees the slot only
  // once the last process of the suite has ended, not when sc check does.
  const run = Bun.spawn(["sh", "-c", watched], {
    stdio: ["inherit", "inherit", "inherit", slot.fd ?? "ignore", "pipe"],
    detached: true,
  });
  // A daemon that restarts meanwhile forgets the slot, and the suite finishes on its own.
  process.exit(await run.exited);
}

// Starts, stops, removes, re-reviews, peeks at, interrupts or attaches to the thread on a task
// such as app-13. sc start also takes a repository, a title and a body, to start a thread with
// no tracker.
async function threadCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  const { attachToThread } = await import("./attach.ts");
  const { interruptOn, peekAt, previewRemoval, removeOn, reviewAgain, startNew, startOn, stopOn } =
    await import("./client.ts");
  const task = splitTaskName(sub);
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
  if (command === "start" && task && (words.length === 0 || from)) {
    console.log(await startOn(...task, from, short, flow));
    return;
  }
  // A first word that isn't a task's name is a repository, for a thread on what you said, with
  // no task in the tracker.
  const [title, body] = words;
  if (command === "start" && sub && !task && title && body !== undefined && words.length === 2) {
    console.log(await startNew(sub, title, bodyFor("sc start", body), short, flow));
    return;
  }
  // With no title and body as words, they come on stdin, so a long body needs no shell
  // quoting. A terminal is never waited on: there, a missing title and body is a mistake.
  if (command === "start" && sub && !task && words.length === 0 && !process.stdin.isTTY) {
    const given = taskFrom(await Bun.stdin.text());
    console.log(await startNew(sub, given.title, given.body, short, flow));
    return;
  }
  if (command === "stop" && thread && rest.length === 0) {
    const name = await stopOn(...thread);
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

// Types a message from the lead into a builder, or from a builder into the lead. The daemon
// decides who may tell whom, from the socket the call comes in on. In your terminal it only
// says how to type to a builder yourself.
async function tellCommand(args: string[]): Promise<void> {
  const [command, to, text, ...rest] = args;
  const { tellOn, tellTheLead } = await import("./client.ts");
  if (process.env.SKELCREW_SANDBOX !== "1")
    throw new Error(
      "sc tell is for the lead and builders. To type to a builder, pick it in the sidebar, or press Enter on it in sc --list.",
    );
  const task = to === "lead" ? undefined : splitThreadName(to);
  if (to === "lead" && text && rest.length === 0) {
    await tellTheLead(text);
    console.log("Telling the lead. Skelcrew types it in once the lead is idle.");
    return;
  }
  if (task && text && rest.length === 0) {
    console.log(await tellOn(...task, text));
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
  // Sidebars, lists and footers skip the out-of-date check. The Skelcrew that started
  // them already passed it, and tmux may hand them another laptop's build, which would make them
  // refuse.
  const onScreen = command === "sidebar" || command === "list" || command === "footer";
  // On a remote, refuse to run until the machine is set up, with the exit code that lets the
  // laptop offer to finish it. This comes before the build and setup checks, since they would
  // copy and install things there, and --remote must ask before setting a machine up. Sidebars,
  // lists and agents skip it: they can inherit the remote's name from whoever started tmux, and
  // an agent's sandbox hides what setupDone reads. Only a remote loads setup.ts this early, so
  // sc --remote on the laptop still starts quickly.
  if (
    process.env.SKELCREW_REMOTE_NAME &&
    command !== "first-run" &&
    command !== "install" &&
    command !== "take-setup" &&
    !onScreen &&
    process.env.SKELCREW_SANDBOX !== "1"
  ) {
    const { setupDone } = await import("./machine/setup.ts");
    if (!setupDone()) process.exit(unfinished);
  }
  if (!onScreen && outOfDate()) process.exit(outdated);
  // A machine whose setup differs from the laptop's runs nothing, so the laptop copies its own
  // there first. An agent's sandbox hides what this reads.
  if (!onScreen && process.env.SKELCREW_LAPTOP_SETUP && process.env.SKELCREW_SANDBOX !== "1") {
    const { setupDiffers } = await import("./machine/copy-setup.ts");
    if (setupDiffers()) process.exit(otherSetup);
  }
  if (args.length === 1 && ["--help", "-h", "help"].includes(command ?? "")) {
    console.log(help());
    return;
  }
  if (command === "--remote" && sub) process.exit(await remote(sub, rest));
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
    const code = await addServer(host);
    // Setting up doesn't connect, so that logging in there stays separate from starting work.
    if (code === 0) console.log(`${host} is ready. Connect to it with:\n  sc --remote ${host}`);
    process.exit(code);
  }
  // Plain sc, or sc --from <remote> as sc --remote sends it. Either one with --list first shows
  // the list in place of the screen.
  const list = first === "--list";
  const lead = list ? words.slice(1) : words;
  if (lead.length === 0 || (lead[0] === "--from" && lead[1] && lead.length === 2))
    return leadCommand(list, lead[1]);
  switch (first) {
    case "first-run":
    case "take-setup":
    case "up":
    case "serve":
      return machineCommand(words);
    case "sidebar":
    case "list":
    case "footer":
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
    case "issue":
      return issueCommand(words, json);
    case "pr":
      return prCommand(words, json);
    case "start":
    case "stop":
    case "rm":
    case "review":
    case "peek":
    case "interrupt":
    case "attach":
      return threadCommand(words);
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
