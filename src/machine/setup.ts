// The first run: what a plain skel sets up on a new machine, skipping each step already
// done.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../agents/codex.ts";
import { HarnessName } from "../agents/harness.ts";
import { configFile, readConfig } from "../config.ts";
import { claudeTokenFile, configDir } from "../paths.ts";
import { rule, skelLine } from "../say.ts";
import { promptSecret } from "./secret.ts";
import { installService, loginPath, serviceFile } from "./service.ts";
import { dropCapabilities, onSprite, spriteServiceInstalled } from "./sprite.ts";

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
const tools = [
  { command: "tmux", install: "sudo apt install tmux" },
  { command: "bwrap", install: "sudo apt install bubblewrap" },
  { command: "git", install: "sudo apt install git" },
  { command: "gh", install: "sudo apt install gh" },
];
// On a Mac the sandbox comes with the system, and what Homebrew gives goes in one line.
const brewed = ["tmux", "git", "gh"];
const macTools = [
  { command: "sandbox-exec", install: "it comes with macOS, and skel can't run agents without it" },
];

// Returns what to install for agents to have a harness: the one your config saved, or else
// either one, when neither is installed. Each line says how to install it.
function missingHarness(env: Env): string[] {
  const PATH = env.PATH ?? "";
  const saved = readConfig().harness;
  const wanted = harnesses.filter((h) => saved === undefined || h.name === saved);
  if (wanted.some((h) => Bun.which(h.command, { PATH }))) return [];
  return wanted.map((h) => `  ${h.command}: ${h.install}`);
}

// Checks the programs a Mac needs and tries sandbox-exec, stopping setup with what to install
// on failure. Homebrew's tools are named in one line that can be pasted as it is.
function checkMacTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const brew = brewed.filter((command) => !Bun.which(command, { PATH }));
  const missing = macTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
  lines.push(...missingHarness(env));
  if (brew.length > 0) lines.unshift(`  brew install ${brew.join(" ")}`);
  if (brew.length > 0 && !Bun.which("brew", { PATH }))
    lines.unshift("  Homebrew, for the line below: https://brew.sh");
  if (lines.length > 0) throw new Error(`install these first:\n${lines.join("\n")}`);
  const tried = Bun.spawnSync(["sandbox-exec", "-p", "(version 1)(allow default)", "true"], {
    env,
    stderr: "pipe",
  });
  if (!tried.success)
    throw new Error(`sandbox-exec can't start a sandbox here: ${tried.stderr.toString().trim()}`);
}

// Checks required programs and tries bubblewrap, stopping setup with installation or
// sandbox advice on failure.
function checkTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const bwrap = Bun.which("bwrap", { PATH });
  const missing = tools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
  lines.push(...missingHarness(env));
  if (lines.length > 0 || !bwrap) {
    throw new Error(`install these first:\n${lines.join("\n")}`);
  }
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
  const shipped = "/usr/share/apparmor/extra-profiles/bwrap-userns-restrict";
  if (bwrap === "/usr/bin/bwrap" && existsSync("/etc/apparmor.d/bwrap-userns-restrict"))
    return `${intro} Ubuntu's profile for bwrap is in place already, so look at those first.`;
  if (bwrap === "/usr/bin/bwrap" && existsSync(shipped))
    return `${intro} Ubuntu ships a profile for it; this loads it:
  sudo cp ${shipped} /etc/apparmor.d/
  sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict`;
  return `${intro} This adds a profile for ${bwrap}:
  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile skel-bwrap ${bwrap} flags=(unconfined) {\\n  userns,\\n  include if exists <local/skel-bwrap>\\n}\\n' | sudo tee /etc/apparmor.d/skel-bwrap
  sudo apparmor_parser -r /etc/apparmor.d/skel-bwrap`;
}

// Hands your terminal to an outside login and reports whether it succeeded. Rules naming
// the tool mark where its output starts and ends, without touching it, since the codes and
// tokens it prints must stay on screen. At a terminal, skel first waits for Enter, so you
// choose when each login starts. While the tool runs, Ctrl-C stops only the tool, so the
// way back is marked whatever happens. Ctrl-C at the pause stops skel before anything runs.
function handOver(tool: string, command: string[], env: Env): boolean {
  // Bun's prompt answers a bare Enter as it answers Ctrl-D, so the secret's prompt waits,
  // which also stops skel on Ctrl-C with your terminal as it was.
  if (process.stdin.isTTY) promptSecret(skelLine(`press Enter to start ${tool}'s login`));
  console.log(rule(tool));
  const ignore = () => {};
  process.on("SIGINT", ignore);
  let ran = false;
  try {
    ran = Bun.spawnSync(command, { env, stdio: ["inherit", "inherit", "inherit"] }).success;
    return ran;
  } finally {
    process.off("SIGINT", ignore);
    // A tool stopped by Ctrl-C leaves the terminal's ^C on the line, which would push the
    // rule past the edge.
    console.log(`${ran ? "" : "\n"}${rule("back in skel")}`);
  }
}

// Returns what is wrong with a pasted token, or null when it looks like one. Claude Code
// itself tells its login tokens apart by this prefix. It reports any token as logged in
// without asking the server, so the form is all skel can check here.
function tokenProblem(token: string): string | null {
  if (token === "") return "nothing was pasted";
  if (/\s/.test(token)) return "that has spaces in it, and a token is one word";
  if (!token.startsWith("sk-ant-oat"))
    return "that doesn't start with sk-ant-oat, so it isn't a token from claude setup-token";
  return null;
}

// Runs claude setup-token and saves the token you paste privately. Agents log in with a
// token from claude setup-token, which never renews, so they never race your own Claude
// Code for a refresh. A wrong paste is asked for again, since running setup-token again
// would make another token.
function saveClaudeToken(env: Env): void {
  if (!handOver("Claude Code", ["claude", "setup-token"], env))
    throw new Error("claude setup-token didn't finish, so no token is saved");
  let question = "paste the token Claude printed above (it starts with sk-ant-oat01-):";
  for (;;) {
    const answer = promptSecret(skelLine(question));
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

// Returns the settings for skel's own Codex login, which every Codex agent and review shares:
// apart from yours in ~/.codex, so a renewal on either side never breaks the other.
const codexEnv = (env: Env): Env => ({ ...env, CODEX_HOME: codexHome() });

// Reports whether skel's own Codex login exists. Reviews can change only the login and session
// files in its folder, so running codex on it with your rights runs nothing a reviewer left
// there. codex login status reads only the saved login: a key in your environment doesn't
// count.
function codexLoggedIn(env: Env): boolean {
  const status = ["codex", "login", "status"];
  return Bun.spawnSync(status, { env: codexEnv(env), stdout: "pipe", stderr: "pipe" }).success;
}

// Logs skel in to Codex in its own folder, with a code you enter on any device, since the
// machine may have no browser. Then says who now has the login, `who` as the step named them,
// to mark where Codex's output ends.
function logInCodex(env: Env, who: "agents" | "the reviewer"): void {
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  if (!handOver("Codex", ["codex", "login", "--device-auth"], codexEnv(env)))
    throw new Error(`codex login didn't finish, so Codex has no login for ${who}`);
  console.log(skelLine(`${who} ${who === "agents" ? "are" : "is"} logged in to Codex.`));
}

// Reports whether gh is logged in to GitHub, which the daemon needs to clone repositories
// and manage issues and PRs.
const githubConnected = (env: Env) =>
  Bun.spawnSync(["gh", "auth", "status"], { env, stdout: "pipe", stderr: "pipe" }).success;

// Runs gh auth login in your terminal, then says so, since gh's own last lines can read as
// if more is to come.
function connectGitHub(env: Env): void {
  if (!handOver("gh", ["gh", "auth", "login"], env))
    throw new Error("gh auth login didn't finish, so skel can't reach GitHub");
  console.log(skelLine("connected to GitHub."));
}

// Asks whether agents run on Claude Code or Codex, refuses one that isn't installed, and saves
// the choice. Enter picks the first one installed.
function pickHarness(env: Env): void {
  const { config } = readConfig();
  const PATH = env.PATH ?? "";
  for (const [at, h] of harnesses.entries()) console.log(`  ${at + 1}) ${h.title}`);
  const installed = harnesses.findIndex((h) => Bun.which(h.command, { PATH }));
  // Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a
  // default: then Enter gives the default and only Ctrl-D gives null.
  const answer = prompt(skelLine("pick one by its number"), String(installed + 1));
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
function reviewerSaved(): HarnessName | undefined {
  const read = HarnessName.safeParse(readConfig().config.getIn(["reviewer", "harness"]));
  return read.success ? read.data : undefined;
}

// Asks which harness reviews run on, offering the other one first, as a second model sees what
// the builder's model misses. Saves it only when it isn't your harness, which reviews run on
// anyway.
function pickReviewer(harness: HarnessName): void {
  const other = harnesses.filter((h) => h.name !== harness);
  const choices = [...other, ...harnesses.filter((h) => h.name === harness)];
  for (const [at, h] of choices.entries()) console.log(`  ${at + 1}) ${h.title}`);
  const answer = prompt(skelLine("pick one by its number"), "1");
  if (answer === null) throw new Error("no harness was picked for reviews, so none is saved");
  const picked = choices[Number(answer.trim()) - 1];
  if (!picked) throw new Error(`${answer.trim()} isn't one of the numbers, so none is saved`);
  if (picked.name === harness) return;
  const { config } = readConfig();
  config.setIn(["reviewer", "harness"], picked.name);
  writeFileSync(configFile(), config.toString());
}

// Reports whether agents on this harness have their login: Claude Code's token from the
// first run, or skel's own Codex login, which reviews use too. Only files are looked at, as
// plain skel checks this each time it starts.
function agentsLoggedIn(harness: HarnessName): boolean {
  if (harness === "claude") return existsSync(claudeTokenFile());
  return existsSync(join(codexHome(), "auth.json"));
}

// Reports whether saved settings, token and service show that setup finished, avoiding
// repeated login checks. Setup saves the service last, after the logins, so these
// files show every step ran. Missing tools or logins fail where used; checking each attach
// would require a GitHub call.
export function setupDone(): boolean {
  const service = onSprite() ? spriteServiceInstalled() : existsSync(serviceFile());
  const { harness } = readConfig();
  if (harness === undefined) return false;
  return agentsLoggedIn(harness) && service;
}

// Completes unfinished machine setup and keeps the daemon service current before attaching
// to the lead.
export function firstRun(): void {
  const done = setupDone();
  if (!done) {
    // The tools are found where your login shell finds them, even over ssh, so a codex
    // under nvm isn't taken for missing. Passed to each one, since Bun looks programs up in
    // the PATH it started with, whatever process.env says later.
    const env = { ...process.env, PATH: loginPath() };
    if (process.platform === "darwin") checkMacTools(env);
    else checkTools(env);
    // The steps left are worked out again after each one, as the harness you pick decides
    // which login comes next.
    let taken = "";
    const asked = { reviewer: false };
    for (let at = 1; ; at++) {
      const [step, ...rest] = stepsToTake(env, asked);
      if (!step) break;
      if (step.title === taken) throw new Error(`${step.title} didn't finish`);
      console.log(`\n${skelLine(`step ${at} of ${at + rest.length}: ${step.title}`)}`);
      console.log(`  ${step.about}`);
      step.take();
      taken = step.title;
    }
    const yours = readConfig().harness;
    const other = harnesses.find((h) => h.name !== yours);
    if (other && !Bun.which(other.command, { PATH: env.PATH }))
      console.log(
        skelLine(
          `${other.title} isn't installed, so reviews will run on your harness, with no second view on another model.`,
        ),
      );
  }
  installService();
  if (done) return;
  console.log(skelLine("setup is done."));
  if (process.platform === "darwin")
    console.log(
      skelLine(
        "a laptop sleeps, so work stops while the lid is closed. skel remote add keeps it going, on a server or a Sprite.",
      ),
    );
}

type Step = { title: string; about: string; take: () => void };

// Returns the first run's steps that aren't done yet, so their numbers count only what
// runs this time. `asked` says whether you were asked about reviews in this run, as reviews on
// your own harness save nothing to show it. Until you pick a harness, Claude Code's login is
// counted, as Enter usually picks it.
function stepsToTake(env: Env, asked: { reviewer: boolean }): Step[] {
  const steps: Step[] = [];
  if (!githubConnected(env))
    steps.push({
      title: "connect to GitHub",
      about: "gh will log you in. skel uses this login for everything it does on GitHub.",
      take: () => connectGitHub(env),
    });
  const { harness } = readConfig();
  if (!harness)
    steps.push({
      title: "pick a harness",
      about: "The harness is the coding agent that does the work: Claude Code or Codex.",
      take: () => pickHarness(env),
    });
  const PATH = env.PATH ?? "";
  const both = harnesses.every((h) => Bun.which(h.command, { PATH }));
  if (harness && both && !reviewerSaved() && !asked.reviewer)
    steps.push({
      title: "pick a harness for reviews",
      about: "A reviewer on another model sees what the builder's model misses.",
      take: () => {
        pickReviewer(harness);
        asked.reviewer = true;
      },
    });
  // Whether agents or reviews run on the harness, and so need its login.
  const agents = harness ?? "claude";
  const uses = (name: HarnessName) => agents === name || (reviewerSaved() ?? agents) === name;
  if (uses("claude") && !existsSync(claudeTokenFile()))
    steps.push({
      title: harness === "codex" ? "log the reviewer in to Claude" : "log agents in to Claude",
      about: "Claude Code will print a long-lived token. Copy it, then come back here.",
      take: () => saveClaudeToken(env),
    });
  // Every Codex agent and review shares skel's own Codex login.
  const onCodex = harness === "codex" ? "agents" : "the reviewer";
  if (uses("codex") && !codexLoggedIn(env))
    steps.push({
      title: `log ${onCodex} in to Codex`,
      about: "Codex will show a link and a code. Open the link on any device and enter the code.",
      take: () => logInCodex(env, onCodex),
    });
  return steps;
}
