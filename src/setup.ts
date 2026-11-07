// The first run: what a plain skel sets up on a new machine, skipping each step already
// done.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { configFile, readConfig } from "./config.ts";
import { claudeTokenFile, codexHome, configDir } from "./paths.ts";
import { rule, skelLine } from "./say.ts";
import { promptSecret } from "./secret.ts";
import { installService, loginPath, serviceFile } from "./service.ts";
import { dropCapabilities, onSprite, spriteServiceInstalled } from "./sprite.ts";

type Env = Record<string, string | undefined>;

const claude = { command: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" };
const tools = [
  { command: "tmux", install: "sudo apt install tmux" },
  { command: "bwrap", install: "sudo apt install bubblewrap" },
  { command: "gh", install: "sudo apt install gh" },
  claude,
];
// On a Mac the sandbox comes with the system, and what Homebrew gives goes in one line.
const brewed = ["tmux", "gh"];
const macTools = [
  { command: "sandbox-exec", install: "it comes with macOS, and skel can't run agents without it" },
  claude,
];

// Checks the programs a Mac needs and tries sandbox-exec, stopping setup with what to install
// on failure. Homebrew's tools are named in one line that can be pasted as it is.
function checkMacTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const brew = brewed.filter((command) => !Bun.which(command, { PATH }));
  const missing = macTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
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
  if (missing.length > 0 || !bwrap) {
    const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
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

// Returns the reviewer's Codex settings: a login of skel's own, apart from yours in
// ~/.codex, so a renewal on either side never breaks the other.
const reviewerEnv = (env: Env): Env => ({ ...env, CODEX_HOME: codexHome() });

// Reports whether the reviewer has a Codex login in skel's folder. Reviews can change only
// the login and session files in this folder, so running codex on it with your rights runs
// nothing a reviewer left there. codex login status reads only the saved login: a key in
// your environment doesn't count.
function reviewerLoggedIn(env: Env): boolean {
  const status = ["codex", "login", "status"];
  return Bun.spawnSync(status, { env: reviewerEnv(env), stdout: "pipe", stderr: "pipe" }).success;
}

// Logs the reviewer in to Codex in skel's own folder, with a code you enter on any device,
// since the machine may have no browser. Then says so, to mark where Codex's output ends.
function loginReviewer(env: Env): void {
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  if (!handOver("Codex", ["codex", "login", "--device-auth"], reviewerEnv(env)))
    throw new Error("codex login didn't finish, so reviews have no login");
  console.log(skelLine("the reviewer is logged in to Codex."));
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

// Asks for your harness choice and saves it.
function pickHarness(): void {
  const { config } = readConfig();
  console.log("  1) Claude Code");
  // Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a
  // default: then Enter gives the default and only Ctrl-D gives null.
  const answer = prompt(skelLine("pick one by its number"), "1");
  if (answer === null) throw new Error("no harness was picked, so none is saved");
  if (answer.trim() !== "1") throw new Error("Claude Code is the only harness for now");
  config.set("harness", "claude");
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
}

// Reports whether saved settings, token and service show that setup finished, avoiding
// repeated login checks. Setup saves the service last, after the reviewer login, so these
// files show every step ran. Missing tools or logins fail where used; checking each attach
// would require a GitHub call.
export function setupDone(): boolean {
  const service = onSprite() ? spriteServiceInstalled() : existsSync(serviceFile());
  return Boolean(readConfig().harness) && existsSync(claudeTokenFile()) && service;
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
    const steps = stepsToTake(env);
    for (const [at, step] of steps.entries()) {
      console.log(`\n${skelLine(`step ${at + 1} of ${steps.length}: ${step.title}`)}`);
      console.log(`  ${step.about}`);
      step.take();
    }
    if (!Bun.which("codex", { PATH: env.PATH }))
      console.log(
        skelLine(
          "Codex isn't installed, so reviews will run on Claude Code, on the builder's own model, and lose the second view.",
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
// runs this time.
function stepsToTake(env: Env): Step[] {
  const steps: Step[] = [];
  if (!githubConnected(env))
    steps.push({
      title: "connect to GitHub",
      about: "gh will log you in. skel uses this login for everything it does on GitHub.",
      take: () => connectGitHub(env),
    });
  if (!readConfig().harness)
    steps.push({
      title: "pick a harness",
      about:
        "The harness is the coding agent that does the work. Claude Code is the only one for now.",
      take: pickHarness,
    });
  if (!existsSync(claudeTokenFile()))
    steps.push({
      title: "log agents in to Claude",
      about: "Claude Code will print a long-lived token. Copy it, then come back here.",
      take: () => saveClaudeToken(env),
    });
  if (Bun.which("codex", { PATH: env.PATH ?? "" }) && !reviewerLoggedIn(env))
    steps.push({
      title: "log the reviewer in to Codex",
      about: "Codex will show a link and a code. Open the link on any device and enter the code.",
      take: () => loginReviewer(env),
    });
  return steps;
}
