// The first run: what a plain skel sets up on a new machine, skipping each step already done.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { openDb } from "./db.ts";
import { configDir } from "./paths.ts";

const tools = [
  { command: "tmux", install: "sudo apt install tmux" },
  { command: "bwrap", install: "sudo apt install bubblewrap" },
  { command: "gh", install: "sudo apt install gh" },
  { command: "claude", install: "curl -fsSL https://claude.ai/install.sh | bash" },
];

// Unknown keys pass through, so settings this version doesn't know survive a save.
const Config = z.looseObject({ harness: z.enum(["claude"]).optional() });

const ClaudeLogin = z.object({ loggedIn: z.boolean() });

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

// Ubuntu's own profile for /usr/bin/bwrap lets bwrap make namespaces while keeping what it
// runs confined. A profile replacing it would let anything use bwrap to get around the
// restriction, so ours gets a name of its own and covers only a bwrap elsewhere. AppArmor
// matches the file a link points to, hence the resolved path.
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

// Logged out, it can print other JSON or none at all, and either way means no login.
function claudeLoggedIn(): boolean {
  const status = Bun.spawnSync(["claude", "auth", "status", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    return ClaudeLogin.parse(JSON.parse(status.stdout.toString())).loggedIn;
  } catch {
    return false;
  }
}

function connectGitHub(): void {
  if (Bun.spawnSync(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" }).success) return;
  const login = Bun.spawnSync(["gh", "auth", "login"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!login.success) throw new Error("gh auth login didn't finish, so skel can't reach GitHub");
}

function pickHarness(): void {
  const file = join(configDir(), "config.yaml");
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const [broken] = config.errors;
  if (broken) throw new Error(`${file} isn't valid YAML: ${broken.message}`);
  const read = Config.safeParse(config.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  if (read.data.harness) return;
  console.log("Harnesses:\n  1) Claude Code");
  const answer = prompt("Pick a harness [1]:")?.trim();
  if (answer !== "" && answer !== "1") throw new Error("Claude Code is the only harness for now");
  if (!claudeLoggedIn())
    throw new Error("Claude Code isn't logged in: run claude to log in, then run skel again");
  config.set("harness", "claude");
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(file, config.toString());
}

export function firstRun(): void {
  checkTools();
  connectGitHub();
  pickHarness();
  if (!openDb().query("SELECT 1 FROM repositories LIMIT 1").get())
    console.log("No repository is added yet. Add one by running skel init in its folder.");
  console.log("Setup is done.");
}
