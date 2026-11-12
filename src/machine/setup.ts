// The first run: what a plain sc sets up on a new machine, skipping each step already
// done.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../agents/codex.ts";
import { HarnessName } from "../agents/harness.ts";
import { configFile, readConfig } from "../config.ts";
import { openDb } from "../db.ts";
import { claudeTokenFile, configDir } from "../paths.ts";
import { installPlugin } from "../plugins/install.ts";
import { installedPlugins } from "../plugins/plugin.ts";
import { errorText } from "../say.ts";
import { originHere, parseRemote } from "./origin.ts";
import { promptSecret } from "./secret.ts";
import { installService, loginPath, serviceFile } from "./service.ts";
import { dropCapabilities, onSprite, spriteServiceInstalled } from "./sprite.ts";

// The environment a step looks programs up in and runs them with.
type Env = Record<string, string | undefined>;

// The harnesses agents can run on, in the order the first run offers them.
const harnesses = [
  {
    name: "claude",
    title: "Claude Code",
    command: "claude",
    install: "curl -fsSL https://claude.ai/install.sh | bash",
  },
  { name: "codex", title: "Codex", command: "codex", install: "npm install -g @openai/codex" },
] as const;
// The programs agents need on Linux, each with the line that installs it.
const linuxTools = [
  { command: "tmux", install: "sudo apt install tmux" },
  { command: "bwrap", install: "sudo apt install bubblewrap" },
  { command: "git", install: "sudo apt install git" },
];
// On a Mac the sandbox comes with the system, and what Homebrew gives goes in one line.
const brewTools = ["tmux", "git"];
// What a Mac needs beyond Homebrew's tools, with what to do when it is missing.
const macTools = [
  {
    command: "sandbox-exec",
    install: "it comes with macOS, and Skelcrew can't run agents without it",
  },
];

// Returns what to install for agents to have a harness: the one your config saved, or else
// either one, when neither is installed. Each line says how to install it.
function missingHarness(env: Env): string[] {
  const PATH = env.PATH ?? "";
  const saved = readConfig().harness;
  // Before you pick one, any installed harness will do.
  const wanted = harnesses.filter((h) => saved === undefined || h.name === saved);
  if (wanted.some((h) => Bun.which(h.command, { PATH }))) return [];
  return wanted.map((h) => `  ${h.command}: ${h.install}`);
}

// Checks the programs a Mac needs and tries sandbox-exec, stopping setup with what to install
// on failure. Homebrew's tools are named in one line that can be pasted as it is.
function checkMacTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const brew = brewTools.filter((command) => !Bun.which(command, { PATH }));
  const missing = macTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
  lines.push(...missingHarness(env));
  // The brew line goes first, with where to get Homebrew above it when it is missing too.
  if (brew.length > 0) lines.unshift(`  brew install ${brew.join(" ")}`);
  if (brew.length > 0 && !Bun.which("brew", { PATH }))
    lines.unshift("  Homebrew, for the line below: https://brew.sh");
  if (lines.length > 0) throw new Error(`Install these first:\n${lines.join("\n")}`);
  // A sandbox that allows everything, to see that sandbox-exec starts one at all.
  const tried = Bun.spawnSync(["sandbox-exec", "-p", "(version 1)(allow default)", "true"], {
    env,
    stderr: "pipe",
  });
  if (!tried.success)
    throw new Error(`sandbox-exec can't start a sandbox here: ${tried.stderr.toString().trim()}`);
}

// Checks the programs agents need on Linux and tries bubblewrap. Stops setup with what to
// install, or how to let bubblewrap run.
function checkLinuxTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const bwrap = Bun.which("bwrap", { PATH });
  const missing = linuxTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
  lines.push(...missingHarness(env));
  // A missing bwrap is in the lines already, and checking it here too tells TypeScript it
  // is found below.
  if (lines.length > 0 || !bwrap) {
    throw new Error(`Install these first:\n${lines.join("\n")}`);
  }
  // Reviews look at the thread's clone through an overlay, which bubblewrap has only since
  // 0.11. An older one, such as Ubuntu 24.04's 0.9, passes every other check here and then fails
  // every review, so it stops setup before anything is asked.
  const answer = Bun.spawnSync([bwrap, "--version"], { stderr: "pipe" }).stdout.toString();
  const version = answer.match(/(\d+)\.(\d+)(\.\d+)?/);
  if (version && Number(version[1]) === 0 && Number(version[2]) < 11)
    throw new Error(
      `bwrap is ${version[0]} here, and Skelcrew needs 0.11 or newer for its reviews. Ubuntu 26.04 has it.`,
    );
  // Being installed isn't being allowed: on Ubuntu 24.04 and later, AppArmor stops bwrap
  // making the namespaces it needs, and every agent would fail to start.
  const caps = onSprite(PATH) ? dropCapabilities : [];
  const tried = Bun.spawnSync([...caps, bwrap, "--ro-bind", "/", "/", "true"], { stderr: "pipe" });
  if (!tried.success) {
    const said = tried.stderr.toString().trim();
    throw new Error(
      `bwrap can't start a sandbox here: ${said}\n${apparmorAdvice(realpathSync(bwrap))}`,
    );
  }
}

// Returns advice for allowing bubblewrap through AppArmor without weakening Ubuntu's
// existing profile. Ubuntu's own profile for /usr/bin/bwrap lets bwrap make namespaces
// while keeping what it runs confined. A profile replacing it would let anything use bwrap
// to get around the restriction, so ours gets a name of its own and covers only a bwrap
// elsewhere. AppArmor matches the file a link points to, hence the resolved path.
function apparmorAdvice(bwrap: string): string {
  const intro =
    "On Ubuntu 24.04 and later, AppArmor may block it unless a profile allows it. Other\n" +
    "causes fail the same way, such as the kernel's user namespace setting or a container.";
  // Ubuntu's own bwrap: either its profile is loaded and something else blocks it, or the
  // profile ships and only needs loading. Any other bwrap gets a profile of Skelcrew's.
  const shipped = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
  if (bwrap === "/usr/bin/bwrap" && existsSync("/etc/apparmor.d/bwrap-userns-restrict"))
    return `${intro} Ubuntu's profile for bwrap is in place already, so look at those first.`;
  if (bwrap === "/usr/bin/bwrap" && existsSync(shipped))
    return `${intro} Ubuntu ships a profile for it; this loads it:
  sudo cp ${shipped} /etc/apparmor.d/
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`;
  return `${intro} This adds a profile for ${bwrap}:
  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile skelcrew-bwrap ${bwrap} flags=(unconfined) {\\n  userns,\\n  include if exists <local/skelcrew-bwrap>\\n}\\n' | sudo tee /etc/apparmor.d/skelcrew-bwrap
  sudo apparmor_parser -r /etc/apparmor.d/skelcrew-bwrap`;
}

// Returns what is wrong with a pasted token, or null when it looks like one. Claude Code
// itself tells its login tokens apart by this prefix. It reports any token as logged in
// without asking the server, so the form is all Skelcrew can check here.
function tokenProblem(token: string): string | null {
  if (token === "") return "Nothing was pasted";
  if (/\s/.test(token)) return "That has spaces in it, and a token is one word";
  if (!token.startsWith("sk-ant-oat"))
    return "That doesn't start with sk-ant-oat, so it isn't a token from claude setup-token";
  return null;
}

// Saves privately the token you paste from claude setup-token, which you run yourself in
// another terminal. Agents log in with such a token, which never renews, so they never race your
// own Claude Code for a refresh. Skelcrew doesn't run it, so its text never mixes with Skelcrew's,
// and over ssh you run it on your laptop, where the browser is. A wrong paste is asked for again.
function saveClaudeToken(): void {
  // Each wrong paste asks again, saying what was wrong with the last one.
  let question = "Token:";
  for (;;) {
    const answer = promptSecret(question);
    if (answer === null) throw new Error("no token was pasted, so none is saved");
    const token = answer.trim();
    const problem = tokenProblem(token);
    if (problem === null) {
      mkdirSync(configDir(), { recursive: true });
      // Created readable only by you, so the token is never in a file others can read.
      writeFileSync(claudeTokenFile(), `${token}\n`, { mode: 0o600, flag: "wx" });
      return;
    }
    question = `${problem}. Paste it again:`;
  }
}

// Returns the settings for Skelcrew's own Codex login, which every Codex agent and review shares:
// apart from yours in ~/.codex, so a renewal on either side never breaks the other.
const codexEnv = (env: Env): Env => ({ ...env, CODEX_HOME: codexHome() });

// Reports whether Skelcrew's own Codex login exists. Reviews can change only the login and session
// files in its folder, so running codex on it with your rights runs nothing a reviewer left
// there. codex login status reads only the saved login: a key in your environment doesn't
// count.
function codexLoggedIn(env: Env): boolean {
  const status = ["codex", "login", "status"];
  return Bun.spawnSync(status, { env: codexEnv(env), stdout: "pipe", stderr: "pipe" }).success;
}

// Logs Skelcrew in to Codex in its own folder, with a code you enter on any device, since the
// machine may have no browser. `line` says whose login it is and waits for Enter at a terminal,
// so you choose when it starts. Codex runs on the terminal's alternate screen, as less does, so
// its link and code get a clean screen, and Skelcrew's lines are as they were when it ends. When
// it fails, Skelcrew waits for Enter before switching back, so you can read why. Without a
// terminal, its text shows inline. While Codex runs, Ctrl-C stops only Codex.
function logInCodex(env: Env, line: string): void {
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  // Bun's prompt answers a bare Enter as it answers Ctrl-D, so the secret's prompt waits,
  // which also stops Skelcrew on Ctrl-C with your terminal as it was.
  if (process.stdin.isTTY) promptSecret(line);
  else console.log(line);
  // The alternate screen needs a terminal that understands it.
  const screen = process.stdout.isTTY && process.env.TERM !== "dumb";
  if (screen) process.stdout.write("\x1b[?1049h\x1b[H");
  // Ctrl-C reaches both codex and Skelcrew, and only codex should stop on it.
  const ignore = () => {};
  process.on("SIGINT", ignore);
  let ran = false;
  try {
    const login = ["codex", "login", "--device-auth"];
    ran = Bun.spawnSync(login, {
      env: codexEnv(env),
      stdio: ["inherit", "inherit", "inherit"],
    }).success;
  } finally {
    process.off("SIGINT", ignore);
    // Codex's reason for failing is on the alternate screen, which switching back would
    // hide.
    if (screen && !ran && process.stdin.isTTY)
      promptSecret("\nCodex's sign-in didn't finish. Press Enter to go back.");
    if (screen) process.stdout.write("\x1b[?1049l");
  }
  if (!ran) throw new Error("codex login didn't finish, so Codex has no login for Skelcrew");
  console.log("Signed in to Codex.");
}

// The plugin sc offers in a checkout of a GitHub repository.
const githubPlugin = "skelcrew/skelcrew-github";

// Returns whether a plugin named github is installed, so sc offers it only until it is.
const hasGitHubPlugin = () => installedPlugins(openDb()).some((p) => p.name === "github");

// Returns the repository to offer the GitHub plugin for, as owner/name, or null for none: a
// remote that isn't on github.com, a machine with the plugin, or a repository you said no for.
// Only the remote is read, with no call to GitHub, as plain sc must start fast.
function gitHubToOffer(remote: string | null): string | null {
  const found = remote === null ? null : parseRemote(remote);
  if (found?.host !== "github.com" || hasGitHubPlugin()) return null;
  const repository = `${found.owner}/${found.repo}`;
  // GitHub's names ignore case, so a no for Simon/App covers simon/app.
  const declined = readConfig().declined.map((name) => name.toLowerCase());
  return declined.includes(repository.toLowerCase()) ? null : repository;
}

// Offers to install the GitHub plugin for a checkout of `repository`. A yes installs it
// without asking again, since you said yes to it by name. A no is saved in config.yaml, so no
// checkout of the repository asks again, and you can undo it there. A failed install is only
// reported: Skelcrew works from git alone until you run sc plugin install.
function offerGitHub(repository: string, remote: string): void {
  console.log("GitHub detected.\n");
  const answer = prompt(
    "The GitHub plugin lets Skelcrew work with issues, pull requests\nand CI on your repositories. Install the GitHub plugin? [Y/n]",
  );
  // Bun's prompt answers a bare Enter with null, which takes the default, yes.
  if (!["", "y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
    const { config, declined } = readConfig();
    config.set("github_declined", [...declined, repository]);
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), config.toString());
    console.log(
      `Skelcrew won't ask again for ${repository}. To install it: sc plugin install ${githubPlugin}`,
    );
    return;
  }
  // The plugin's setup is handed the remote, so it can set itself up for this repository.
  try {
    installPlugin(githubPlugin, remote, false);
  } catch (error) {
    console.log(`Couldn't install the GitHub plugin: ${errorText(error)}`);
  }
}

// Asks whether agents run on Claude Code or Codex, refuses one that isn't installed, and saves
// the choice. Enter picks the first one installed.
function pickHarness(env: Env): void {
  const { config } = readConfig();
  const PATH = env.PATH ?? "";
  console.log("Choose the coding agent:");
  for (const [at, h] of harnesses.entries()) console.log(`  ${at + 1}) ${h.title}`);
  // The first one installed is the default, so Enter picks a harness that works.
  const installed = harnesses.findIndex((h) => Bun.which(h.command, { PATH }));
  // Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a
  // default: then Enter gives the default and only Ctrl-D gives null.
  const answer = prompt("Number:", String(installed + 1));
  if (answer === null) throw new Error("no harness was picked, so none is saved");
  const picked = harnesses[Number(answer.trim()) - 1];
  if (!picked) throw new Error(`${answer.trim()} isn't one of the numbers, so no harness is saved`);
  if (!Bun.which(picked.command, { PATH }))
    throw new Error(`${picked.title} isn't installed. Install it first: ${picked.install}`);
  config.set("harness", picked.name);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
}

// Returns the harness your config names for reviews, or none when reviews run on your harness.
function savedReviewerHarness(): HarnessName | undefined {
  const read = HarnessName.safeParse(readConfig().config.getIn(["reviewer", "harness"]));
  return read.success ? read.data : undefined;
}

// Asks which harness reviews run on, offering the other one first, as a second model sees what
// the builder's model misses. Saves it only when it isn't your harness, which reviews run on
// anyway.
function pickReviewer(harness: HarnessName): void {
  const other = harnesses.filter((h) => h.name !== harness);
  // The other harness is 1, the default.
  const choices = [...other, ...harnesses.filter((h) => h.name === harness)];
  console.log("Choose the coding agent for reviews:");
  for (const [at, h] of choices.entries())
    console.log(`  ${at + 1}) ${h.title}${at === 0 ? ", for a second opinion" : ""}`);
  const answer = prompt("Number:", "1");
  if (answer === null) throw new Error("no harness was picked for reviews, so none is saved");
  const picked = choices[Number(answer.trim()) - 1];
  if (!picked) throw new Error(`${answer.trim()} isn't one of the numbers, so none is saved`);
  if (picked.name === harness) return;
  const { config } = readConfig();
  config.setIn(["reviewer", "harness"], picked.name);
  writeFileSync(configFile(), config.toString());
}

// Reports whether agents on this harness have their login: Claude Code's token from the
// first run, or Skelcrew's own Codex login, which reviews use too. Only files are looked at, as
// plain sc checks this each time it starts.
function agentsLoggedIn(harness: HarnessName): boolean {
  if (harness === "claude") return existsSync(claudeTokenFile());
  return existsSync(join(codexHome(), "auth.json"));
}

// Reports whether setup finished: your harness choice is saved, the agents have their login,
// and the daemon's service is installed. Setup installs the service last, so with it every
// step ran. Plain sc checks this each time it starts, so it looks only at files, and at
// sprite-env on a Sprite.
export function setupDone(): boolean {
  const service = onSprite() ? spriteServiceInstalled() : existsSync(serviceFile());
  const { harness } = readConfig();
  if (harness === undefined) return false;
  return agentsLoggedIn(harness) && service;
}

// Completes unfinished machine setup and keeps the daemon service current before attaching
// to the lead. In a checkout of a GitHub repository it offers the GitHub plugin, on any run. A yes
// makes GitHub the repository's tracker too, with nothing written into the checkout. `from` is
// the remote sc --remote brings from your laptop, since the checkout is there.
export function firstRun(from?: string): void {
  const done = setupDone();
  // The tools are found where your login shell finds them, even over ssh, so a codex
  // under nvm isn't taken for missing. Passed to each one, since Bun looks programs up in
  // the PATH it started with, whatever process.env says later.
  const env = done ? process.env : { ...process.env, PATH: loginPath() };
  if (!done) {
    if (process.platform === "darwin") checkMacTools(env);
    else checkLinuxTools(env);
    console.log("Setting up Skelcrew...\n");
  }
  // Read once git is known to be there.
  const remote = from ?? originHere();
  const github = gitHubToOffer(remote);
  if (github !== null && remote !== null) offerGitHub(github, remote);
  if (!done) {
    // The steps left are worked out again after each one, as the harness you pick decides
    // which login comes next.
    let taken = "";
    const asked = { reviewer: false };
    for (;;) {
      const [step] = stepsToTake(env, asked);
      if (!step) break;
      // A step that comes back right after it was taken didn't do its job, and asking again
      // would never end.
      if (step.title === taken) throw new Error(`${step.title} didn't finish`);
      // A blank line parts each step from the one before, and the first from the offer.
      if (taken !== "" || github !== null) console.log("");
      step.take();
      taken = step.title;
    }
    // Reviews fall back to your harness when the other one isn't installed, which is worth
    // a line.
    const yours = harnesses.find((h) => h.name === readConfig().harness);
    const other = harnesses.find((h) => h !== yours);
    if (yours && other && !Bun.which(other.command, { PATH: env.PATH ?? "" }))
      console.log(`\n${other.title} isn't installed, so reviews run on ${yours.title}.`);
  }
  installService();
  if (!done) console.log("\nSkelcrew is set up.");
}

// A step of the first run: `title` names it, and `take` asks what it needs, starting with a line
// that says what it is.
type Step = { title: string; take: () => void };

// Returns the first run's steps that aren't done yet. `asked` says whether you were asked about
// reviews in this run, as reviews on your own harness save nothing to show it. Until you pick a
// harness, Claude Code's login is counted, as Enter usually picks it.
function stepsToTake(env: Env, asked: { reviewer: boolean }): Step[] {
  const steps: Step[] = [];
  const { harness } = readConfig();
  if (!harness) steps.push({ title: "the coding agent", take: () => pickHarness(env) });
  const PATH = env.PATH ?? "";
  // Reviews are asked about only when both harnesses are installed, as otherwise there is
  // nothing to pick.
  const both = harnesses.every((h) => Bun.which(h.command, { PATH }));
  if (harness && both && !savedReviewerHarness() && !asked.reviewer)
    steps.push({
      title: "the coding agent for reviews",
      take: () => {
        pickReviewer(harness);
        asked.reviewer = true;
      },
    });
  // Whether agents or reviews run on the harness, and so need its login.
  const agents = harness ?? "claude";
  const uses = (name: HarnessName) =>
    agents === name || (savedReviewerHarness() ?? agents) === name;
  if (uses("claude") && !existsSync(claudeTokenFile())) {
    const forReviews = harness === "codex" ? " for reviews" : "";
    steps.push({
      title: "Claude's sign-in",
      take: () => {
        // The command sits on a line of its own, bold where the terminal shows it, so it
        // reads as something to copy and run, not as part of the sentence.
        const bold = process.stdout.isTTY && process.env.TERM !== "dumb";
        const command = bold ? "\x1b[1mclaude setup-token\x1b[22m" : "claude setup-token";
        console.log(`Sign in to Claude${forReviews}. In another terminal, run:\n\n  ${command}\n`);
        console.log("Then paste the token here.");
        saveClaudeToken();
      },
    });
  }
  // Every Codex agent and review shares Skelcrew's own Codex login.
  const forReviews = harness === "codex" ? "" : " for reviews";
  if (uses("codex") && !codexLoggedIn(env))
    steps.push({
      title: "Codex's sign-in",
      take: () => logInCodex(env, `Sign in to Codex${forReviews}. Press Enter to start.`),
    });
  return steps;
}
