// The first run: what a plain skel sets up on a new machine, skipping each step already
// done.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { codexHome, configDir } from "./paths.ts";

const tools = [
  { command: "tmux", install: "sudo apt install tmux" },
  { command: "bwrap", install: "sudo apt install bubblewrap" },
  { command: "gh", install: "sudo apt install gh" },
  { command: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
];

// Unknown keys pass through, so settings this version doesn't know survive a save.
const Config = z.looseObject({ harness: z.enum(["claude"]).optional() });

// Checks required programs and tries bubblewrap, stopping setup with installation or
// sandbox advice on failure.
function checkTools(): void {
  const bwrap = Bun.which("bwrap");
  const missing = tools.filter((tool) => !Bun.which(tool.command));
  if (missing.length > 0 || !bwrap) {
    const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
    throw new Error(`skel needs these installed first:\n${lines.join("\n")}`);
  }
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

// Asks for a secret without echoing terminal input, restoring echo even if the prompt
// fails. Your typing at a terminal shows on screen, and a token on screen can end up in a
// scrollback or a screenshot. Piped input has no echo to hide.
function promptHidden(question: string): string | null {
  if (!process.stdin.isTTY) return prompt(question);
  const stdio: ["inherit", "inherit", "inherit"] = ["inherit", "inherit", "inherit"];
  Bun.spawnSync(["stty", "-echo"], { stdio });
  try {
    return prompt(question);
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdio });
    console.log();
  }
}

// Saves a pasted Claude Code agent token privately, skipping it when one is already saved.
// Agents log in with a token from claude setup-token, which never renews, so they never
// race your own Claude Code for a refresh.
function saveClaudeToken(): void {
  const file = tokenFile();
  if (existsSync(file)) return;
  const setup = Bun.spawnSync(["claude", "setup-token"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!setup.success) throw new Error("claude setup-token didn't finish, so no token is saved");
  const token = promptHidden("Paste the token it printed (it won't show):")?.trim();
  if (!token) throw new Error("no token was pasted, so none is saved");
  // Claude Code itself tells its login tokens apart by this prefix. It reports any token as
  // logged in without asking the server, so the form is all skel can check here.
  if (!token.startsWith("sk-ant-oat") || /\s/.test(token))
    throw new Error(
      "that isn't a token from claude setup-token, which is one word starting with sk-ant-oat, so it isn't saved",
    );
  mkdirSync(configDir(), { recursive: true });
  // Created readable only by you, so the token is never in a file others can read.
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
}

// Logs the reviewer into skel's Codex folder if needed, or explains the Claude Code
// fallback. A login of skel's own, apart from yours in ~/.codex, so a renewal on either
// side never breaks the other.
function loginReviewer(): void {
  if (!Bun.which("codex")) {
    console.log(
      "Codex isn't installed, so reviews will run on Claude Code, on the builder's own model, and lose the second view.",
    );
    return;
  }
  // Reviews can change only the login and session files in this folder, so running codex on
  // it with your rights runs nothing a reviewer left there. codex login status reads only
  // the saved login: a key in your environment doesn't count.
  const env = { ...process.env, CODEX_HOME: codexHome() };
  if (Bun.spawnSync(["codex", "login", "status"], { env, stdout: "pipe", stderr: "pipe" }).success)
    return;
  mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  const login = Bun.spawnSync(["codex", "login", "--device-auth"], {
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!login.success) throw new Error("codex login didn't finish, so reviews have no login");
}

// Starts GitHub login when needed so the daemon can clone repositories and manage issues
// and PRs.
function connectGitHub(): void {
  if (Bun.spawnSync(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" }).success) return;
  const login = Bun.spawnSync(["gh", "auth", "login"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!login.success) throw new Error("gh auth login didn't finish, so skel can't reach GitHub");
}

// Returns the settings file path used to remember your harness choice between runs.
const configFile = () => join(configDir(), "config.yaml");
// Returns the private agent token file path used by setup and Claude Code sessions.
const tokenFile = () => join(configDir(), "claude-token");

// Reads and validates settings, returning the YAML document and harness choice while
// preserving unknown settings.
function readConfig() {
  const file = configFile();
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = config.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  const read = Config.safeParse(config.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  return { config, harness: read.data.harness };
}

// Asks for and saves your harness choice unless one is already configured.
function pickHarness(): void {
  const { config, harness } = readConfig();
  if (harness) return;
  console.log("Harnesses:\n  1) Claude Code");
  // Bun's prompt answers null both for Ctrl-D and for a bare Enter, unless it has a
  // default: then Enter gives the default and only Ctrl-D gives null.
  const answer = prompt("Pick a harness", "1");
  if (answer === null) throw new Error("no harness was picked, so none is saved");
  if (answer.trim() !== "1") throw new Error("Claude Code is the only harness for now");
  config.set("harness", "claude");
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), config.toString());
}

// Returns the systemd user service path, which also marks daemon installation complete.
const unitFile = () => join(homedir(), ".config", "systemd", "user", "skel.service");

// Runs a service installation command in your terminal and stops setup if it fails.
function systemd(command: string[]): void {
  const run = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
  if (!run.success) throw new Error(`${command.join(" ")} failed, so the daemon isn't installed`);
}

// Returns a value safe for the daemon's unit file, rejecting quotes and backslashes and
// escaping percent signs. systemd reads " and \ in a unit as quoting, and % as the start of
// a name it fills in.
function unitValue(value: string): string {
  if (/["\\]/.test(value)) throw new Error(`systemd can't be given ${value}, which holds " or \\`);
  return value.replaceAll("%", "%%");
}

// Returns the daemon's service definition with a lasting tool PATH and sessions that
// survive daemon stops.
function unitText(skel: string): string {
  // systemd starts services with a bare PATH, which misses bun, claude and gh where they
  // usually live, so the daemon gets yours. Folders a tool runner or a temporary folder
  // added are left out: they are gone by the time the daemon starts.
  const temporary = tmpdir();
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => p && !p.includes("/node_modules/.bin") && !p.startsWith(`${temporary}/`))
    .map(unitValue)
    .join(":");
  // Where tmux couldn't get a scope of its own, stopping the service would otherwise end
  // the tmux server, and every agent with it.
  return `[Unit]
Description=skel daemon

[Service]
ExecStart="${unitValue(skel)}" serve
Environment="PATH=${path}"
Restart=on-failure
KillMode=process

[Install]
WantedBy=default.target
`;
}

// Installs or updates the daemon service, enabling it and lingering on the first
// installation. Checked on every plain skel, but only by comparing files, so a moved bun,
// claude or checkout reaches the daemon at its next start without a systemctl call each
// time.
function installService(): void {
  const file = unitFile();
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  // skel built as one file runs its modules from a folder only it sees, so the service runs
  // the file itself.
  const single = import.meta.dir.startsWith("/$bunfs");
  const checkout = resolve(import.meta.dir, "..");
  const skel = single ? process.execPath : join(checkout, "bin", "skel");
  // A worktree goes away once its work merges, and the daemon with it. Its .git is a file
  // pointing back at the repository, wherever the worktree lives.
  if (!single && statSync(join(checkout, ".git"), { throwIfNoEntry: false })?.isFile()) {
    if (before !== null) return;
    throw new Error(
      `skel is running from a worktree (${skel}): run skel from the main checkout to install its daemon`,
    );
  }
  const unit = unitText(skel);
  if (before === unit) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, unit);
  try {
    systemd(["systemctl", "--user", "daemon-reload"]);
    if (before !== null) return;
    systemd(["systemctl", "--user", "enable", "--now", "skel"]);
    console.log(
      "Turning on lingering, so the daemon keeps running after you log out and starts after a reboot.",
    );
    systemd(["loginctl", "enable-linger"]);
  } catch (error) {
    // The unit file marks the service installed, so the old one comes back, or none, and
    // the next skel tries again.
    if (before === null) rmSync(file);
    else writeFileSync(file, before);
    throw error;
  }
}

// Reports whether saved settings, token and service show that setup finished, avoiding
// repeated login checks. Setup saves the service last, after the reviewer login, so these
// files show every step ran. Missing tools or logins fail where used; checking each attach
// would require a GitHub call.
export function setupDone(): boolean {
  return Boolean(readConfig().harness) && existsSync(tokenFile()) && existsSync(unitFile());
}

// Completes unfinished machine setup and keeps the daemon service current before attaching
// to the lead.
export function firstRun(): void {
  const done = setupDone();
  if (!done) {
    checkTools();
    connectGitHub();
    pickHarness();
    saveClaudeToken();
    loginReviewer();
  }
  installService();
  if (!done) console.log("Setup is done.");
}
