// Machine tools and agent logins for plain sc. Harness choices belong to sc init;
// the daemon never calls these terminal prompts.
import { existsSync, mkdirSync, realpathSync, writeFileSync, writeSync } from "node:fs";
import { z } from "zod";
import { codexHome } from "../agents/codex.ts";
import { type HarnessName, harnessNamed } from "../agents/harness.ts";
import { hasAgentLogin, loginInstruction } from "../agents/login.ts";
import { piHome } from "../agents/pi-login.ts";
import { approvedAgents } from "../approved-agents.ts";
import { agentRole } from "../config.ts";
import { openDb } from "../db.ts";
import { toRun } from "../format.ts";
import { claudeTokenFile, configDir, dataDir, setUpFile } from "../paths.ts";
import { promptSecret } from "./secret.ts";
import { loginPath, serviceFile } from "./service.ts";

type Env = Record<string, string | undefined>;

const linuxTools = [
  { command: "tmux", package: "tmux" },
  { command: "bwrap", package: "bubblewrap" },
  { command: "git", package: "git" },
];
const brewTools = ["tmux", "git"];
const macTools = [
  {
    command: "sandbox-exec",
    install: "it comes with macOS, and Skelcrew can't run agents without it",
  },
];

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

function checkMacTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const brew = brewTools.filter((command) => !Bun.which(command, { PATH }));
  const missing = macTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const before = missing.map((tool) => `${tool.command}: ${tool.install}`);
  if (brew.length > 0 && !Bun.which("brew", { PATH }))
    before.push("Homebrew, for the line below, from https://brew.sh");
  const tools = brew.length > 0 ? [`brew install ${brew.join(" ")}`] : [];
  stopForTools(before, tools, []);
  const tried = Bun.spawnSync(["sandbox-exec", "-p", "(version 1)(allow default)", "true"], {
    env,
    stderr: "pipe",
  });
  if (!tried.success)
    throw new Error(`sandbox-exec can't start a sandbox here: ${tried.stderr.toString().trim()}`);
}

function checkLinuxTools(env: Env): void {
  const PATH = env.PATH ?? "";
  const bwrap = Bun.which("bwrap", { PATH });
  const missing = linuxTools.filter((tool) => !Bun.which(tool.command, { PATH }));
  const apt = missing.map((tool) => tool.package);
  stopForTools([], apt.length > 0 ? [`sudo apt install ${apt.join(" ")}`] : [], []);
  if (!bwrap) return;
  const answer = Bun.spawnSync([bwrap, "--version"], { stderr: "pipe" }).stdout.toString();
  const version = answer.match(/(\d+)\.(\d+)(\.\d+)?/);
  if (version && Number(version[1]) === 0 && Number(version[2]) < 11)
    throw new Error(
      `bwrap is ${version[0]} here, and Skelcrew needs 0.11 or newer for its reviews. Ubuntu 26.04 has it.`,
    );
  const tried = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "true"], { stderr: "pipe" });
  if (!tried.success) {
    const said = tried.stderr.toString().trim();
    throw new Error(
      `bwrap can't start a sandbox here: ${said}\n${apparmorAdvice(realpathSync(bwrap))}`,
    );
  }
}

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
  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile skelcrew-bwrap ${bwrap} flags=(unconfined) {\\n  userns,\\n  include if exists <local/skelcrew-bwrap>\\n}\\n' | sudo tee /etc/apparmor.d/skelcrew-bwrap
  sudo apparmor_parser -r /etc/apparmor.d/skelcrew-bwrap`;
}

function tokenProblem(token: string): string | null {
  if (token === "") return "Nothing was pasted";
  if (/\s/.test(token)) return "That has spaces in it, and a token is one word";
  if (!token.startsWith("sk-ant-oat"))
    return "That doesn't start with sk-ant-oat, so it isn't a token from claude setup-token";
  return null;
}

function saveClaudeToken(): void {
  let question = "Token:";
  while (true) {
    const answer = promptSecret(question);
    if (answer === null) throw new Error("no token was pasted, so none is saved");
    const token = answer.trim();
    const problem = tokenProblem(token);
    if (problem === null) {
      mkdirSync(configDir(), { recursive: true });
      writeFileSync(claudeTokenFile(), `${token}\n`, { mode: 0o600, flag: "wx" });
      return;
    }
    question = `${problem}. Paste it again:`;
  }
}

const codexEnv = (env: Env): Env => ({ ...env, CODEX_HOME: codexHome() });

function logInCodex(env: Env, line: string): void {
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  if (process.stdin.isTTY) promptSecret(line);
  else console.log(line);
  const screen = process.stdout.isTTY && process.env.TERM !== "dumb";
  if (screen) writeSync(1, "\x1b[?1049h\x1b[H");
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
    if (screen && !ran && process.stdin.isTTY)
      promptSecret("\nCodex's sign-in didn't finish. Press Enter to go back.");
    if (screen) writeSync(1, "\x1b[?1049l");
  }
  if (!ran) throw new Error("codex login didn't finish, so Codex has no login for Skelcrew");
  writeSync(1, "Signed in to Codex.\n");
}

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

export function prepareMachine(): void {
  const env = { ...process.env, PATH: loginPath() };
  process.env.PATH = env.PATH;
  if (!existsSync(setUpFile()) && !existsSync(serviceFile())) {
    if (process.platform === "darwin") checkMacTools(env);
    else checkLinuxTools(env);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(setUpFile(), "");
  }
}

function signIn(harness: HarnessName): void {
  if (hasAgentLogin(harness)) return;
  const env = { ...process.env, PATH: loginPath() };
  const agent = harnessNamed(harness);
  if (!Bun.which(agent.program, { PATH: env.PATH })) stopForTools([], [], [agent.install]);
  if (harness === "claude") {
    console.log(`Sign in to Claude. In another terminal, run:\n${toRun(["claude setup-token"])}`);
    console.log("Then paste the token here.");
    saveClaudeToken();
  } else if (harness === "codex") logInCodex(env, "Sign in to Codex. Press Enter to start.");
  else logInPi(env, "Sign in to Pi for the agent that needs it.");
  if (!hasAgentLogin(harness))
    throw new Error(`${agent.title} has no login: ${loginInstruction(harness)}`);
}

export function signInForAgents(opened?: string): void {
  const db = openDb();
  const places = z
    .array(
      z.object({
        owner: z.string(),
        repo: z.string(),
        lead_harness: z.enum(["claude", "codex", "pi"]).nullable(),
      }),
    )
    .parse(
      db
        .query(
          "SELECT owner, repo, lead_harness FROM repositories ORDER BY tab_closed, opened DESC, name",
        )
        .all(),
    );
  const place = opened ? places.find((r) => `${r.owner}/${r.repo}` === opened) : places[0];
  if (place)
    signIn(
      place.lead_harness ?? agentRole("lead", { ...place, agents: approvedAgents(place) }).harness,
    );
  const pending = z
    .array(z.object({ needs_you_for: z.string() }))
    .parse(
      db
        .query(
          "SELECT needs_you_for FROM threads WHERE needs_you_for LIKE 'run sc: sign in to %' AND status NOT IN ('done', 'stopped')",
        )
        .all(),
    );
  for (const { needs_you_for } of pending) {
    const harness = z
      .enum(["claude", "codex", "pi"])
      .parse(needs_you_for.slice("run sc: sign in to ".length));
    signIn(harness);
  }
}
