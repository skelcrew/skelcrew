// The first run: what a plain sc sets up on a new machine, skipping each step already
// done.
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { codexHome } from "../agents/codex.ts";
import { HarnessName, harnessNamed } from "../agents/harness.ts";
import { hasPiLogin, piHome } from "../agents/pi-login.ts";
import { approvedAgents } from "../approved-agents.ts";
import { agentRole, configFile, yourConfigDocument } from "../config.ts";
import { openDb } from "../db.ts";
import { repositoryFlows } from "../flows.ts";
import { errorText, toRun } from "../format.ts";
import { claudeTokenFile, configDir, dataDir, installDoneFile, setUpFile } from "../paths.ts";
import { addPlugin, installYourPlugins } from "../plugins/install.ts";
import { yourPlugins } from "../plugins/lock.ts";
import { installedPlugins } from "../plugins/plugin.ts";
import {
  cantTell,
  checkoutNames,
  everyNamed,
  gitHubShown,
  githubPlugin,
  installRepositoryPlugins,
  type Need,
  repositoryNeeds,
} from "../plugins/repository.ts";
import { readSettings } from "../settings.ts";
import { originHere, parseRemote } from "./origin.ts";
import { pick } from "./pick.ts";
import { promptSecret } from "./secret.ts";
import { loginPath, serviceFile } from "./service.ts";

// The environment a step looks programs up in and runs them with.
type Env = Record<string, string | undefined>;

// The harnesses the first run offers, in order. Pi is experimental, so agents run on it only
// where your config names it.
const harnesses = HarnessName.options.filter((name) => name !== "pi").map(harnessNamed);
// The programs agents need on Linux, each with the apt package that has it.
const linuxTools = [
  { command: "tmux", package: "tmux" },
  { command: "bwrap", package: "bubblewrap" },
  { command: "git", package: "git" },
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

// Returns the commands that install a harness for agents, when none they can run is installed:
// the one your config saved, or else either one. Empty when one is there.
function missingHarness(env: Env): string[] {
  const PATH = env.PATH ?? "";
  const saved = readSettings(["yourHarness"]).yourHarness;
  // Before you pick one, any installed harness will do.
  const wanted = saved === undefined ? harnesses : [harnessNamed(saved)];
  const missing = wanted.some((h) => Bun.which(h.program, { PATH })) ? [] : wanted;
  // A role that names Pi needs it, whichever harness is yours.
  if (piInUse() && !Bun.which(harnessNamed("pi").program, { PATH }))
    missing.push(harnessNamed("pi"));
  return [...new Set(missing.map((h) => h.install))];
}

// Returns whether a role runs on Pi: yours, your reviewer's, or a role of a repository Skelcrew
// has, as you approved its .agents/: its lead, and the builder and reviewer of each of its
// flows, which can be roles of its own. Pi is experimental, so only a role that names it uses
// it. A flow whose settings can't be read counts for none, as its agents stop on that anyway.
function piInUse(): boolean {
  const { yourHarness, yourReviewer } = readSettings(["yourHarness", "yourReviewer"]);
  if (yourHarness === "pi" || yourReviewer === "pi") return true;
  const db = openDb();
  try {
    const repositories = z
      .array(z.object({ owner: z.string(), repo: z.string() }))
      .parse(db.query("SELECT owner, repo FROM repositories").all());
    const named = (read: () => boolean) => {
      try {
        return read();
      } catch {
        return false;
      }
    };
    const stages = ["builder", "reviewer"] as const;
    return repositories.some((place) => {
      const repository = { ...place, agents: approvedAgents(place) };
      if (named(() => agentRole("lead", repository).harness === "pi")) return true;
      return named(() =>
        repositoryFlows(repository).some((flow) =>
          named(() =>
            stages.some((role) => agentRole(role, { ...repository, flow }).harness === "pi"),
          ),
        ),
      );
    });
  } finally {
    db.close();
  }
}

// Checks that Pi is installed and signed in once a role runs on it, for sc install and plain sc
// after they added the checkout you are in: the first run, before that, couldn't read its roles.
export function setUpPiForRoles(): void {
  if (!piInUse()) return;
  const env = Bun.which("pi") ? process.env : { ...process.env, PATH: loginPath() };
  const pi = harnessNamed("pi");
  if (!Bun.which(pi.program, { PATH: env.PATH ?? "" })) stopForTools([], [], [pi.install]);
  if (hasPiLogin(homedir())) return;
  console.log("");
  logInPi(env, "Sign in to Pi for the roles that run on it.");
}

// Stops the first run, before it asks anything, when a program agents need is missing, saying
// what to install. `tools` are the commands that install the tools, and `before` what to read
// above them, such as where to get Homebrew. A harness comes last, as a choice when either will
// do. It reads as a step to take, not as an error, so it isn't on stderr and has no Skelcrew:
// in front, and sc exits with 1, so a script can tell nothing was set up.
function stopForTools(before: string[], tools: string[], harness: string[]): void {
  if (before.length + tools.length + harness.length === 0) return;
  const lines = ["Before Skelcrew can start, install:", ...before];
  if (tools.length > 0) lines.push(toRun(tools));
  if (harness.length > 0)
    lines.push(harness.length > 1 ? "a coding agent, one of:" : "a coding agent:", toRun(harness));
  lines.push("Then run sc again.");
  console.log(lines.join("\n"));
  process.exit(1);
}

// Checks the programs a Mac needs and tries sandbox-exec, stopping setup with what to install
// on failure. Homebrew's tools are named in one line that can be pasted as it is.
function checkMacTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const brew = brewTools.filter((command) => !Bun.which(command, { PATH }));
  const missing = macTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const before = missing.map((tool) => `${tool.command}: ${tool.install}`);
  // Where to get Homebrew goes above its line, when it is missing too.
  if (brew.length > 0 && !Bun.which("brew", { PATH }))
    before.push("Homebrew, for the line below, from https://brew.sh");
  const tools = brew.length > 0 ? [`brew install ${brew.join(" ")}`] : [];
  stopForTools(before, tools, missingHarness(env));
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
  // Every missing package goes in one apt line, which can be pasted as it is.
  const missing = linuxTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const apt = missing.map((tool) => tool.package);
  stopForTools(
    [],
    apt.length > 0 ? [`sudo apt install ${apt.join(" ")}`] : [],
    missingHarness(env),
  );
  // A missing bwrap stopped setup above, and checking it here too tells TypeScript it is found
  // below.
  if (!bwrap) return;
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
  const tried = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "true"], { stderr: "pipe" });
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
  while (true) {
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

// Logs Skelcrew in to Pi in its own folder, which no agent sees, for the provider you name: Pi
// signs in with an account, or saves the provider's API key. A key in your shell never reaches
// the agents, as the daemon's service gets only PATH, so this login is what they run on. Pi
// uses a device code or a link rather than a browser here, as the machine may have none.
function logInPi(env: Env, line: string): void {
  console.log(line);
  const provider = prompt("Provider, such as anthropic, openai-codex or openrouter:")?.trim() ?? "";
  if (!/^[\w.-]+$/.test(provider))
    throw new Error("no provider was named, so Pi has no login for Skelcrew");
  mkdirSync(piHome(), { recursive: true, mode: 0o700 });
  const piEnv = { ...env, PI_CODING_AGENT_DIR: piHome() };
  const login = ["pi", "auth", "login", provider, "--no-browser"];
  Bun.spawnSync(login, { env: piEnv, stdio: ["inherit", "inherit", "inherit"] });
  const check = ["pi", "auth", "check", "--provider", provider];
  if (!Bun.spawnSync(check, { env: piEnv, stdout: "pipe", stderr: "pipe" }).success)
    throw new Error("pi auth login didn't finish, so Pi has no login for Skelcrew");
  console.log("Signed in to Pi.");
}

// Returns whether a plugin named github is installed, so sc offers it only until it is.
const hasGitHubPlugin = () => installedPlugins(openDb()).some((p) => p.name === "github");

// Returns the repository to offer the GitHub plugin for, as owner/name, or null for none: a
// remote that isn't on github.com, a machine with the plugin, files of yours or of the checkout you
// are in that name it already, or a repository you said no for. Files that name it leave it to sc
// install, at the version their lock pins, which the offer's newest version would replace. Only
// files are read, with no call to GitHub, as plain sc must start fast.
function gitHubToOffer(remote: string | null): string | null {
  const found = remote === null ? null : parseRemote(remote);
  if (found?.host !== "github.com" || hasGitHubPlugin()) return null;
  if (yourPlugins().includes(githubPlugin) || checkoutNames(githubPlugin)) return null;
  const repository = `${found.owner}/${found.repo}`;
  // GitHub's names ignore case, so a no for Simon/App covers simon/app.
  const declined = readSettings(["declined"]).declined.map((name) => name.toLowerCase());
  return declined.includes(repository.toLowerCase()) ? null : repository;
}

function offerGitHub(repository: string, remote: string): void {
  const shown = gitHubShown(repository);
  let answer: boolean | null = null;
  try {
    answer = addPlugin(githubPlugin, remote, shown);
  } catch (error) {
    console.log(`Couldn't install the GitHub plugin: ${errorText(error)}`);
    return;
  }
  if (answer) return;
  const { declined } = readSettings(["declined"]);
  const config = yourConfigDocument();
  config.set("github_declined", [...declined, repository]);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
  console.log(
    `Skelcrew won't ask again for ${repository}. To install it:\n${toRun([`sc plugin add -g ${githubPlugin}`])}`,
  );
}

// Saves which harness agents run on. With only one installed there is nothing to ask, so it
// says which it found and takes that one. With both, you pick one, Claude Code first. A harness
// that isn't installed is never offered, as the tools check stopped setup without one.
function pickHarness(env: Env): void {
  const config = yourConfigDocument();
  const PATH = env.PATH ?? "";
  const installed = harnesses.filter((h) => Bun.which(h.program, { PATH }));
  let picked = installed[0];
  if (installed.length === 1 && picked) {
    for (const h of harnesses) console.log(`${h.title} ${h === picked ? "detected" : "not found"}`);
    console.log(`Agents will run on ${picked.title}`);
  } else {
    const choices = installed.map((h) => ({ label: h.title, hint: "installed" }));
    const at = pick("Choose the coding agent:", choices);
    if (at === null) throw new Error("no harness was picked, so none is saved");
    picked = installed[at];
  }
  if (!picked) throw new Error("no harness is installed, so none is saved");
  config.set("harness", picked.name);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
}

// Returns the harness your config names for reviews, or none when reviews run on your harness.
function savedReviewerHarness(): HarnessName | undefined {
  return readSettings(["yourReviewer"]).yourReviewer;
}

// Asks which harness reviews run on, offering the other one first, as a second model sees what
// the builder's model misses. Saves it only when it isn't your harness, which reviews run on
// anyway.
function pickReviewer(harness: HarnessName): void {
  // The other harness comes first, so Enter takes it.
  const choices = [
    ...harnesses.filter((h) => h.name !== harness),
    ...harnesses.filter((h) => h.name === harness),
  ];
  const at = pick(
    "Choose the coding agent for reviews:",
    // Both are installed, as the question comes only then, and say so as the first question
    // does. The other harness, first, is marked as the second opinion it gives.
    choices.map((h, index) => ({
      label: h.title,
      hint: index === 0 ? "installed · a second opinion" : "installed",
    })),
  );
  if (at === null) throw new Error("no harness was picked for reviews, so none is saved");
  const picked = choices[at];
  if (!picked || picked.name === harness) return;
  const config = yourConfigDocument();
  config.setIn(["roles", "reviewer", "harness"], picked.name);
  writeFileSync(configFile(), config.toString());
}

// Reports whether agents on this harness have their login: Claude Code's token from the
// first run, or Skelcrew's own Codex or Pi login, which reviews use too. Only files are looked
// at, as plain sc checks this each time it starts.
function agentsLoggedIn(harness: HarnessName): boolean {
  if (harness === "claude") return existsSync(claudeTokenFile());
  if (harness === "pi") return hasPiLogin(homedir());
  return existsSync(join(codexHome(), "auth.json"));
}

// Reports whether setup finished: your harness choice is saved, the agents have their login,
// and every step ran, which the first run marks at its end. A step can save nothing, such as
// picking your own harness for reviews, so without the mark an interrupted first run would skip
// it. A machine set up by an older Skelcrew has the daemon's service in place of the mark, as
// that first run installed the service last. Plain sc checks this each time it starts, so it
// looks only at files.
export function setupDone(): boolean {
  const harness = readSettings(["yourHarness"]).yourHarness;
  if (harness === undefined) return false;
  // Pi must be there too, found here or where your login shell finds it, as firstRun looks.
  const piFound = () => Bun.which("pi") !== null || Bun.which("pi", { PATH: loginPath() }) !== null;
  const piReady = !piInUse() || (agentsLoggedIn("pi") && piFound());
  return (
    agentsLoggedIn(harness) && piReady && (existsSync(setUpFile()) || existsSync(serviceFile()))
  );
}

// Completes unfinished machine setup before plain sc starts the daemon and attaches to the
// lead. In a checkout of a GitHub repository it offers the GitHub plugin, on any run. A yes
// makes GitHub the repository's tracker too, with nothing written into the checkout. `from` is
// the remote sc --remote brings from your laptop, since the checkout is there. Returns whether it
// had anything to set up or offer. sc install marks the machine set up after it, once your
// plugins are in too.
export function firstRun(from?: string): boolean {
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
  // Read once git is known to be there. The offer installs a plugin, which only a yes at a
  // terminal can do, so with no terminal it isn't made.
  const remote = from ?? originHere();
  const github = process.stdin.isTTY ? gitHubToOffer(remote) : null;
  if (github !== null && remote !== null) offerGitHub(github, remote);
  if (!done) {
    // The steps left are worked out again after each one, as the harness you pick decides
    // which login comes next.
    let taken = "";
    const asked = { reviewer: false };
    while (true) {
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
  }
  return !done || github !== null;
}

export function install(from?: string, plain = false): boolean {
  const finished = installFinished();
  rmSync(installDoneFile(), { force: true });
  const setUp = firstRun(from);
  const conflictsIn = (needs: Need[]) =>
    needs.filter((need) => need.conflict !== null).map((need) => need.source);
  const anywhere: string[] = [];
  const everyNeed = everyNamed(anywhere);
  const { changed: plugins, left: notHere } = installYourPlugins(
    from ?? originHere(),
    conflictsIn(repositoryNeeds(false, [])),
    cantTell(anywhere) ?? everyNeed,
  );
  const unreadable: string[] = [];
  const needs = repositoryNeeds(false, unreadable);
  const conflicting = conflictsIn(needs);
  const left = [
    ...new Set([...notHere, ...yourPlugins().filter((source) => conflicting.includes(source))]),
  ];
  const missing = left.filter((source) => !conflicting.includes(source));
  const disagreeing = left.filter((source) => conflicting.includes(source));
  if (missing.length > 0)
    console.log(
      `\nSkelcrew isn't set up yet, as your config.yaml names ${missing.join(", ")}, which this machine doesn't have at the version your lock pins. Plain sc asks again. To leave it out here and everywhere, run sc plugin rm -g with its name.`,
    );
  if (disagreeing.length > 0)
    console.log(
      `\nSkelcrew isn't set up yet, as your lock and a repository pin ${disagreeing.join(", ")} at different commits. Plain sc asks again. Pin the same version in each.`,
    );
  const ready = left.length === 0;
  if (ready) {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(setUpFile(), "");
    writeFileSync(installDoneFile(), "");
  }
  if (unreadable.length > 0)
    console.log(
      `\nSkelcrew can't read the plugins of ${unreadable.join("; ")}, so it installs none of them and removes no plugin. Fix the file, then run sc install again.`,
    );
  const repositories = installRepositoryPlugins(needs);
  if (!ready) return false;
  if (!finished && (setUp || plugins || repositories.changed)) console.log("\nSkelcrew is set up.");
  else if (
    !plain &&
    !setUp &&
    !plugins &&
    !repositories.changed &&
    !repositories.missing &&
    unreadable.length === 0
  )
    console.log("Nothing to install: this machine has everything your files ask for.");
  return !repositories.missing && unreadable.length === 0;
}

// Reports whether sc install ran to its end here, which plain sc checks to know whether to run it
// again. Neither the daemon's service nor the first run's own mark counts, unlike for setupDone:
// plain sc installs the service even after a first run where you said no to a plugin your files
// name, and an older release wrote the mark without installing your plugins.
export function installFinished(): boolean {
  return setupDone() && existsSync(installDoneFile());
}

// A step of the first run: `title` names it, and `take` asks what it needs, starting with a line
// that says what it is.
type Step = { title: string; take: () => void };

// Returns the first run's steps that aren't done yet. `asked` says whether you were asked about
// reviews in this run, as reviews on your own harness save nothing to show it. Until you pick a
// harness, Claude Code's login is counted, as Enter usually picks it.
function stepsToTake(env: Env, asked: { reviewer: boolean }): Step[] {
  const steps: Step[] = [];
  const harness = readSettings(["yourHarness"]).yourHarness;
  if (!harness) steps.push({ title: "the coding agent", take: () => pickHarness(env) });
  const PATH = env.PATH ?? "";
  // Reviews are asked about only when both harnesses are installed, as otherwise there is
  // nothing to pick.
  const both = harnesses.every((h) => Bun.which(h.program, { PATH }));
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
    const forReviews = harness !== undefined && harness !== "claude" ? " for reviews" : "";
    steps.push({
      title: "Claude's sign-in",
      take: () => {
        console.log(
          `Sign in to Claude${forReviews}. In another terminal, run:\n${toRun(["claude setup-token"])}`,
        );
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
  if (piInUse() && !hasPiLogin(homedir()))
    steps.push({
      title: "Pi's sign-in",
      take: () => logInPi(env, "Sign in to Pi for the roles that run on it."),
    });
  return steps;
}
