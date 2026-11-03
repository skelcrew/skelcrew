// The first run: what a plain skel sets up on a new machine, skipping each step already done.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { openDb } from "./db.ts";
import { configDir } from "./paths.ts";
import { addRepo } from "./repo.ts";

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
  const missing = tools.filter((tool) => !Bun.which(tool.command));
  if (missing.length > 0) {
    const lines = missing.map((tool) => `  ${tool.command}: ${tool.install}`);
    throw new Error(`skel needs these installed first:\n${lines.join("\n")}`);
  }
  // Being installed isn't being allowed: on Ubuntu 24.04 and later, AppArmor stops bwrap
  // making the namespaces it needs, and every agent would fail to start.
  const bwrap = Bun.which("bwrap") ?? "bwrap";
  const tried = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "true"], { stderr: "pipe" });
  if (!tried.success) {
    const said = tried.stderr.toString().trim();
    throw new Error(
      `bwrap can't start a sandbox here: ${said}
On Ubuntu 24.04 and later, AppArmor blocks it unless a profile allows it. This adds one:
  printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap ${bwrap} flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/bwrap
  sudo apparmor_parser -r /etc/apparmor.d/bwrap`,
    );
  }
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

function addFirstRepository(): void {
  if (openDb().query("SELECT 1 FROM repositories LIMIT 1").get()) return;
  const given = prompt("Path to your first repository:")?.trim();
  if (!given) throw new Error("skel needs a repository to work in");
  // A path typed at a prompt doesn't pass through the shell, which would expand ~.
  addRepo(given.replace(/^~(?=\/|$)/, homedir()));
}

function pickHarness(): void {
  const file = join(configDir(), "config.yaml");
  const config = parseDocument(existsSync(file) ? readFileSync(file, "utf8") : "");
  const read = Config.safeParse(config.toJS() ?? {});
  if (!read.success) throw new Error(`${file} isn't valid: ${z.prettifyError(read.error)}`);
  if (read.data.harness) return;
  console.log("Harnesses:\n  1) Claude Code");
  const answer = prompt("Pick a harness [1]:")?.trim() ?? "";
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
  addFirstRepository();
  pickHarness();
  console.log("Setup is done.");
}
