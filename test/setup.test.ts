// The first plain sc on a machine, run as you would run it, against fake tools.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { git } from "./harness.ts";

let home = "";
let bin = "";
let checkout = "";
let daemon: Server | undefined;
const main = () => join(checkout, "src", "main.ts");

// A copy of Skelcrew to run, since the service refuses to point into a worktree, where tests
// usually run.
function copySkel(to: string): void {
  const from = join(import.meta.dir, "..");
  mkdirSync(to, { recursive: true });
  for (const part of ["bin", "src", "package.json"])
    cpSync(join(from, part), join(to, part), { recursive: true });
  symlinkSync(join(from, "node_modules"), join(to, "node_modules"));
}

// Stands in for Skelcrew's daemon on its socket. Like the real one, it answers only once
// systemd has started it.
function fakeDaemon(): Promise<Server> {
  const server = createServer((connection) =>
    connection.on("data", (data) => {
      if (!existsSync(join(home, "started"))) return connection.destroy();
      const request = JSON.parse(data.toString());
      const asked = String(request.command);
      // Skelcrew asks which commit the daemon runs before every attach, which update.test.ts
      // covers.
      if (asked !== "status") appendFileSync(join(home, "calls"), `daemon ${asked}\n`);
      const lead = '{"lead":"lead","repository":"simon/app"}\n';
      connection.end(asked === "lead" ? lead : '{"running":true,"pid":1}\n');
    }),
  );
  return new Promise((listening) =>
    server.listen(join(home, "run", "skelcrew.sock"), () => listening(server)),
  );
}

// Each fake writes its calls to a log, so a test can see what Skelcrew ran.
function fake(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`, {
    mode: 0o755,
  });
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-setup-test-")));
  checkout = join(home, "skel");
  copySkel(checkout);
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "run"), { mode: 0o700 });
  // PATH holds only this folder, so a test can take a tool away.
  symlinkSync(Bun.which("git") ?? "git", join(bin, "git"));
  fake("tmux", "exit 0");
  fake("bwrap", "exit 0");
  fake("claude", `test "$1" = setup-token && echo 'Your token: sk-ant-oat01-good'`);
  fake(
    "systemctl",
    `case "$*" in
  "--user start skelcrew"|"--user enable --now skelcrew") : > "$HOME/started" ;;
esac`,
  );
  fake("loginctl", "exit 0");
  // Skelcrew has a repository, so plain Skelcrew has a lead to open once set up. The GitHub plugin
  // is installed, so the first run doesn't offer it, unless a test removes it.
  const db = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo) VALUES ('app', 'simon', 'app')");
db.run("INSERT INTO plugins (name, folder) VALUES ('github', '/nowhere')");`;
  const added = Bun.spawnSync([process.execPath, "-e", db], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  daemon = await fakeDaemon();
});
afterEach(() => {
  daemon?.close();
  rmSync(home, { recursive: true, force: true });
});

function calls(): string {
  const log = join(home, "calls");
  // The long tmux line that opens the screen is cut to the agent it opens on.
  const said = existsSync(log) ? readFileSync(log, "utf8") : "";
  return said
    .replace(/tmux -L skelcrew -f \/dev\/null source-file -\n/g, "")
    .replace(/tmux -L skelcrew-screen .* sh skelcrew (\S+) \S+ ;.*/g, "screen on $1");
}

const config = () => join(home, ".config", "skelcrew", "config.yaml");
const token = () => join(home, ".config", "skelcrew", "claude-token");
const unit = () => join(home, ".config", "systemd", "user", "skelcrew.service");

async function skel(
  typed = "",
  path = bin,
  program = main(),
  cwd = home,
  more: Record<string, string> = {},
  args: string[] = [],
) {
  const run = Bun.spawn([process.execPath, program, ...args], {
    cwd,
    env: {
      PATH: path,
      HOME: home,
      XDG_RUNTIME_DIR: join(home, "run"),
      TMPDIR: join(home, "tmp"),
      ...more,
    },
    stdin: new Blob([typed]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { out, err, code };
}

test("takes every step on the first run, and none on the second", async () => {
  const first = await skel("1\nsk-ant-oat01-good\n");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(first.out).toContain("Claude Code");
  // Skelcrew marks where it speaks again, so its lines stand apart from what claude prints, and
  // numbers only the steps it takes.
  const said = [
    "Skelcrew · step 1 of 2: pick a harness\n",
    "Skelcrew · step 2 of 2: log agents in to Claude\n",
    `──── Claude Code ${"─".repeat(63)}\n`,
    "Your token: sk-ant-oat01-good\n",
    `──── back in Skelcrew ${"─".repeat(58)}\n`,
    "Skelcrew · paste the token Claude printed above (it starts with sk-ant-oat01-):",
    "Skelcrew · setup is done.\n",
  ];
  // Each line comes after the one before, so a rule found is the one for its own step.
  let at = 0;
  for (const line of said) {
    at = first.out.indexOf(line, at);
    expect([line, at]).not.toEqual([line, -1]);
  }
  // Only a terminal waits for Enter before each login.
  expect(first.out).not.toContain("press Enter");
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
  expect(calls()).toContain("claude setup-token");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  expect(statSync(token()).mode & 0o777).toBe(0o600);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.err).toBe("");
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("Claude Code");
  expect(second.out).not.toContain("setup is done");
  // Once set up, Skelcrew checks no tools, asks nothing and leaves systemd alone, so it
  // starts fast.
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("installs the daemon as a systemd user service with lingering, once", async () => {
  const first = await skel("1\nsk-ant-oat01-good\n");
  expect(first.code).toBe(0);
  const skelBin = join(checkout, "bin", "sc");
  const written = readFileSync(unit(), "utf8");
  expect(written).toContain(`ExecStart="${skelBin}" serve`);
  expect(written).toContain("Restart=on-failure");
  // systemd would otherwise end the tmux server, and every agent, with the daemon.
  expect(written).toContain("KillMode=process");
  expect(written).toContain(`Environment="PATH=${bin}"`);
  expect(calls()).toContain(
    "systemctl --user daemon-reload\nsystemctl --user enable --now skelcrew\nloginctl enable-linger\n",
  );
  expect(first.out).toContain("log out");

  writeFileSync(join(home, "calls"), "");
  await skel();
  expect(calls()).not.toContain("systemctl --user enable");
  expect(calls()).not.toContain("loginctl");
});

// Skelcrew takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite. Like
// the real one, it starts a service as it creates it.
function onSprite(): void {
  fake(
    "sprite-env",
    `case "$*" in
  "services get skelcrew") test -f "$HOME/service" ;;
  "services create skelcrew "*) : > "$HOME/service"; : > "$HOME/started" ;;
  "services start skelcrew") : > "$HOME/started" ;;
esac`,
  );
  fake("setpriv", 'while case "$1" in --*) true ;; *) false ;; esac; do shift; done; exec "$@"');
}

test("on a Sprite, installs the daemon as a Sprite service, not with systemd", async () => {
  onSprite();
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  // bwrap refuses to start on a Sprite with the capabilities its commands get.
  expect(calls()).toContain(
    `setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all ${bin}/bwrap --ro-bind / / true\n`,
  );
  expect(calls()).toContain(
    `sprite-env services create skelcrew --cmd ${join(checkout, "bin", "sc")} --args serve --no-stream\n`,
  );
  expect(calls()).not.toContain("systemctl");
  expect(calls()).not.toContain("loginctl");
  expect(existsSync(unit())).toBe(false);
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");

  writeFileSync(join(home, "calls"), "");
  rmSync(join(home, "started"));
  const again = await skel();
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("setup is done");
  expect(calls()).not.toContain("services create");
  expect(calls()).toContain("sprite-env services start skelcrew\ndaemon lead\n");
});

test("installs the service on a machine set up before Skelcrew had one", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(existsSync(unit())).toBe(true);
  expect(calls()).toContain("systemctl --user enable --now skelcrew");
  expect(calls()).not.toContain("claude setup-token");
});

test("installs no service when systemctl fails, so the next sc tries again", async () => {
  fake("systemctl", "exit 1");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("systemctl");
  expect(existsSync(unit())).toBe(false);
});

test("starts the daemon through systemd when it doesn't answer, then attaches to the lead", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(calls()).toBe("systemctl --user start skelcrew\ndaemon lead\nscreen on lead\n");
});

// The daemon watches the builder you attach to, so attaching to a thread brings it up too.
test("sc attach starts the daemon through systemd when it doesn't answer", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  const db = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("INSERT INTO threads (owner, repo, task, folder, branch, status) VALUES ('simon', 'app', 12, 'app-12', 'skelcrew/12', 'working')");`;
  Bun.spawnSync([process.execPath, "-e", db], { env: { HOME: home } });
  writeFileSync(join(home, "calls"), "");
  const run = Bun.spawn([process.execPath, main(), "attach", "app-12"], {
    env: { PATH: bin, HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(run.stderr).text();
  expect(err).toBe("");
  expect(await run.exited).toBe(0);
  expect(calls()).toContain("systemctl --user start skelcrew\n");
  expect(calls()).toContain("screen on app-12\n");
});

test("shows why when the daemon can't start the lead", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  daemon?.close();
  daemon = createServer((connection) =>
    connection.on("data", () => connection.end('{"error":"the lead exited: no login"}\n')),
  );
  await new Promise<void>((listening) =>
    daemon?.listen(join(home, "run", "skelcrew.sock"), listening),
  );
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("no login");
  expect(calls()).not.toContain("attach");
});

test("rewrites the service when the PATH it needs moved, without restarting anything", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  const run = await skel("", `${bin}:/opt/bun/bin`);
  expect(run.code).toBe(0);
  expect(readFileSync(unit(), "utf8")).toContain(`Environment="PATH=${bin}:/opt/bun/bin"`);
  expect(calls()).toBe("systemctl --user daemon-reload\ndaemon lead\nscreen on lead\n");
});

test("leaves out PATH folders that won't last, and escapes % for systemd", async () => {
  const path = `${bin}:/code/app/node_modules/.bin:${join(home, "tmp", "bunx-1")}:/opt/50%`;
  const run = await skel("1\nsk-ant-oat01-good\n", path);
  expect(run.code).toBe(0);
  expect(readFileSync(unit(), "utf8")).toContain(`Environment="PATH=${bin}:/opt/50%%"`);
});

test("refuses a PATH that systemd would read differently", async () => {
  const run = await skel("1\nsk-ant-oat01-good\n", `${bin}:/opt/a"b`);
  expect(run.code).toBe(1);
  expect(run.err).toContain('/opt/a"b');
  expect(existsSync(unit())).toBe(false);
});

// A git worktree has a .git file pointing back at its repository, where a checkout has a folder.
test("refuses to install a service that runs sc from a worktree", async () => {
  const worktree = join(home, "code", "skel", ".claude", "worktrees", "12");
  copySkel(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/12\n");
  const run = await skel("1\nsk-ant-oat01-good\n", bin, join(worktree, "src", "main.ts"));
  expect(run.code).toBe(1);
  expect(run.err).toContain("main checkout");
  expect(existsSync(unit())).toBe(false);
});

// Runs sc as it runs on a Mac, with fake launchctl and sandbox-exec.
function skelOnMac(typed = "", path = bin) {
  const preload = join(import.meta.dir, "as-mac.ts");
  return skel(typed, path, main(), home, { BUN_OPTIONS: `--preload ${preload}` });
}

// Sets up the fakes a Mac has, and takes away what only Linux has.
function asMac(): void {
  rmSync(join(bin, "bwrap"));
  rmSync(join(bin, "systemctl"));
  rmSync(join(bin, "loginctl"));
  fake("sandbox-exec", "exit 0");
  fake(
    "launchctl",
    `case "$1" in
  bootstrap|kickstart) : > "$HOME/started" ;;
esac`,
  );
  fake("brew", "exit 0");
}

const plist = () => join(home, "Library", "LaunchAgents", "dev.skelcrew.daemon.plist");
const uid = userInfo().uid;

test("on a Mac, installs the daemon as a launchd agent, with no systemd", async () => {
  asMac();
  const first = await skelOnMac("1\nsk-ant-oat01-good\n");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(calls()).toContain(`launchctl bootstrap gui/${uid} ${plist()}\n`);
  const text = readFileSync(plist(), "utf8");
  expect(text).toContain("<string>dev.skelcrew.daemon</string>");
  expect(text).toContain(
    `<string>${join(checkout, "bin", "sc")}</string>\n    <string>serve</string>`,
  );
  expect(text).toContain("<key>AbandonProcessGroup</key>\n  <true/>");
  expect(text).toContain(`<string>${join(home, "Library", "Logs", "skelcrew.log")}</string>`);
  expect(calls()).toContain("daemon lead");
});

test("on a Mac, says once that work stops with the lid closed", async () => {
  asMac();
  const first = await skelOnMac("1\nsk-ant-oat01-good\n");
  const done = first.out.indexOf("setup is done");
  const note = first.out.indexOf("work stops while the lid is closed");
  expect(done).toBeGreaterThan(-1);
  expect(note).toBeGreaterThan(done);
  expect(first.out).toContain("sc remote add keeps it going");
  const second = await skelOnMac();
  expect(second.out).not.toContain("lid");
});

test("says nothing about a lid on Linux", async () => {
  const first = await skel("1\nsk-ant-oat01-good\n");
  expect(first.out).not.toContain("lid");
});

test("on a Mac, installs no agent when launchctl fails, so the next sc tries again", async () => {
  asMac();
  fake("launchctl", 'test "$1" = bootout && exit 3; echo "Load failed" >&2; exit 5');
  const run = await skelOnMac("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("Load failed");
  expect(existsSync(plist())).toBe(false);
});

test("on a Mac, starts the daemon through launchd when it doesn't answer", async () => {
  asMac();
  await skelOnMac("1\nsk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac();
  expect(run.err).toBe("");
  expect(calls()).toContain(`launchctl kickstart gui/${uid}/dev.skelcrew.daemon\n`);
});

test("on a Mac, reloads the agent when the PATH it needs moved", async () => {
  asMac();
  await skelOnMac("1\nsk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  await skelOnMac("", `${bin}:/usr/bin`);
  expect(readFileSync(plist(), "utf8")).toContain(`<string>${bin}:/usr/bin</string>`);
  expect(calls()).toContain(`launchctl bootout gui/${uid}/dev.skelcrew.daemon\n`);
  expect(calls()).toContain(`launchctl bootstrap gui/${uid} ${plist()}\n`);
});

test("on a Mac, escapes a PATH for the agent's definition", async () => {
  asMac();
  const odd = join(home, "a&b");
  mkdirSync(odd);
  await skelOnMac("1\nsk-ant-oat01-good\n", `${bin}:${odd}`);
  expect(readFileSync(plist(), "utf8")).toContain(`<string>${bin}:${home}/a&amp;b</string>`);
});

test("on a Mac, says exactly what to install with Homebrew, and runs nothing else", async () => {
  asMac();
  rmSync(join(bin, "tmux"));
  rmSync(join(bin, "claude"));
  const run = await skelOnMac();
  expect(run.code).toBe(1);
  expect(run.err).toContain("  brew install tmux\n");
  expect(run.err).toContain("claude: curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).not.toContain("bwrap");
  expect(run.err).not.toContain("apt");
  expect(run.err).not.toContain("brew.sh");
  expect(existsSync(join(home, "calls"))).toBe(false);
});

test("on a Mac without Homebrew, says where to get it", async () => {
  asMac();
  rmSync(join(bin, "brew"));
  rmSync(join(bin, "tmux"));
  const run = await skelOnMac();
  expect(run.err).toContain("https://brew.sh");
  expect(run.err).toContain("  brew install tmux\n");
});

test("on a Mac, stops when sandbox-exec can't start a sandbox", async () => {
  asMac();
  fake("sandbox-exec", 'echo "sandbox_apply: Operation not permitted" >&2; exit 71');
  const run = await skelOnMac();
  expect(run.code).toBe(1);
  expect(run.err).toContain("sandbox-exec can't start a sandbox here");
  expect(run.err).toContain("sandbox_apply: Operation not permitted");
  expect(calls()).not.toContain("claude");
});

// Removes the GitHub plugin from Skelcrew's database, so sc offers it.
function noGitHubPlugin(): void {
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("DELETE FROM plugins");`;
  const removed = Bun.spawnSync([process.execPath, "-e", code], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!removed.success) throw new Error(removed.stderr.toString());
}

// Has git reach the fake GitHub in home/github for every github.com remote, so no test reaches
// the real one.
function fakeGitHub(): void {
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/github/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`,
  );
}

// Returns a new checkout in home/code with the remote given, if any.
function checkoutWith(name: string, remote?: string): string {
  const folder = join(home, "code", name);
  mkdirSync(folder, { recursive: true });
  git(folder, "init", "-q", "-b", "main");
  if (remote) git(folder, "remote", "add", "origin", remote);
  return folder;
}

const offer = "Install the GitHub plugin? [Y/n]";

// The GitHub plugin is offered where you work on a GitHub repository, and only there, on any run
// until it is installed or you say no.
test("offers the GitHub plugin only in a checkout on github.com, on any run", async () => {
  noGitHubPlugin();
  fakeGitHub();
  const outside = await skel("1\nsk-ant-oat01-good\n");
  expect(outside.code).toBe(0);
  expect(outside.out).not.toContain("GitHub");
  const folder = checkoutWith("app");
  expect((await skel("", bin, main(), folder)).out).not.toContain("GitHub");
  git(folder, "remote", "add", "origin", "git@gitlab.com:simon/app.git");
  expect((await skel("", bin, main(), folder)).out).not.toContain("GitHub");
  git(folder, "remote", "set-url", "origin", "git@github.com:simon/app.git");
  const later = await skel("n\n", bin, main(), join(folder));
  expect(later.out).toStartWith(
    "GitHub detected.\n\nThe GitHub plugin lets Skelcrew work with issues, pull requests\nand CI on your repositories. Install the GitHub plugin? [Y/n]",
  );
});

test("a no holds for the repository, in every checkout of it, and another repository asks once", async () => {
  noGitHubPlugin();
  fakeGitHub();
  const app = checkoutWith("app", "git@github.com:simon/app.git");
  const first = await skel("n\n1\nsk-ant-oat01-good\n", bin, main(), app);
  expect(first.code).toBe(0);
  expect(first.out).toContain(offer);
  expect(first.out).toContain(
    "Skelcrew won't ask again for simon/app. To install it: sc plugin install skelcrew/skel-plugin-github",
  );
  // The offer comes before the first step.
  expect(first.out.indexOf(offer)).toBeLessThan(first.out.indexOf("pick a harness"));
  expect(parse(readFileSync(config(), "utf8"))).toMatchObject({
    harness: "claude",
    github_declined: ["simon/app"],
  });
  const again = checkoutWith("app-again", "https://github.com/Simon/app.git");
  expect((await skel("", bin, main(), again)).out).not.toContain("GitHub");
  expect((await skel("", bin, main(), app)).out).not.toContain("GitHub");
  const site = checkoutWith("site", "git@github.com:simon/site.git");
  const other = await skel("n\n", bin, main(), site);
  expect(other.out).toContain(offer);
  expect(parse(readFileSync(config(), "utf8")).github_declined).toEqual([
    "simon/app",
    "simon/site",
  ]);
  // Nothing is written into the repository.
  expect(git(app, "status", "--porcelain")).toBe("");
});

test("over --remote, the offer reads the remote sc brought from your laptop", async () => {
  noGitHubPlugin();
  fakeGitHub();
  await skel("1\nsk-ant-oat01-good\n");
  const run = await skel("n\n", bin, main(), home, {}, ["--from", "git@github.com:simon/app.git"]);
  expect(run.out).toContain(offer);
  expect(parse(readFileSync(config(), "utf8")).github_declined).toEqual(["simon/app"]);
});

// Puts a GitHub plugin on the fake GitHub as skelcrew/skel-plugin-github, a tracker and forge whose
// setup keeps the remote it was handed, and whose calls the fake plugin answers. It claims
// simon/site.
function publishGitHubPlugin(): void {
  const plugin = join(home, "github", "skelcrew", "skel-plugin-github");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    `name: github
version: 0.1.0
skelcrew: 0.1.0
about: GitHub
jobs: [tracker, forge]
setup: [bun, setup.ts]
call: [bun, ${JSON.stringify(join(import.meta.dir, "fake-plugin.ts"))}]
git_credentials: ["true"]
`,
  );
  writeFileSync(
    join(plugin, "setup.ts"),
    'await Bun.write(process.env.HOME + "/handed", process.env.SKELCREW_REMOTE + "\\n");\n',
  );
  git(plugin, "init", "-q", "-b", "main");
  git(plugin, "add", ".");
  git(plugin, "commit", "-q", "-m", "0.1.0");
  git(plugin, "tag", "v0.1.0");
  const answer = {
    key: "simon/site",
    name: "site",
    link: "https://github.com/simon/site",
    clone: "https://github.com/simon/site.git",
    push: true,
    fork: false,
  };
  const settings = join(home, ".config", "skelcrew", "plugins", "github");
  mkdirSync(settings, { recursive: true });
  writeFileSync(
    join(settings, "claims.json"),
    JSON.stringify({ "https://github.com/simon/site": answer, [answer.clone]: answer }),
  );
}

// Returns your checkout of simon/site, which is on the fake GitHub, with no GitHub plugin
// installed and the plugin published there.
function siteOnGitHub(): string {
  noGitHubPlugin();
  fakeGitHub();
  publishGitHubPlugin();
  const site = checkoutWith("site");
  writeFileSync(join(site, "README"), "site\n");
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", site, join(home, "github", "simon", "site.git"));
  git(site, "remote", "add", "origin", "https://github.com/simon/site");
  return site;
}

const initOffer =
  "Skelcrew · run sc init here, so GitHub's issues become this repository's tasks? [Y/n]";

// Enter takes the offer. You said yes to this plugin by name, so the install asks nothing more.
test("a yes installs the GitHub plugin with no second question, then offers sc init once set up", async () => {
  const site = siteOnGitHub();
  const run = await skel("\n1\nsk-ant-oat01-good\n\n", bin, main(), site);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "Installing github 0.1.0 from skelcrew/skel-plugin-github...\nInstalled github 0.1.0.\n",
  );
  expect(run.out).not.toContain("[y/N]");
  expect(readFileSync(join(home, "handed"), "utf8")).toBe("https://github.com/simon/site\n");
  expect(run.out.indexOf("Skelcrew · setup is done.")).toBeLessThan(run.out.indexOf(initOffer));
  expect(run.out).not.toContain("Which tracker");
  expect(readFileSync(join(site, "skelcrew.yaml"), "utf8")).toContain("\ntracker: github\n");
  expect(run.out).toContain("Added simon/site, as site.");
  expect(run.out).toContain("counts once you commit it and push it to the default branch");
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");
});

test("on a run after setup, a yes goes straight on to sc init", async () => {
  const site = siteOnGitHub();
  await skel("1\nsk-ant-oat01-good\n");
  const run = await skel("\n\n", bin, main(), site);
  expect(run.err).toBe("");
  expect(run.out).toStartWith("GitHub detected.");
  expect(run.out).toContain("Installed github 0.1.0.");
  expect(run.out).toContain(initOffer);
  expect(readFileSync(join(site, "skelcrew.yaml"), "utf8")).toContain("\ntracker: github\n");
});

test("a no to sc init writes nothing, and the lead opens", async () => {
  const site = siteOnGitHub();
  const run = await skel("\n1\nsk-ant-oat01-good\nn\n", bin, main(), site);
  expect(run.err).toBe("");
  expect(run.out).toContain(initOffer);
  expect(run.out).toContain(
    "Skelcrew · skipped. Run sc init here later, so GitHub's issues become this repository's tasks.",
  );
  expect(existsSync(join(site, "skelcrew.yaml"))).toBe(false);
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");
});

test("offers no sc init where skelcrew.yaml names a tracker, or after a no to the plugin", async () => {
  const site = siteOnGitHub();
  writeFileSync(join(site, "skelcrew.yaml"), "tracker: linear\n");
  const named = await skel("\n1\nsk-ant-oat01-good\n", bin, main(), site);
  expect(named.err).toBe("");
  expect(named.out).toContain("Installed github 0.1.0.");
  expect(named.out).not.toContain("sc init");
  expect(readFileSync(join(site, "skelcrew.yaml"), "utf8")).toBe("tracker: linear\n");

  rmSync(join(site, "skelcrew.yaml"));
  noGitHubPlugin();
  const without = await skel("n\n", bin, main(), site);
  expect(without.out).toContain("Skelcrew won't ask again for simon/site.");
  expect(without.out).not.toContain("sc init");
  expect(existsSync(join(site, "skelcrew.yaml"))).toBe(false);
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toStartWith("Skelcrew: install these first:\n");
  expect(run.err).toContain("sudo apt install tmux");
  expect(run.err).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).not.toContain("bubblewrap");
  expect(calls()).toBe("");
});

test("names git when it is missing, as Skelcrew clones and pushes with it", async () => {
  unlinkSync(join(bin, "git"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toStartWith("Skelcrew: install these first:\n");
  expect(run.err).toContain("  git: sudo apt install git\n");
  expect(calls()).toBe("");
});

test("on a Mac, names git with what Homebrew installs", async () => {
  asMac();
  rmSync(join(bin, "git"));
  const run = await skelOnMac();
  expect(run.code).toBe(1);
  expect(run.err).toContain("  brew install git\n");
});

test("gives the AppArmor advice when bwrap can't run", async () => {
  // AppArmor matches the file a link points to, so the advice must name that file.
  const real = join(home, "opt", "bwrap");
  mkdirSync(join(home, "opt"));
  writeFileSync(
    real,
    "#!/bin/sh\necho 'bwrap: setting up uid map: Permission denied' >&2\nexit 1\n",
    {
      mode: 0o755,
    },
  );
  unlinkSync(join(bin, "bwrap"));
  symlinkSync(real, join(bin, "bwrap"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("Permission denied");
  expect(run.err).toContain("AppArmor");
  expect(run.err).toContain(`profile skelcrew-bwrap ${real} `);
  expect(run.err).toContain("include if exists <local/skelcrew-bwrap>");
  expect(run.err).toContain("/etc/apparmor.d/skelcrew-bwrap");
  expect(run.err).not.toContain("/etc/apparmor.d/bwrap ");
  expect(calls()).not.toContain("claude");
});

test("asks for a token when the harness is saved but no token is", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("claude setup-token");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
});

for (const [pasted, why] of [
  ["sk-ant-api03-key", "that doesn't start with sk-ant-oat"],
  ["sk-ant-oat01-good sk-ant-oat01-again", "that has spaces"],
  [" ", "nothing was pasted"],
]) {
  test(`asks again for a token that isn't one from setup-token: ${JSON.stringify(pasted)}`, async () => {
    const run = await skel(`1\n${pasted}\nsk-ant-oat01-good\n`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`Skelcrew · ${why}`);
    expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  });

  test(`saves no token when the input ends after a wrong one: ${JSON.stringify(pasted)}`, async () => {
    const run = await skel(`1\n${pasted}\n`);
    expect(run.code).toBe(1);
    expect(existsSync(token())).toBe(false);
  });
}

test("saves no token after Ctrl-D at the token question", async () => {
  const run = await skel("1\n");
  expect(run.code).toBe(1);
  expect(calls()).toContain("claude setup-token");
  expect(existsSync(token())).toBe(false);
});

test("keeps the other settings in config.yaml", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "# mine\ncolor: blue\n");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  const saved = readFileSync(config(), "utf8");
  expect(saved).toContain("# mine");
  expect(saved).toContain("color: blue");
  expect(saved).toContain("harness: claude");
});

for (const broken of ["a: b: c\n", "harness: claude\n  - x: [\n"]) {
  test(`refuses a config.yaml that isn't YAML: ${JSON.stringify(broken)}`, async () => {
    mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
    writeFileSync(config(), broken);
    const run = await skel("1\nsk-ant-oat01-good\n");
    expect(run.code).toBe(1);
    expect(run.err).toContain("config.yaml");
    expect(readFileSync(config(), "utf8")).toBe(broken);
  });
}

for (const [what, typed] of [
  ["Ctrl-D", ""],
  ["another harness", "2\n"],
]) {
  test(`saves no harness after ${what} at the harness question`, async () => {
    const run = await skel(typed);
    expect(run.code).toBe(1);
    expect(run.out).toContain("Claude Code");
    expect(existsSync(config())).toBe(false);
  });
}

test("refuses a config.yaml it can't read", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: [1, 2]\n");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("config.yaml");
});

test("Enter at the harness question picks Claude Code", async () => {
  const run = await skel("\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
});

const codexHome = () => join(home, ".local", "share", "skelcrew", "codex");

// A login counts once Codex saved one in Skelcrew's own folder, never yours in ~/.codex.
function fakeCodex(login = ': > "$CODEX_HOME/auth.json"'): void {
  fake(
    "codex",
    `echo "CODEX_HOME=$CODEX_HOME" >> "$HOME/calls"
case "$1 $2" in
  "login status") test -f "$CODEX_HOME/auth.json" ;;
  "login --device-auth") ${login} ;;
esac`,
  );
}

test("logs the reviewer in to Codex with a login of Skelcrew's own", async () => {
  fakeCodex();
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Skelcrew · step 4 of 4: log the reviewer in to Codex\n");
  expect(run.out).toContain("Skelcrew · the reviewer is logged in to Codex.\n");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
  expect(statSync(codexHome()).mode & 0o777).toBe(0o700);
  // The token comes before the reviewer's login, and the service after it.
  const order = ["claude setup-token", "codex login --device-auth", "systemctl"];
  const at = order.map((call) => calls().indexOf(call));
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

test("skips the reviewer's login when Skelcrew's Codex login works already", async () => {
  fakeCodex();
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), "auth.json"), "{}");
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("codex login status");
  expect(calls()).not.toContain("codex login --device-auth");
});

test("says reviews run on your harness when Codex isn't installed", async () => {
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("for reviews");
  expect(run.out).toContain(
    "Skelcrew · Codex isn't installed, so reviews will run on your harness, with no second view",
  );
  expect(run.out).toContain("step 2 of 2");
  expect(run.out).toContain("second view");
});

test("finishes no setup when the reviewer's login fails, so the next sc tries again", async () => {
  fakeCodex("exit 1");
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("codex login");
  // The way back is marked even when the tool fails.
  expect(run.out).toEndWith(`\n\n──── back in Skelcrew ${"─".repeat(58)}\n`);
  expect(existsSync(unit())).toBe(false);

  fakeCodex();
  writeFileSync(join(home, "calls"), "");
  const again = await skel();
  expect(again.code).toBe(0);
  expect(calls()).not.toContain("claude setup-token");
  expect(calls()).toContain("codex login --device-auth");
  expect(existsSync(unit())).toBe(true);
});

test("on a machine with only Codex, Enter picks it, and its one login serves agents and reviews", async () => {
  unlinkSync(join(bin, "claude"));
  fakeCodex();
  const run = await skel("\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("2) Codex");
  expect(run.out).toContain("Skelcrew · step 2 of 2: log agents in to Codex\n");
  expect(run.out).toContain("Skelcrew · agents are logged in to Codex.\n");
  expect(run.out).not.toContain("for reviews");
  expect(run.out).not.toContain("the reviewer");
  expect(readFileSync(config(), "utf8")).toContain("harness: codex");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(calls()).not.toContain("claude");
  expect(existsSync(token())).toBe(false);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("setup is done");
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("picking Codex for agents and reviews where Claude Code is installed too skips Claude's login", async () => {
  fakeCodex();
  const run = await skel("2\n2\n");
  expect(run.code).toBe(0);
  expect(readFileSync(config(), "utf8")).toContain("harness: codex");
  expect(calls()).not.toContain("claude setup-token");
  expect(calls()).toContain("codex login --device-auth");
});

test("asks which harness reviews, offering the other one first", async () => {
  fakeCodex();
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  const asked = run.out.slice(run.out.indexOf("pick a harness for reviews"));
  expect(asked.indexOf("1) Codex")).toBeLessThan(asked.indexOf("2) Claude Code"));
  expect(parse(readFileSync(config(), "utf8"))).toEqual({
    harness: "claude",
    reviewer: { harness: "codex" },
  });
});

test("reviews on your own harness save nothing more, and need no other login", async () => {
  fakeCodex();
  const run = await skel("1\n2\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(parse(readFileSync(config(), "utf8"))).toEqual({ harness: "claude" });
  expect(calls()).not.toContain("codex login --device-auth");
  writeFileSync(join(home, "calls"), "");
  await skel();
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("Codex agents with Claude Code reviews log in to both", async () => {
  fakeCodex();
  const run = await skel("2\n\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("log the reviewer in to Claude");
  expect(run.out).toContain("log agents in to Codex");
  expect(parse(readFileSync(config(), "utf8"))).toEqual({
    harness: "codex",
    reviewer: { harness: "claude" },
  });
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  expect(calls()).toContain("codex login --device-auth");
});

test("refuses a harness that isn't installed, saying how to install it", async () => {
  const run = await skel("2\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("npm install -g @openai/codex");
  expect(existsSync(config())).toBe(false);
});

test("needs Claude Code or Codex, and names how to install either", async () => {
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).toContain("npm install -g @openai/codex");
  expect(calls()).toBe("");
});

// Ubuntu's ~/.bashrc stops early in a shell nobody types into, so a folder it adds, such as
// nvm's, is known to your terminal but not to a command run over ssh, as sc --remote runs.
function onlyLoginShellKnows(tools: string[]): string {
  const folder = join(home, "nvm", "bin");
  mkdirSync(folder, { recursive: true });
  for (const tool of tools) renameSync(join(bin, tool), join(folder, tool));
  writeFileSync(join(home, ".profile"), '. "$HOME/.bashrc"\n');
  writeFileSync(
    join(home, ".bashrc"),
    `case $- in *i*) ;; *) return;; esac\nexport PATH="${folder}:$PATH"\n`,
  );
  return folder;
}

const servicePath = () =>
  readFileSync(unit(), "utf8")
    .match(/PATH=(.*)"/)?.[1]
    ?.split(":");

test("finds the tools your login shell finds, on a first run over ssh", async () => {
  fakeCodex();
  const nvm = onlyLoginShellKnows(["claude", "codex"]);
  const run = await skel("1\n\nsk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(calls()).toContain("claude setup-token");
  // Without it, reviews would quietly run on Claude Code.
  expect(calls()).toContain("codex login --device-auth");
  expect(servicePath()).toContain(nvm);
  expect(servicePath()).toContain(bin);
});

test("keeps the login shell's folders in the service when Skelcrew runs over ssh again", async () => {
  fakeCodex();
  const nvm = onlyLoginShellKnows(["claude", "codex"]);
  await skel("1\n\nsk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  writeFileSync(join(home, "calls"), "");
  const run = await skel("", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.code).toBe(0);
  expect(servicePath()).toContain(nvm);
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

// sc remote add runs this on the machine it sets up, and leaves connecting to you.
test("sc first-run takes the steps and installs the service, without attaching", async () => {
  const run = Bun.spawn([process.execPath, main(), "first-run"], {
    cwd: home,
    env: { PATH: bin, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: join(home, "tmp") },
    stdin: new Blob(["1\nsk-ant-oat01-good\n"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await run.exited).toBe(0);
  expect(existsSync(unit())).toBe(true);
  expect(calls()).not.toContain("attach");
});

// Logging in on a machine is what sc remote add is for, so --remote never starts it.
test("over --remote, a machine whose first run isn't done says so and takes no step", async () => {
  const run = await skel("", bin, main(), home, { SKELCREW_REMOTE_NAME: "simon@workbox" });
  expect(run.err).toBe(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc remote add simon@workbox\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).not.toContain("claude");
});

test("over --remote, a machine that finished its first run attaches as usual", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  const run = await skel("", bin, main(), home, { SKELCREW_REMOTE_NAME: "simon@workbox" });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
});
