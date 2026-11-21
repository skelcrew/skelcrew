// Skelcrew's command line: reads the command and hands it to the file that does it.

import { runByAgent } from "./agents/sandbox.ts";
import { agentCommand, needsYouCommand, tellCommand } from "./cli/agents.ts";
import { usage } from "./cli/input.ts";
import {
  leadCommand,
  machineCommand,
  oldPluginCommand,
  pluginCommand,
  repoCommand,
  screenCommand,
} from "./cli/machine.ts";
import { lsCommand, psCommand, showCommand, taskCommand } from "./cli/tasks.ts";
import { checkCommand, mergeCommand, startCommand, threadCommand } from "./cli/threads.ts";
import { help } from "./help.ts";
import { outdated, outOfDate, remote, serverName, unfinished } from "./machine/remote.ts";
import { errorText } from "./say.ts";
import { versionLine } from "./version.ts";

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

async function runCommand(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;

  if (args.length === 1 && command === "--version") {
    console.log(versionLine());
    return;
  }

  const onScreen = ["sidebar", "footer", "details"].includes(command ?? "");

  if (serverName() && command !== "install" && !onScreen && !runByAgent()) {
    const { setupDone } = await import("./machine/setup.ts");
    if (!setupDone()) process.exit(unfinished);
  }

  if (!onScreen && outOfDate()) process.exit(outdated);

  if (!onScreen && command !== "install" && process.env.SKELCREW_LAPTOP_LOCK && !runByAgent()) {
    const { lockDiffers } = await import("./machine/your-files.ts");
    const where = serverName();
    if (lockDiffers())
      console.error(
        `Your lock on ${where} differs from your laptop's. To send yours there, run on your laptop:\n  sc --remote ${where} install`,
      );
  }

  if (args.length === 1 && ["--help", "-h", "help"].includes(command ?? "")) {
    console.log(help());
    return;
  }

  if (runByAgent() && command === "--remote")
    throw new Error("running sc on a server is only for your own terminal, not for agents");

  if (command === "--remote" && sub) process.exit(await remote(sub, rest));

  const json = args.includes("--json");
  const words = args.filter((arg) => arg !== "--json");
  const [first, second] = words;
  const named = first === undefined || first === "--from" ? "" : first;
  const refusal =
    agentRefusals[first === "repo" || first === "plugin" ? `${first} ${second}` : named];
  if (runByAgent() && refusal)
    throw new Error(`${refusal} is only for your own terminal, not for agents`);

  return dispatch(words, json);
}

async function dispatch(words: string[], json: boolean): Promise<void> {
  const [first] = words;
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
      return startCommand(words);
    case "stop":
    case "rm":
    case "review":
    case "peek":
    case "interrupt":
    case "attach":
      return threadCommand(words);
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
