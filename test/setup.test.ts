// The first plain sc on a machine, run as you would run it, against fake tools.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { git, inTerminal, threadSql } from "./harness.ts";

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

// A bwrap that says it is this version, and logs every other call as the fakes do. Asking its
// version isn't logged, so tests that read the calls see only what Skelcrew ran in a sandbox.
function bwrapVersion(version: string): void {
  writeFileSync(
    join(bin, "bwrap"),
    `#!/bin/sh\n[ "$1" = --version ] && echo "bubblewrap ${version}" && exit 0\necho "bwrap $*" >> "$HOME/calls"\n`,
    { mode: 0o755 },
  );
}

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-setup-test-")));
  checkout = join(home, "skel");
  copySkel(checkout);
  bin = join(home, "bin");
  mkdirSync(bin);
  mkdirSync(join(home, "run"), { mode: 0o700 });
  mkdirSync(join(home, "tmp"));
  // PATH holds only this folder, so a test can take a tool away.
  symlinkSync(Bun.which("git") ?? "git", join(bin, "git"));
  fake("tmux", "exit 0");
  bwrapVersion("0.11.1");
  // Only there to be found: you run claude setup-token yourself.
  fake("claude", "exit 0");
  // The service runs the fake daemon, whose process id is 1, once started. Enabling it says
  // what systemd linked, as the real one does, which setup keeps to itself.
  fake(
    "systemctl",
    `case "$*" in
  "--user start skelcrew") : > "$HOME/started" ;;
  "--user enable --now skelcrew") : > "$HOME/started"; echo "Created symlink '$HOME/.config/systemd/user/default.target.wants/skelcrew.service'" >&2 ;;
  "--user show -p MainPID --value skelcrew") test -e "$HOME/started" && echo 1 || echo 0 ;;
esac`,
  );
  fake("loginctl", "exit 0");
  // Skelcrew has a repository, so plain Skelcrew has a lead to open once set up, and sc install in a
  // checkout of it adds nothing. The GitHub plugin is installed, unless a test removes it.
  const db = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
const db = openDb();
db.run("INSERT INTO repositories (name, owner, repo, remote) VALUES ('app', 'simon', 'app', 'git@example.com:simon/app.git')");
db.run("INSERT INTO plugins (name, folder) VALUES ('github', '/nowhere')");`;
  const added = Bun.spawnSync([process.execPath, "-e", db], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!added.success) throw new Error(added.stderr.toString());
  // Its clone holds the skelcrew.yaml every repository Skelcrew works on has.
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(clone, { recursive: true });
  writeFileSync(
    join(clone, "skelcrew.yaml"),
    "setup: []\ntest: []\nlimits: { threads: 4 }\nroles: { lead: { harness: claude }, builder: { harness: claude }, reviewer: { harness: claude } }\n",
  );
  daemon = await fakeDaemon();
});
afterEach(() => {
  daemon?.close();
  rmSync(home, { recursive: true, force: true });
});

function calls(): string {
  const log = join(home, "calls");
  // The long tmux line that opens the screen is cut to the agent it opens on. Asking tmux's
  // version and giving the agents' server its settings, which each opening does, are left out,
  // as is asking which daemon the service runs.
  const said = existsSync(log) ? readFileSync(log, "utf8") : "";
  return said
    .replace(/systemctl --user show -p MainPID --value skelcrew\n/g, "")
    .replace(/launchctl print .*\n/g, "")
    .replace(/tmux -L skelcrew -f \/dev\/null (source-file -|list-panes -a .*)\n/g, "")
    .replace(/tmux -V\n/g, "")
    .replace(/tmux -L skelcrew-screen .* sh skelcrew (\S+) \S+ ;.*/g, "screen on $1");
}

const config = () => join(home, ".config", "skelcrew", "config.yaml");
const configText = () => (existsSync(config()) ? readFileSync(config(), "utf8") : "");
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

// The service is set up the first time sc runs where there is a repository, not before.
test("outside a repository, with none yet, sets up nothing and says where to run sc", async () => {
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("DELETE FROM repositories");`;
  expect(Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } }).success).toBe(true);
  const run = await skel("sk-ant-oat01-good\n");
  expect(run).toEqual({
    out: "Skelcrew has no repositories yet. Run sc inside a git repository.\n",
    err: "",
    code: 0,
  });
  expect(calls()).not.toContain("systemctl");
  expect(calls()).not.toContain("daemon");
  expect(existsSync(unit())).toBe(false);
  expect(existsSync(token())).toBe(false);
});

test("takes every step on the first run, and none on the second", async () => {
  const first = await skel("sk-ant-oat01-good\n");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(first.out).toContain("Sign in to Claude. In another terminal, run:");
  expect(first.out).not.toContain("Choose the coding agent");
  expect(existsSync(config())).toBe(false);
  expect(calls()).not.toContain("claude setup-token");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  expect(statSync(token()).mode & 0o777).toBe(0o600);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.err).toBe("");
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("Claude Code");
  expect(second.out).not.toContain("set up");
  // Once set up, Skelcrew checks no tools, asks nothing and leaves systemd alone, so it
  // starts fast.
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("installs the daemon as a systemd user service with lingering, once", async () => {
  const first = await skel("sk-ant-oat01-good\n");
  expect(first.code).toBe(0);
  const skelBin = join(checkout, "bin", "sc");
  const written = readFileSync(unit(), "utf8");
  expect(written).toContain(`ExecStart="${skelBin}" serve\n`);
  expect(written).toContain("Restart=on-failure");
  expect(written).toContain("RestartPreventExitStatus=78");
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

test("installs the service on a machine set up before Skelcrew had one", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(existsSync(unit())).toBe(true);
  expect(calls()).toContain("systemctl --user enable --now skelcrew");
  expect(run.out).not.toContain("Sign in to Claude");
});

test("sc serve --bg installs and starts the service, then returns without attaching", async () => {
  // As a first run that finished leaves a machine, with no service yet.
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".local", "share", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "skelcrew", "set-up"), "");
  const run = await skel("", bin, main(), home, {}, ["serve", "--bg"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("running in the background");
  expect(readFileSync(unit(), "utf8")).toContain(" serve\n");
  expect(calls()).toBe(
    "systemctl --user daemon-reload\nsystemctl --user enable --now skelcrew\nloginctl enable-linger\n",
  );

  // With the daemon running, a second sc serve --bg changes nothing.
  writeFileSync(join(home, "calls"), "");
  const again = await skel("", bin, main(), home, {}, ["serve", "--bg"]);
  expect(again.code).toBe(0);
  expect(calls()).toBe("");
});

// A service started beside a daemon you run in a terminal would fail on its lock, again on each
// retry, until systemd gave up on it, and then fail to start once you stopped yours.
test("sc serve --bg leaves a daemon outside the service running, and starts no service", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".local", "share", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "skelcrew", "set-up"), "");
  // The fake daemon answers, but systemd runs no service.
  writeFileSync(join(home, "started"), "");
  fake("systemctl", 'test "$2" = show && echo 0; exit 0');
  const run = await skel("", bin, main(), home, {}, ["serve", "--bg"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("outside its service");
  expect(existsSync(unit())).toBe(false);
  expect(calls()).toBe("");
});

test("sc serve --bg starts without a config file", async () => {
  const run = await skel("", bin, main(), home, {}, ["serve", "--bg"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("running in the background");
  expect(existsSync(unit())).toBe(true);
  expect(existsSync(config())).toBe(false);
});

test("installs no service when systemctl fails, so the next sc tries again", async () => {
  fake("systemctl", 'echo "Failed to connect to bus" >&2; exit 1');
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  // What systemctl said, kept back while it worked, is shown once it fails.
  expect(run.err).toContain("systemctl --user daemon-reload failed");
  expect(run.err).toContain("Failed to connect to bus");
  expect(existsSync(unit())).toBe(false);
});

test("starts the daemon through systemd when it doesn't answer, then attaches to the lead", async () => {
  await skel("sk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(calls()).toBe("systemctl --user start skelcrew\ndaemon lead\nscreen on lead\n");
});

// The daemon watches the builder you attach to, so attaching to a thread brings it up too.
test("sc attach starts the daemon through systemd when it doesn't answer", async () => {
  await skel("sk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  const db = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run(${JSON.stringify(threadSql({ task: "12" }))});`;
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
  expect(calls()).toContain("tmux -L skelcrew -f /dev/null attach -t =app-12\n");
});

// A builder on a plugin's host still talks to the daemon, through its hooks and sc, so the
// daemon starts before the host attaches you, as on tmux.
test("sc attach starts the daemon before attaching to a builder on a plugin's host", async () => {
  await skel("sk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  // A host whose builder app-12 runs, and whose attach notes that it ran.
  const plugin = join(home, "plugin-fake");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "session.sh"),
    `read -r question; echo '{"sessions":[{"id":"fake-app-12","running":true,"labels":null}]}'\n`,
  );
  writeFileSync(join(plugin, "attach.sh"), 'echo "attach on fake $1" >> "$HOME/calls"\n');
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: A host\nkind: runtime\nprovides: [sessions]\nsession: [/bin/sh, session.sh]\nattach: [/bin/sh, attach.sh]\n",
  );
  const db = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
const db = openDb();
db.run(${JSON.stringify(threadSql({ task: "12", host: "fake", host_id: "fake-app-12" }))});
db.run("INSERT INTO plugins (name, folder) VALUES ('fake', ?)", [${JSON.stringify(plugin)}]);`;
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
  expect(calls().endsWith("systemctl --user start skelcrew\nattach on fake fake-app-12\n")).toBe(
    true,
  );
});

test("shows why when the daemon can't start the lead", async () => {
  await skel("sk-ant-oat01-good\n");
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
  await skel("sk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  const run = await skel("", `${bin}:/opt/bun/bin`);
  expect(run.code).toBe(0);
  expect(readFileSync(unit(), "utf8")).toContain(`Environment="PATH=${bin}:/opt/bun/bin"`);
  expect(calls()).toBe("systemctl --user daemon-reload\ndaemon lead\nscreen on lead\n");
});

// The service an older Skelcrew installed runs sc up, which no longer exists, so sc rewrites it.
test("rewrites a service that runs sc up so it runs sc serve", async () => {
  await skel("sk-ant-oat01-good\n");
  writeFileSync(unit(), readFileSync(unit(), "utf8").replace(" serve\n", " up\n"));
  writeFileSync(join(home, "calls"), "");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(readFileSync(unit(), "utf8")).toContain(
    `ExecStart="${join(checkout, "bin", "sc")}" serve\n`,
  );
  expect(calls()).toBe("systemctl --user daemon-reload\ndaemon lead\nscreen on lead\n");
});

test("leaves out PATH folders that won't last, and escapes % for systemd", async () => {
  const path = `${bin}:/code/app/node_modules/.bin:${join(home, "tmp", "bunx-1")}:/opt/50%`;
  const run = await skel("sk-ant-oat01-good\n", path);
  expect(run.code).toBe(0);
  expect(readFileSync(unit(), "utf8")).toContain(`Environment="PATH=${bin}:/opt/50%%"`);
});

test("refuses a PATH that systemd would read differently", async () => {
  const run = await skel("sk-ant-oat01-good\n", `${bin}:/opt/a"b`);
  expect(run.code).toBe(1);
  expect(run.err).toContain('/opt/a"b');
  expect(existsSync(unit())).toBe(false);
});

// A git worktree has a .git file pointing back at its repository, where a checkout has a folder.
test("refuses to install a service that runs sc from a worktree", async () => {
  const worktree = join(home, "code", "skel", ".claude", "worktrees", "12");
  copySkel(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/12\n");
  const run = await skel("sk-ant-oat01-good\n", bin, join(worktree, "src", "main.ts"));
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
  print) test -e "$HOME/started" && echo "pid = 1" ;;
esac`,
  );
  fake("brew", "exit 0");
}

const plist = () => join(home, "Library", "LaunchAgents", "dev.skelcrew.daemon.plist");
const uid = userInfo().uid;

test("on a Mac, installs the daemon as a launchd agent, with no systemd", async () => {
  asMac();
  const first = await skelOnMac("sk-ant-oat01-good\n");
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

test("says nothing about a laptop sleeping, on a Mac or on Linux", async () => {
  const onLinux = await skel("sk-ant-oat01-good\n");
  expect(onLinux.code).toBe(0);
  expect(onLinux.out).not.toContain("sleeps");
  // The Mac's first run starts afresh, as setup doesn't depend on the daemon's service.
  rmSync(config(), { force: true });
  rmSync(token());
  asMac();
  const onMac = await skelOnMac("sk-ant-oat01-good\n");
  expect(onMac.code).toBe(0);
  expect(onMac.out).not.toContain("sleeps");
});

test("on a Mac, installs no agent when launchctl fails, so the next sc tries again", async () => {
  asMac();
  fake("launchctl", 'test "$1" = bootout && exit 3; echo "Load failed" >&2; exit 5');
  const run = await skelOnMac("sk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("Load failed");
  expect(existsSync(plist())).toBe(false);
});

test("on a Mac, starts the daemon through launchd when it doesn't answer", async () => {
  asMac();
  await skelOnMac("sk-ant-oat01-good\n");
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac();
  expect(run.err).toBe("");
  expect(calls()).toContain(`launchctl kickstart gui/${uid}/dev.skelcrew.daemon\n`);
});

// launchd can lose the agent while its file stays, so Skelcrew thinks the daemon installed.
test("on a Mac, loads the agent from its file when launchd doesn't have it", async () => {
  asMac();
  // Like launchd, it knows the agent only once it is loaded.
  fake(
    "launchctl",
    `case "$1" in
  bootstrap) : > "$HOME/loaded"; : > "$HOME/started" ;;
  bootout) rm -f "$HOME/loaded" ;;
  kickstart|print)
    test -e "$HOME/loaded" || { echo "Could not find service" >&2; exit 113; }
    : > "$HOME/started" ;;
esac`,
  );
  await skelOnMac("sk-ant-oat01-good\n");
  rmSync(join(home, "loaded"));
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(calls()).toContain(`launchctl bootstrap gui/${uid} ${plist()}\n`);
});

// launchd restarts a daemon that crashed on the definition it loaded, not on the file. So once
// the file changes, such as from an older Skelcrew's sc up to sc serve, launchd must hold the new
// one, even while the daemon on this Skelcrew's code keeps answering.
test("on a Mac, loads a changed agent file, so launchd restarts the daemon on it", async () => {
  asMac();
  // Like launchd, it keeps a copy of the file it loaded, which is what it restarts after a crash.
  fake(
    "launchctl",
    `case "$1" in
  bootstrap) cp "$3" "$HOME/loaded.plist"; : > "$HOME/started" ;;
  bootout) rm -f "$HOME/loaded.plist" ;;
  print) test -e "$HOME/loaded.plist" && echo "pid = 1" ;;
esac`,
  );
  await skelOnMac("sk-ant-oat01-good\n");
  const older = readFileSync(plist(), "utf8").replace(
    "<string>serve</string>",
    "<string>up</string>",
  );
  writeFileSync(plist(), older);
  writeFileSync(join(home, "loaded.plist"), older);
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac("", `${bin}:/usr/bin`);
  expect(run.err).toBe("");
  const loaded = readFileSync(join(home, "loaded.plist"), "utf8");
  expect(loaded).toBe(readFileSync(plist(), "utf8"));
  expect(loaded).toContain("<string>serve</string>");
  expect(loaded).toContain(`<string>${bin}:/usr/bin</string>`);
  expect(calls()).toContain(
    `launchctl bootout gui/${uid}/dev.skelcrew.daemon\nlaunchctl bootstrap gui/${uid} ${plist()}\n`,
  );

  // An unchanged file is left as launchd loaded it.
  writeFileSync(join(home, "calls"), "");
  expect((await skelOnMac("", `${bin}:/usr/bin`)).code).toBe(0);
  expect(calls()).not.toContain("bootout");
  expect(calls()).not.toContain("bootstrap");
});

test("on a Mac, escapes a PATH for the agent's definition", async () => {
  asMac();
  const odd = join(home, "a&b");
  mkdirSync(odd);
  await skelOnMac("sk-ant-oat01-good\n", `${bin}:${odd}`);
  expect(readFileSync(plist(), "utf8")).toContain(`<string>${bin}:${home}/a&amp;b</string>`);
});

test("on a Mac, says exactly what to install with Homebrew, and runs nothing else", async () => {
  asMac();
  rmSync(join(bin, "tmux"));
  rmSync(join(bin, "claude"));
  const run = await skelOnMac();
  expect(run.code).toBe(1);
  expect(run.out).toContain("\n  brew install tmux\n");
  expect(run.out).not.toContain("Sign in");
  expect(run.out).not.toContain("bwrap");
  expect(run.out).not.toContain("apt");
  expect(run.out).not.toContain("brew.sh");
  expect(existsSync(join(home, "calls"))).toBe(false);
});

test("on a Mac without Homebrew, says where to get it", async () => {
  asMac();
  rmSync(join(bin, "brew"));
  rmSync(join(bin, "tmux"));
  const run = await skelOnMac();
  expect(run.out).toContain(
    "install:\nHomebrew, for the line below, from https://brew.sh\n\n  brew install tmux\n",
  );
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
  if (remote?.startsWith("git@example.com:")) onExample(remote);
  return folder;
}

// Puts the repository at a git@example.com: remote in home/example, which git reaches for it,
// with a skelcrew.yaml on its default branch, as sc install reads there.
function onExample(remote: string): void {
  const bare = join(home, "example", remote.slice("git@example.com:".length));
  if (existsSync(bare)) return;
  const work = join(home, "example-work", remote.slice("git@example.com:".length));
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "skelcrew.yaml"), "setup: []\ntest: []\nlimits: { threads: 4 }\n");
  git(work, "init", "-q", "-b", "main");
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", work, bare);
  appendFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/example/"]\n\tinsteadOf = git@example.com:\n`,
  );
}

// Runs plain sc, or the command in `args`, in `cwd` with a terminal as its input, typing `typed`
// into it. Skelcrew offers and installs a plugin only to an answer at a terminal. The token's
// question reads keys one by one there, through stty.
function atTerminal(typed: string, cwd = home, args: string[] = []) {
  if (!existsSync(join(bin, "stty"))) symlinkSync(Bun.which("stty") ?? "stty", join(bin, "stty"));
  const env = {
    PATH: bin,
    HOME: home,
    XDG_RUNTIME_DIR: join(home, "run"),
    TMPDIR: join(home, "tmp"),
  };
  return inTerminal([process.execPath, main(), ...args], { typed, env, cwd });
}

// Puts a GitHub plugin on the fake GitHub as skelcrew/skelcrew-github, a tracker and forge whose
// setup keeps the remote it was handed, and whose calls the fake plugin answers. It claims
// simon/site.
function publishGitHubPlugin(): void {
  const plugin = join(home, "github", "skelcrew", "skelcrew-github");
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

// Returns your checkout of simon/site, which is on the fake GitHub with a skelcrew.yaml that
// names no plugin, with no GitHub plugin installed and the plugin published there.
function siteOnGitHub(): string {
  noGitHubPlugin();
  fakeGitHub();
  publishGitHubPlugin();
  const site = checkoutWith("site");
  writeFileSync(join(site, "README"), "site\n");
  writeFileSync(
    join(site, "skelcrew.yaml"),
    "setup: []\ntest: []\nlimits: { threads: 4 }\nroles: { lead: { harness: claude } }\n",
  );
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "start");
  git(home, "clone", "-q", "--bare", site, join(home, "github", "simon", "site.git"));
  git(site, "remote", "add", "origin", "https://github.com/simon/site");
  return site;
}

// Returns whether Skelcrew has recorded a repository by this owner/name, and with which forge.
function recorded(owner: string, repo: string): { forge: string | null } | null {
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
console.log(JSON.stringify(openDb().query("SELECT forge FROM repositories WHERE owner = ? AND repo = ?").get(${JSON.stringify(owner)}, ${JSON.stringify(repo)})));`;
  const run = Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } });
  return JSON.parse(run.stdout.toString());
}

const pluginRows = () => {
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
console.log(JSON.stringify(openDb().query("SELECT name FROM plugins").all()));`;
  return JSON.parse(
    Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } }).stdout.toString(),
  );
};

// Plain sc checks the repository before anything else, so on a fresh machine a GitHub checkout
// with no skelcrew.yaml gets only the line naming sc init: nothing is asked, set up or installed.
test("on a fresh machine, a GitHub checkout with no skelcrew.yaml gets only the sc init line", async () => {
  const site = siteOnGitHub();
  git(site, "rm", "-q", "skelcrew.yaml");
  git(site, "commit", "-q", "-m", "No Skelcrew");
  git(site, "push", "-q", join(home, "github", "simon", "site.git"), "HEAD:main");
  const run = await atTerminal("y\nsk-ant-oat01-good\n", site);
  expect(run.out).toBe(
    "This repository has no skelcrew.yaml. Create one with:\n\n  sc init\n\nThen commit and push it.\n",
  );
  expect(run.err).toBe("");
  expect(run.code).toBe(1);
  expect(pluginRows()).toEqual([]);
  expect(existsSync(token())).toBe(false);
  expect(existsSync(unit())).toBe(false);
  expect(recorded("simon", "site")).toBeNull();
});

// A remote Skelcrew can't read stops plain sc there too, before anything is set up, rather than
// leaving what it would have found to a later step.
test("a remote Skelcrew can't read stops plain sc with one line, before anything is set up", async () => {
  const site = siteOnGitHub();
  rmSync(join(home, "github", "simon", "site.git"), { recursive: true, force: true });
  const run = await atTerminal("y\nsk-ant-oat01-good\n", site);
  expect(run.out).toBe("");
  expect(run.err).toStartWith(
    "Skelcrew: Skelcrew couldn't read this repository's default branch, to see its skelcrew.yaml: ",
  );
  expect(run.code).toBe(1);
  expect(existsSync(token())).toBe(false);
  expect(existsSync(unit())).toBe(false);
  expect(recorded("simon", "site")).toBeNull();
});

// Plain sc never installs a plugin: a repository whose files name one this machine lacks gets the
// line naming sc install, and isn't brought in without its forge. Once sc install has put the
// plugin in, sc brings the repository in with GitHub as its forge.
test("a skelcrew.yaml naming a plugin this machine lacks gets the sc install line, then sc opens it with its forge", async () => {
  const site = siteOnGitHub();
  const plugin = join(home, "github", "skelcrew", "skelcrew-github");
  const commit = git(plugin, "rev-parse", "HEAD").trim();
  appendFileSync(join(site, "skelcrew.yaml"), "plugins: [skelcrew/skelcrew-github]\n");
  writeFileSync(
    join(site, "skelcrew.lock"),
    `skelcrew/skelcrew-github: { name: github, version: 0.1.0, commit: ${commit} }\n`,
  );
  git(site, "add", ".");
  git(site, "commit", "-q", "-m", "Name GitHub");
  git(site, "push", "-q", join(home, "github", "simon", "site.git"), "HEAD:main");
  const stopped = await atTerminal("y\nsk-ant-oat01-good\n", site);
  expect(stopped.out).toBe(
    "This repository's skelcrew.yaml names plugins this machine doesn't have: github. Install them with:\n\n  sc install\n\nThen run sc again.\n",
  );
  expect(stopped.err).toBe("");
  expect(stopped.code).toBe(1);
  expect(pluginRows()).toEqual([]);
  expect(recorded("simon", "site")).toBeNull();
  // A plugin you removed with sc plugin rm is still missing for a repository coming in.
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("INSERT INTO removed_plugins (source) VALUES ('skelcrew/skelcrew-github')");`;
  expect(Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } }).success).toBe(true);
  expect((await atTerminal("y\n", site)).out).toBe(stopped.out);
  expect(recorded("simon", "site")).toBeNull();
  const installed = await atTerminal("y\n", site, ["install"]);
  expect(installed.out).toContain("Installed github 0.1.0.");
  const opened = await atTerminal("sk-ant-oat01-good\n", site);
  expect(opened.err).toBe("");
  expect(opened.code).toBe(0);
  expect(opened.out).not.toContain("Do you trust");
  expect(recorded("simon", "site")).toEqual({ forge: "github" });
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  // Steps to take, not an error: on stdout, with each command on its own line.
  expect(run.err).toBe("");
  expect(run.out).toBe(
    [
      "Before Skelcrew can start, install:",
      "",
      "  sudo apt install tmux",
      "",
      "Then run sc again.",
      "",
    ].join("\n"),
  );
  expect(calls()).toBe("");
});

test("names git when it is missing, as Skelcrew clones and pushes with it", async () => {
  unlinkSync(join(bin, "git"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.out).toStartWith("Before Skelcrew can start, install:\n\n  sudo apt install git\n\n");
  expect(calls()).toBe("");
});

test("on a Mac, names git with what Homebrew installs", async () => {
  asMac();
  rmSync(join(bin, "git"));
  const run = await skelOnMac();
  expect(run.code).toBe(1);
  expect(run.out).toContain("\n  brew install git\n");
});

// Reviews look at the thread's clone through an overlay, which bubblewrap has only since 0.11.
// Ubuntu 24.04's is 0.9, which would pass every other check and fail every review.
test("refuses a bwrap too old for reviews, before asking anything", async () => {
  bwrapVersion("0.9.0");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toBe(
    "Skelcrew: bwrap is 0.9.0 here, and Skelcrew needs 0.11 or newer for its reviews. Ubuntu 26.04 has it.\n",
  );
  expect(run.out).not.toContain("harness");
  expect(calls()).toBe("");
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
  expect(run.out).toContain("In another terminal, run:\n\n  claude setup-token\n");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
});

// Each wrong paste, with what Skelcrew says about it.
const wrongTokens: [string, string][] = [
  ["sk-ant-api03-key", "That doesn't start with sk-ant-oat"],
  ["sk-ant-oat01-good sk-ant-oat01-again", "That has spaces"],
  [" ", "Nothing was pasted. Paste it again:"],
];
for (const [pasted, why] of wrongTokens) {
  test(`asks again for a token that isn't one from setup-token: ${JSON.stringify(pasted)}`, async () => {
    const run = await skel(`${pasted}\nsk-ant-oat01-good\n`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(why);
    expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  });

  test(`saves no token when the input ends after a wrong one: ${JSON.stringify(pasted)}`, async () => {
    const run = await skel(`${pasted}\n`);
    expect(run.code).toBe(1);
    expect(existsSync(token())).toBe(false);
  });
}

test("saves no token after Ctrl-D at the token question", async () => {
  const run = await skel("");
  expect(run.code).toBe(1);
  expect(existsSync(token())).toBe(false);
});

test("keeps the other settings in config.yaml", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "# mine\ncolor: blue\n");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  const saved = configText();
  expect(saved).toContain("# mine");
  expect(saved).toContain("color: blue");
  expect(saved).toBe("# mine\ncolor: blue\n");
});

for (const broken of ["a: b: c\n", "harness: claude\n  - x: [\n"]) {
  test(`refuses a config.yaml that isn't YAML: ${JSON.stringify(broken)}`, async () => {
    mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
    writeFileSync(config(), broken);
    const run = await skel("sk-ant-oat01-good\n");
    expect(run.code).toBe(1);
    expect(run.err).toContain("config.yaml");
    expect(configText()).toBe(broken);
  });
}

test("plain sc with both harnesses installed asks only for the chosen role's login", async () => {
  fakeCodex();
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Choose the coding agent");
  expect(calls()).not.toContain("codex login --device-auth");
  expect(existsSync(config())).toBe(false);
});

test("refuses a config.yaml it can't read", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: [1, 2]\n");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("config.yaml");
});

// With both harnesses installed, the question is a list you move through with the arrow keys,
// each marked as installed, and Enter takes the one marked, Claude Code at first.

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

// Reviews on your own harness save nothing, so only the first run's end shows the question was
// answered. Here your harness has its login before the question is asked.

function requestLogin(harness: string): void {
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
const db = openDb();
db.run(${JSON.stringify(threadSql({ repo: "app", task: "12", branch: "work", status: "working" }))});
db.run("UPDATE threads SET needs_you_for = ?", [${JSON.stringify(`run sc: sign in to ${harness}`)}]);`;
  const run = Bun.spawnSync([process.execPath, "-e", code], {
    env: { HOME: home },
    stderr: "pipe",
  });
  if (!run.success) throw new Error(run.stderr.toString());
}

test("logs the reviewer in to Codex with a login of Skelcrew's own", async () => {
  fakeCodex();
  requestLogin("codex");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Sign in to Codex. Press Enter to start.\nSigned in to Codex.\n");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
  expect(statSync(codexHome()).mode & 0o777).toBe(0o700);
  expect(calls().indexOf("systemctl")).toBeLessThan(calls().indexOf("codex login --device-auth"));
  expect(run.out.indexOf("Token:")).toBeLessThan(run.out.indexOf("Sign in to Codex"));
});

// Codex's sign-in gets the terminal's alternate screen, so its text never mixes with Skelcrew's,
// which is as it was once Codex ends. Run at a real terminal, in tmux on a socket of its own.
test("at a terminal, Codex signs in on a screen of its own", async () => {
  fake("tmux", 'case "$*" in *new-session*) echo "[exited]" ;; esac');
  fakeCodex('echo "Open the link and enter CODE-1"; : > "$CODEX_HOME/auth.json"');
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: codex\n");
  symlinkSync(Bun.which("stty") ?? "stty", join(bin, "stty"));
  const real = Bun.which("tmux") ?? "tmux";
  const socket = `skelcrew-setup-test-${process.pid}`;
  const tmux = (...args: string[]) =>
    Bun.spawnSync([real, "-L", socket, "-f", "/dev/null", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
  const screen = () => tmux("capture-pane", "-p", "-t", "setup").stdout.toString();
  // Waits until the terminal shows the text, as a prompt reads keys only once it is up.
  const waitFor = async (text: string) => {
    for (let tries = 0; tries < 100 && !screen().includes(text); tries++) await Bun.sleep(100);
    expect(screen()).toContain(text);
  };
  const env = `PATH=${bin} HOME=${home} XDG_RUNTIME_DIR=${join(home, "run")} TMPDIR=${join(home, "tmp")}`;
  try {
    tmux(
      "new-session",
      "-d",
      "-s",
      "setup",
      "-c",
      home,
      "-x",
      "120",
      "-y",
      "40",
      `env -i ${env} TERM=xterm-256color ${process.execPath} ${main()}; echo FINISHED; sleep 5`,
    );
    await waitFor("Press Enter to start.");
    tmux("send-keys", "-t", "setup", "Enter");
    await waitFor("FINISHED");
    const after = screen();
    expect(after).toContain("Sign in to Codex. Press Enter to start.");
    expect(after).toContain("Signed in to Codex.");
    expect(after).not.toContain("CODE-1");
    expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
    expect(parse(configText())).toEqual({
      harness: "codex",
    });
  } finally {
    tmux("kill-server");
  }
}, 60_000);

test("skips the reviewer's login when Skelcrew's Codex login works already", async () => {
  fakeCodex();
  requestLogin("codex");
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), "auth.json"), "{}");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).not.toContain("codex login status");
  expect(calls()).not.toContain("codex login --device-auth");
});

// Pi is experimental, so it is never offered, but a role that names it, here a repository's, needs
// it installed and signed in.
test("signs Pi in when a repository's role runs on it, though agents run on Claude Code", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(
    config(),
    "harness: claude\nrepos:\n  simon/app:\n    roles: { builder: { harness: pi } }\n",
  );
  requestLogin("pi");
  const missing = await skel("sk-ant-oat01-good\n");
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("npm install -g @earendil-works/pi-coding-agent@1.6.0");
  fake(
    "pi",
    `[ "$1 $2" = "auth login" ] && echo '{"anthropic":{"type":"api_key","key":"k"}}' > "$PI_CODING_AGENT_DIR/auth.json"
[ "$1 $2" = "auth check" ] && [ ! -e "$PI_CODING_AGENT_DIR/auth.json" ] && exit 1
exit 0`,
  );
  const run = await skel("anthropic\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Sign in to Pi for the agent that needs it.");
  expect(run.out).toContain("Signed in to Pi.");
  expect(calls()).toContain("pi auth login anthropic --no-browser");
  writeFileSync(join(home, "calls"), "");
  const again = await skel();
  expect(again.out).not.toContain("Sign in to Pi");
  expect(calls()).not.toContain("pi auth login");
});

// A flow can run a role of the repository's own, whose approved file names Pi.
test("signs Pi in when a flow's own role runs on it, and asks to install Pi once it is gone", async () => {
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(join(clone, ".agents", "flows"), { recursive: true });
  mkdirSync(join(clone, ".agents", "roles"));
  writeFileSync(join(clone, ".agents", "flows", "quick.yaml"), "build:\n  role: tester\n");
  writeFileSync(join(clone, ".agents", "roles", "tester.md"), "---\nharness: pi\n---\nTest it.\n");
  const inClone = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  inClone("init", "-q");
  inClone("add", ".");
  inClone("commit", "-qm", "agents");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  const tree = inClone("rev-parse", "HEAD:.agents");
  writeFileSync(join(home, ".config", "skelcrew", "approved-agents.yaml"), `simon/app: ${tree}\n`);
  fake(
    "pi",
    `[ "$1 $2" = "auth login" ] && echo '{"anthropic":{"type":"api_key","key":"k"}}' > "$PI_CODING_AGENT_DIR/auth.json"
exit 0`,
  );
  requestLogin("pi");
  const run = await skel("sk-ant-oat01-good\nanthropic\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("pi auth login anthropic --no-browser");
  unlinkSync(join(bin, "pi"));
  rmSync(join(home, ".local", "share", "skelcrew", "pi", "auth.json"));
  const gone = await skel();
  expect(gone.code).toBe(1);
  expect(gone.out).toContain("npm install -g @earendil-works/pi-coding-agent@1.6.0");
});

test("with only Claude Code installed, asks nothing about harnesses and uses the default", async () => {
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Choose");
  expect(existsSync(config())).toBe(false);
});

test("finishes no setup when the reviewer's login fails, so the next sc tries again", async () => {
  fakeCodex("exit 1");
  requestLogin("codex");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("codex login");
  expect(run.out).not.toContain("Signed in to Codex");
  expect(existsSync(unit())).toBe(true);

  fakeCodex();
  writeFileSync(join(home, "calls"), "");
  const again = await skel();
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("Sign in to Claude");
  expect(calls()).toContain("codex login --device-auth");
  expect(existsSync(unit())).toBe(true);
});

test("on a machine with only Codex, a personal override logs in without a Claude question", async () => {
  unlinkSync(join(bin, "claude"));
  fakeCodex();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: codex\n");
  const run = await skel("\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Choose");
  expect(run.out).not.toContain("Choose");
  expect(run.out).toContain("Sign in to Codex. Press Enter to start.\nSigned in to Codex.\n");
  expect(run.out).not.toContain("for reviews");
  expect(run.out).not.toContain("the reviewer");
  expect(configText()).toContain("harness: codex");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(calls()).not.toContain("claude");
  expect(existsSync(token())).toBe(false);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("set up");
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("a personal Codex override where Claude Code is installed too skips Claude's login", async () => {
  fakeCodex();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: codex\n");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(configText()).toContain("harness: codex");
  expect(run.out).not.toContain("Sign in to Claude");
  expect(calls()).toContain("codex login --device-auth");
});

test("reviews on your own harness save nothing more, and need no other login", async () => {
  fakeCodex();
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(existsSync(config())).toBe(false);
  expect(calls()).not.toContain("codex login --device-auth");
  writeFileSync(join(home, "calls"), "");
  await skel();
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("Codex agents with Claude Code reviews log in to both", async () => {
  fakeCodex();
  requestLogin("claude");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: codex\n");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "Sign in to Claude. In another terminal, run:\n\n  claude setup-token\n",
  );
  expect(run.out).toContain("Sign in to Codex. Press Enter to start.");
  expect(parse(configText())).toEqual({
    harness: "codex",
  });
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  expect(calls()).toContain("codex login --device-auth");
});

test("names only the harness your config saved when it isn't installed", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: codex\n");
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.out).toContain(
    "a coding agent:\n\n  npm install -g @openai/codex\n\nThen run sc again.",
  );
  expect(run.out).not.toContain("claude.ai");
});

test("names the default Claude harness when it is missing", async () => {
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.out).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.out).not.toContain("npm install -g @openai/codex");
  expect(calls()).not.toContain("claude");
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
  const run = await skel("sk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(existsSync(config())).toBe(false);
  // Without it, reviews would quietly run on Claude Code.
  expect(calls()).not.toContain("codex login --device-auth");
  expect(servicePath()).toContain(nvm);
  expect(servicePath()).toContain(bin);
});

test("keeps the login shell's folders in the service when Skelcrew runs over ssh again", async () => {
  fakeCodex();
  const nvm = onlyLoginShellKnows(["claude", "codex"]);
  await skel("sk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  writeFileSync(join(home, "calls"), "");
  const run = await skel("", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.code).toBe(0);
  expect(servicePath()).toContain(nvm);
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("over --remote, commands do not require first-run setup", async () => {
  const run = await skel("", bin, main(), home, { SKELCREW_REMOTE_NAME: "simon@workbox" }, [
    "--help",
  ]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("USAGE");
});

test("over --remote, a machine that finished its first run attaches as usual", async () => {
  await skel("sk-ant-oat01-good\n");
  const run = await skel("", bin, main(), home, { SKELCREW_REMOTE_NAME: "simon@workbox" });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
});

// Puts a plugin on the fake GitHub as simon/skelcrew-fake, with a commit and a tag for each
// version. Its setup adds a line to the calls each time it runs.
function publishFake(...versions: string[]): void {
  publishPlugin("fake", ...versions);
}

// Puts a plugin of this name on the fake GitHub as simon/skelcrew-<name>, as publishFake does.
function publishPlugin(name: string, ...versions: string[]): void {
  const plugin = join(home, "github", "simon", `skelcrew-${name}`);
  mkdirSync(plugin, { recursive: true });
  for (const version of versions) {
    writeFileSync(
      join(plugin, "skelcrew-plugin.yaml"),
      `name: ${name}\nversion: ${version}\nskelcrew: 0.1.0\nabout: Fake\nkind: io\nprovides: [tracker]\nsetup: [bun, setup.ts]\ncall: ["true"]\n`,
    );
    writeFileSync(
      join(plugin, "setup.ts"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.HOME + "/calls", "${name} setup ${version}\\n");\n`,
    );
    if (!existsSync(join(plugin, ".git"))) git(plugin, "init", "-q", "-b", "main");
    git(plugin, "add", ".");
    // Empty when nothing changed, so publishing a version again moves its tag to a new commit.
    git(plugin, "commit", "-q", "--allow-empty", "-m", version);
    git(plugin, "tag", "-f", `v${version}`);
  }
}

const lock = () => join(home, ".config", "skelcrew", "skelcrew.lock");
const install = (typed = "") => atTerminal(typed, home, ["install"]);
const fakeCommit = (version: string) =>
  git(join(home, "github", "simon", "skelcrew-fake"), "rev-parse", `v${version}^{commit}`);
// Writes your config and lock as another machine of yours would have them: the fake plugin at
// this version and commit.
// The lock has a comment and a layout of its own, so a test can see sc install leave it as it is.
function lockFake(version: string, commit = fakeCommit(version)): void {
  appendFileSync(config(), "plugins: [simon/skelcrew-fake]\n");
  writeFileSync(
    lock(),
    `# From my laptop.\nsimon/skelcrew-fake: { name: fake, version: ${version}, commit: ${commit} }\n`,
  );
}

test("sc install on a machine with nothing to do says so, and changes nothing", async () => {
  await skel("sk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  const run = await install();
  expect(run.err).toBe("");
  expect(run.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
});

// Running sc install is the yes, so it asks nothing, and says in a line what it installs.
test("sc install installs your plugins at the version your lock pins without asking, and does nothing the second time", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  writeFileSync(join(home, "calls"), "");
  const first = await install();
  expect(first.err).toBe("");
  expect(first.out).toContain(
    "Installing fake 0.1.0 from simon/skelcrew-fake (runs as you, outside the agents' sandbox).\n",
  );
  expect(first.out).not.toContain("[Y/n]");
  expect(first.out).not.toContain("Fake");
  expect(first.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toBe("fake setup 0.1.0\n");
  const lockBefore = readFileSync(lock(), "utf8");
  writeFileSync(join(home, "calls"), "");
  const second = await install();
  expect(second.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
});

// Makes Skelcrew's clone folder of each repository it has, as the daemon does once it clones
// them, so sc install can tell what each one needs.
function cloneEach(): void {
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  const rows = db.query<{ owner: string; repo: string }, []>(
    "SELECT owner, repo FROM repositories",
  );
  for (const { owner, repo } of rows.all())
    mkdirSync(join(home, ".local", "share", "skelcrew", "repos", owner, repo), { recursive: true });
  db.close();
}

test("plain sc and install keep plugins after config and lock are deleted", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  const settings = join(home, ".config", "skelcrew", "plugins", "fake");
  mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "token"), "saved-token");
  rmSync(config(), { force: true });
  rmSync(lock(), { force: true });
  cloneEach();
  await skel();
  await install();
  expect(readFileSync(join(settings, "token"), "utf8")).toBe("saved-token");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(true);
});

test("sc install keeps a plugin a repository uses that your files don't name, and leaves your files", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run(
    "INSERT INTO repositories (owner, repo, name, forge) VALUES ('simon', 'other', 'other', 'fake')",
  );
  db.close();
  cloneEach();
  writeFileSync(config(), configText().replace("plugins: [simon/skelcrew-fake]", "plugins: []"));
  writeFileSync(lock(), "");
  const configBefore = configText();
  expect((await skel("", bin, main(), home, {}, ["plugin", "ls"])).out).toBe(
    "fake 0.1.0 io: tracker. sc install keeps it, as it is the tracker of other; the forge of other.\n",
  );
  writeFileSync(join(home, "calls"), "");
  const run = await install();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(true);
  expect(configText()).toBe(configBefore);
  expect(readFileSync(lock(), "utf8")).toBe("");
});

test("sc install on a machine with no lock pins nothing, and keeps the plugins repositories use", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  publishPlugin("team", "0.1.0");
  publishPlugin("spare", "0.1.0");
  await skel("sk-ant-oat01-good\n");
  for (const name of ["fake", "team", "spare"])
    await atTerminal("y\n", home, ["plugin", "add", "-g", `simon/skelcrew-${name}`]);
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run(
    "INSERT INTO repositories (owner, repo, name, forge) VALUES ('simon', 'other', 'other', 'fake')",
  );
  db.close();
  cloneEach();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "other");
  const team = git(join(home, "github", "simon", "skelcrew-team"), "rev-parse", "v0.1.0^{commit}");
  writeFileSync(join(clone, "skelcrew.yaml"), "plugins: [simon/skelcrew-team]\n");
  writeFileSync(
    join(clone, "skelcrew.lock"),
    `simon/skelcrew-team: { name: team, version: 0.1.0, commit: ${team} }\n`,
  );
  rmSync(lock());
  writeFileSync(config(), configText().replace(/plugins: .*\n/, ""));
  const configBefore = configText();
  expect((await skel("", bin, main(), home, {}, ["plugin", "ls"])).out).toBe(
    [
      "fake 0.1.0 io: tracker. sc install keeps it, as it is the tracker of other; the forge of other.",
      "spare 0.1.0 io: tracker. unused.",
      "team 0.1.0 io: tracker",
      "",
    ].join("\n"),
  );
  writeFileSync(join(home, "calls"), "");
  const run = await install();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Removed spare");
  expect(run.out).not.toContain("Removed fake");
  expect(run.out).not.toContain("Removed team");
  expect(calls()).toBe("");
  const plugins = join(home, ".local", "share", "skelcrew", "plugins");
  expect(readdirSync(plugins).sort()).toEqual(["fake", "spare", "team"]);
  expect(configText()).toBe(configBefore);
  expect(existsSync(lock())).toBe(false);
});

test("sc install installs the commit your lock pins, even after its tag moved, and moves to a changed commit", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  // The tag moves to a new commit, which your lock doesn't pin, so nothing changes here.
  const before = fakeCommit("0.1.0");
  publishFake("0.1.0");
  expect((await install()).out).toContain("Nothing to install");
  // A machine with nothing installed gets exactly the commit locked, not where the tag is now,
  // and the lock stays as it was.
  noGitHubPlugin();
  writeFileSync(join(home, "calls"), "");
  const lockBefore = readFileSync(lock(), "utf8");
  const fresh = await install("y\n");
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
  expect(fresh.err).toBe("");
  expect(fresh.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toBe("fake setup 0.1.0\n");
  const folder = join(home, ".local", "share", "skelcrew", "plugins", "fake", "0.1.0");
  expect(git(folder, "rev-parse", "HEAD")).toBe(before);
  // Your lock from another machine pins the new commit, which sc install moves the plugin to
  // without asking, as running it is the yes, with the lock left as it was.
  writeFileSync(config(), "harness: claude\n");
  lockFake("0.1.0");
  const newLock = readFileSync(lock(), "utf8");
  writeFileSync(join(home, "calls"), "");
  const moved = await install();
  expect(moved.err).toBe("");
  expect(moved.out).toContain(
    `Updating fake 0.1.0 to its commit ${fakeCommit("0.1.0").slice(0, 12)} from simon/skelcrew-fake (runs as you, outside the agents' sandbox).`,
  );
  expect(moved.out).not.toContain("[Y/n]");
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect(readFileSync(lock(), "utf8")).toBe(newLock);
  expect(newLock).toContain(fakeCommit("0.1.0"));
});

// No network or no login says nothing of the commit, so the error keeps git's words and
// doesn't suggest moving the lock.
test("a repository sc install can't reach keeps git's error and the lock", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  const lockBefore = readFileSync(lock(), "utf8");
  const locked = fakeCommit("0.1.0");
  renameSync(join(home, "github", "simon"), join(home, "github", "away"));
  const run = await install("y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    `git couldn't reach commit ${locked.slice(0, 12)} of simon/skelcrew-fake, which your lock pins:`,
  );
  expect(run.err).toContain("Nor its tag v0.1.0:");
  expect(run.err).toContain("does not appear to be a git repository");
  expect(run.err).not.toContain("sc plugin update -g");
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
});

test("a locked commit the repository no longer has is refused, and sc plugin update -g moves past it", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0", "deadbeef".repeat(5));
  const refused = await install("y\n");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("simon/skelcrew-fake no longer serves commit deadbeefdead");
  expect(refused.err).toContain("sc plugin update -g moves it to its newest version");
  const updated = await atTerminal("y\n", home, ["plugin", "update", "-g", "fake"]);
  expect(updated.err).toBe("");
  expect(updated.out).toContain("Installed fake 0.1.0.");
  expect(readFileSync(lock(), "utf8")).toContain(fakeCommit("0.1.0"));
  expect((await install()).out).toContain("Nothing to install");
});

test("sc plugin update -g moves an installed plugin to its tag's new commit, after asking", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  expect((await atTerminal("", home, ["plugin", "update", "-g", "fake"])).out).toContain(
    "fake is at its newest version, 0.1.0.",
  );
  publishFake("0.1.0");
  writeFileSync(join(home, "calls"), "");
  const moved = await atTerminal("y\n", home, ["plugin", "update", "-g", "fake"]);
  expect(moved.err).toBe("");
  expect(moved.out).toContain("Update the fake plugin? [Y/n]");
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect(readFileSync(lock(), "utf8")).toContain(fakeCommit("0.1.0"));
});

test("sc install without a terminal installs nothing, even with a yes piped in, and names each plugin left out", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  publishPlugin("bar", "0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  writeFileSync(
    config(),
    configText().replace(
      "plugins: [simon/skelcrew-fake]",
      "plugins: [simon/skelcrew-fake, simon/skelcrew-bar]",
    ),
  );
  const run = await skel("y\n", bin, main(), home, {}, ["install"]);
  // It fails, so a script running it can tell the machine doesn't match your files.
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "Skelcrew left out simon/skelcrew-fake, as each runs its commands, which needs your yes at a terminal",
  );
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "bar"))).toBe(false);
});

// The harness and its login are there, as copied from another machine, and only the service is
// missing. Bun's own prompts read ahead of piped input, so this keeps the plugin's question first.
// An older release marked the machine set up at the first run's end, without ever installing the
// plugins your files name, so plain sc after an upgrade still runs sc install once.

// A plugin that fails to install leaves the machine not set up, so the next plain sc tries again.
test("plain sc ignores an unpinned plugin in your config", async () => {
  noGitHubPlugin();
  fakeGitHub();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\nplugins: [simon/skelcrew-fake]\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  const run = await atTerminal("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Installed fake");
  expect(existsSync(lock())).toBe(false);
});

// A plugin you said no to is still named in your files, so the machine isn't set up until it is in.

// A machine already set up loses its mark when a plugin newly named in your files is declined.

// A failed sc install takes the mark away too, so plain sc tries again.

// On a new machine your files decide which GitHub plugin it gets, at the commit they lock.
test("in a GitHub checkout, sc install gets the locked commit of the GitHub plugin your files name", async () => {
  const site = siteOnGitHub();
  await skel("sk-ant-oat01-good\n");
  const plugin = join(home, "github", "skelcrew", "skelcrew-github");
  const locked = git(plugin, "rev-parse", "HEAD");
  // The tag moves on after your lock pinned it.
  git(plugin, "commit", "-q", "--allow-empty", "-m", "later");
  git(plugin, "tag", "-f", "v0.1.0");
  appendFileSync(config(), "plugins: [skelcrew/skelcrew-github]\n");
  writeFileSync(
    lock(),
    `skelcrew/skelcrew-github: { name: github, version: 0.1.0, commit: ${locked} }\n`,
  );
  const run = await atTerminal("y\n", site, ["install"]);
  expect(run.err).toBe("");
  expect(run.out).toContain("Installed github 0.1.0.");
  const folder = join(home, ".local", "share", "skelcrew", "plugins", "github", "0.1.0");
  expect(git(folder, "rev-parse", "HEAD")).toBe(locked);
  expect(readFileSync(lock(), "utf8")).toContain(locked);
});

// A forge can refuse to serve a commit by its id. Then the tag counts only while it still points
// at the commit your lock pins. A git that refuses such fetches stands in for that forge.
test("when the forge won't serve the locked commit, sc install takes the tag only while it is still at that commit", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const real = Bun.which("git") ?? "git";
  unlinkSync(join(bin, "git"));
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *" fetch --quiet --depth 1 "*) echo "fatal: unadvertised object" >&2; exit 128 ;; esac\nexec ${real} "$@"\n`,
    { mode: 0o755 },
  );
  const locked = fakeCommit("0.1.0");
  lockFake("0.1.0");
  const run = await install("y\n");
  expect(run.err).toBe("");
  expect(run.out).toContain("Installed fake 0.1.0.");
  const folder = join(home, ".local", "share", "skelcrew", "plugins", "fake", "0.1.0");
  expect(git(folder, "rev-parse", "HEAD")).toBe(locked);
  // Once the tag moves, the locked commit can't be reached, which is said, and the lock stays.
  publishFake("0.1.0");
  noGitHubPlugin();
  const lockBefore = readFileSync(lock(), "utf8");
  const gone = await install("y\n");
  expect(gone.code).toBe(1);
  expect(gone.err).toContain(
    `simon/skelcrew-fake no longer serves commit ${locked.slice(0, 12)}, which your lock pins: git couldn't fetch it (fatal: unadvertised object)`,
  );
  expect(gone.err).toContain(`its tag v0.1.0 is at ${fakeCommit("0.1.0").slice(0, 12)} now`);
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
});

// sc install never moves a pin your lock has, and adds one for a plugin your config names that
// the lock lacks, as npm install does.
test("sc install leaves every pin as it is and ignores unpinned config plugins", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  publishPlugin("other", "0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  writeFileSync(
    config(),
    "harness: claude\nplugins: [simon/skelcrew-fake, simon/skelcrew-other]\n",
  );
  const pinned = readFileSync(lock(), "utf8");
  writeFileSync(join(home, "calls"), "");
  const run = await install("y\ny\n");
  expect(run.err).toBe("");
  expect(run.out).toContain("Installed fake 0.1.0.");
  expect(run.out).not.toContain("Installed other");
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect(readFileSync(lock(), "utf8")).toBe(pinned);
  expect((await install()).out).toContain("Nothing to install");
});

// Writes a repository's skelcrew.yaml naming the fake plugin and its skelcrew.lock pinning it at
// this version, into `folder`: your checkout of it, or Skelcrew's clone.
function repositoryLocksFake(folder: string, version: string, commit = fakeCommit(version)): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "skelcrew.yaml"), "plugins: [simon/skelcrew-fake]\n");
  writeFileSync(
    join(folder, "skelcrew.lock"),
    `simon/skelcrew-fake: { name: fake, version: ${version}, commit: ${commit} }\n`,
  );
}

const fakeFolder = () => join(home, ".local", "share", "skelcrew", "plugins", "fake", "0.1.0");

test("sc install in a checkout installs the plugins its skelcrew.lock pins without asking, and does nothing the second time", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  const locked = fakeCommit("0.1.0");
  // The tag moves on after the repository pinned it.
  publishFake("0.1.0");
  repositoryLocksFake(app, "0.1.0", locked);
  writeFileSync(join(home, "calls"), "");
  const first = await atTerminal("", app, ["install"]);
  expect(first.err).toBe("");
  expect(first.out).toContain(
    "Installing fake 0.1.0 from simon/skelcrew-fake (runs as you, outside the agents' sandbox).\n",
  );
  expect(first.out).not.toContain("[Y/n]");
  expect(first.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect(git(fakeFolder(), "rev-parse", "HEAD")).toBe(locked);
  // Nothing is written into the checkout, and the plugin isn't yours.
  expect(git(app, "status", "--porcelain")).toBe("?? skelcrew.lock\n?? skelcrew.yaml");
  expect(readFileSync(join(app, "skelcrew.lock"), "utf8")).toContain(locked);
  expect(configText()).not.toContain("plugins");
  expect(existsSync(lock()) ? readFileSync(lock(), "utf8") : "").not.toContain("fake");
  writeFileSync(join(home, "calls"), "");
  cloneEach();
  const second = await atTerminal("", app, ["install"]);
  expect(second.err).toBe("");
  expect(second.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
  // Your own plugins and lock never take it in, even read later on a machine with no lock.
  await atTerminal("", home, ["plugin", "ls"]);
  expect(configText()).not.toContain("plugins");
});

// A plugin of yours that a repository pins at the very version installed is already there, so
// sc install has nothing to do for it.
test("sc install in a checkout asks nothing for a plugin of yours the repository pins at the version installed", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  expect((await install("y\n")).out).toContain("Installed fake 0.1.0.");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  cloneEach();
  const run = await atTerminal("", app, ["install"]);
  expect(run.err).toBe("");
  expect(run.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
});

// A machine holds one version of a plugin, so a repository pinning another version than yours
// leaves yours as it is and says why.
test("sc install in a checkout that pins a plugin of yours at another version says the pins disagree", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  expect((await install("y\n")).out).toContain("Installed fake 0.1.0.");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.2.0");
  cloneEach();
  const run = await atTerminal("", app, ["install"]);
  expect(`${run.out}${run.err}`).not.toContain("installed already");
  expect(run.out).toContain("simon/skelcrew-fake is pinned at");
  expect(git(fakeFolder(), "rev-parse", "HEAD")).toBe(fakeCommit("0.1.0"));
});

// The plugin of that name installed here is this very plugin, so moving its pin updates it.
test("sc install updates a repository's plugin when its skelcrew.lock moves to another version, without asking", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  expect((await atTerminal("y\n", app, ["install"])).out).toContain("Installed fake 0.1.0.");
  repositoryLocksFake(app, "0.2.0");
  const run = await atTerminal("", app, ["install"]);
  expect(run.err).toBe("");
  expect(run.out).not.toContain("installed already");
  expect(run.out).toContain(
    "Updating fake 0.1.0 to 0.2.0 from simon/skelcrew-fake (runs as you, outside the agents' sandbox).",
  );
  expect(run.out).not.toContain("[Y/n]");
  expect(run.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
  expect((await atTerminal("", app, ["install"])).out).toContain("Nothing to install");
});

test("sc install outside a checkout ignores repository plugins", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  repositoryLocksFake(join(home, ".local", "share", "skelcrew", "repos", "simon", "app"), "0.1.0");
  const run = await install();
  expect(run.code).toBe(0);
  expect(run.out).toContain("Nothing to install");
  expect(existsSync(fakeFolder())).toBe(false);
});

test("a changed commit in a repository's skelcrew.lock moves the plugin to it", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  await atTerminal("y\n", app, ["install"]);
  publishFake("0.1.0");
  repositoryLocksFake(app, "0.1.0");
  writeFileSync(join(home, "calls"), "");
  const moved = await atTerminal("", app, ["install"]);
  expect(moved.err).toBe("");
  expect(moved.out).toContain(
    `Updating fake 0.1.0 to its commit ${fakeCommit("0.1.0").slice(0, 12)} from simon/skelcrew-fake`,
  );
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect((await atTerminal("", app, ["install"])).out).toContain("Nothing to install");
});

test("sc install leaves out a plugin a repository names without a pin, keeping the machine set up", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  writeFileSync(join(app, "skelcrew.yaml"), "plugins: [simon/skelcrew-fake]\n");
  const unpinned = await atTerminal("y\n", app, ["install"]);
  expect(unpinned.err).toBe("");
  // It fails, so a script running it can tell the repository's plugin isn't in.
  expect(unpinned.code).toBe(1);
  expect(unpinned.out).toContain(
    "This checkout's skelcrew.yaml names simon/skelcrew-fake, which its skelcrew.lock doesn't pin, so Skelcrew didn't install it. sc plugin add simon/skelcrew-fake pins it.",
  );
  expect(unpinned.out).not.toContain("Nothing to install");
  expect(existsSync(fakeFolder())).toBe(false);
  // The machine stays set up: plain sc asks nothing of what is yours.
  expect(existsSync(join(home, ".local", "share", "skelcrew", "install-done"))).toBe(false);
});

test("sc install without a terminal installs none of a repository's plugins", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  const run = await skel("y\n", bin, main(), app, {}, ["install"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain("Skelcrew left out simon/skelcrew-fake, as each runs its commands");
  expect(existsSync(fakeFolder())).toBe(false);
});

// A machine holds one version of a plugin, so pins that disagree are said, never settled by
// whichever is read last.
test("sc install leaves a plugin your lock and a repository pin at different commits, and says so", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const yours = fakeCommit("0.1.0");
  lockFake("0.1.0");
  // The repository pins the tag after it moved.
  publishFake("0.1.0");
  const theirs = fakeCommit("0.1.0");
  const clone = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(clone, "0.1.0");
  const said = `simon/skelcrew-fake is pinned at 0.1.0 at commit ${yours.slice(0, 12)} by your lock, 0.1.0 at commit ${theirs.slice(0, 12)} by This checkout. A machine holds one version of a plugin, so Skelcrew left it as it is. Pin the same version in each.`;
  // On a machine without it, neither side is installed.
  const fresh = await atTerminal("y\n", clone, ["install"]);
  expect(fresh.err).toBe("");
  expect(fresh.code).toBe(1);
  expect(fresh.out).toContain(said);
  expect(fresh.out).not.toContain("Update the fake plugin?");
  expect(existsSync(fakeFolder())).toBe(false);
  // The machine isn't set up while the pins disagree, so plain sc tries again and says why.
  const done = join(home, ".local", "share", "skelcrew", "install-done");
  expect(fresh.out).not.toContain("Nothing to install");
  expect(existsSync(done)).toBe(false);
  // Installed at the repository's pin, your lock doesn't move it either.
  repositoryLocksFake(clone, "0.1.0", yours);
  await atTerminal("y\n", clone, ["install"]);
  expect(git(fakeFolder(), "rev-parse", "HEAD")).toBe(yours);
  repositoryLocksFake(clone, "0.1.0", theirs);
  const again = await atTerminal("y\n", clone, ["install"]);
  expect(again.out).toContain(said);
  expect(again.out).not.toContain("Update the fake plugin?");
  expect(again.out).not.toContain("Nothing to install");
  expect(git(fakeFolder(), "rev-parse", "HEAD")).toBe(yours);
  // Installed at your pin, it still keeps the machine unfinished until the pins agree.
  expect(again.code).toBe(1);
  expect(existsSync(done)).toBe(false);
});

// The lock says which plugin a repository gets, so one by another name is never taken for it.
test("sc install refuses a plugin whose manifest names it otherwise than the repository's lock", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  const lockText = () => readFileSync(join(app, "skelcrew.lock"), "utf8");
  writeFileSync(join(app, "skelcrew.lock"), lockText().replace("name: fake", "name: other"));
  const said =
    "the lock pins other, and the plugin there is fake, so Skelcrew won't take one for the other";
  const fresh = await atTerminal("y\n", app, ["install"]);
  expect(fresh.code).toBe(1);
  expect(fresh.err).toContain(said);
  expect(fresh.out).not.toContain("[Y/n]");
  expect(existsSync(fakeFolder())).toBe(false);
  // Installed already at the pinned commit, it still isn't the plugin the lock names.
  writeFileSync(join(app, "skelcrew.lock"), lockText().replace("name: other", "name: fake"));
  await atTerminal("y\n", app, ["install"]);
  writeFileSync(join(app, "skelcrew.lock"), lockText().replace("name: fake", "name: other"));
  const installed = await atTerminal("", app, ["install"]);
  expect(installed.code).toBe(1);
  expect(installed.err).toContain(said);
});

// A folder plugin has no pin, so a repository naming a path could pick code of its own to run.
test("sc install refuses a repository that names a plugin by a path", async () => {
  await skel("sk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  mkdirSync(join(app, "plugin"));
  writeFileSync(join(app, "skelcrew.yaml"), "plugins: [./plugin]\n");
  writeFileSync(
    join(app, "skelcrew.lock"),
    `./plugin: { name: fake, version: 0.1.0, commit: ${"a".repeat(40)} }\n`,
  );
  const run = await atTerminal("y\n", app, ["install"]);
  expect(run.code).toBe(1);
  expect(run.out).toContain("must be owner/repo, such as skelcrew/skelcrew-github");
  expect(run.out).not.toContain("[Y/n]");
});

// A runtime plugin is always yours, even when one of yours is what the repository pins.
test("sc install refuses a repository that names a runtime plugin installed as yours", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  const plugin = join(home, "github", "simon", "skelcrew-fake");
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    'name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Fake\nkind: runtime\nprovides: [sessions]\nsetup: [bun, setup.ts]\nsession: ["true"]\nattach: ["true"]\n',
  );
  git(plugin, "commit", "-q", "-am", "runtime");
  git(plugin, "tag", "-f", "v0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  expect(existsSync(fakeFolder())).toBe(true);
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.1.0");
  const run = await atTerminal("", app, ["install"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "fake is a runtime plugin, which is always yours and never a repository's",
  );
  expect(run.out).not.toContain("Nothing to install");
});

// The kind that counts is the pinned version's, which may differ from the one installed.
test("sc install moves a runtime plugin that isn't yours to a pinned version that is I/O", async () => {
  noGitHubPlugin();
  fakeGitHub();
  const plugin = join(home, "github", "simon", "skelcrew-fake");
  publishFake("0.1.0");
  const io = readFileSync(join(plugin, "skelcrew-plugin.yaml"), "utf8");
  writeFileSync(
    join(plugin, "skelcrew-plugin.yaml"),
    'name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Fake\nkind: runtime\nprovides: [sessions]\nsetup: [bun, setup.ts]\nsession: ["true"]\nattach: ["true"]\n',
  );
  git(plugin, "commit", "-q", "-am", "runtime");
  git(plugin, "tag", "-f", "v0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  // No longer yours, it is installed here and named by no file of yours.
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(lock(), "");
  writeFileSync(join(plugin, "skelcrew-plugin.yaml"), io.replace("0.1.0", "0.2.0"));
  git(plugin, "commit", "-q", "-am", "0.2.0");
  git(plugin, "tag", "v0.2.0");
  const app = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(app, "0.2.0");
  const run = await atTerminal("", app, ["install"]);
  expect(run.err).toBe("");
  expect(run.out).toContain("Updating fake 0.1.0 to 0.2.0 from simon/skelcrew-fake");
  expect(run.out).toContain("Updated fake from 0.1.0 to 0.2.0.");
});

// Installing a plugin of yours with no pin yet pins its newest version, which may disagree with a
// repository's pin.
test("an unpinned config entry does not conflict with a repository pin", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("sk-ant-oat01-good\n");
  appendFileSync(config(), "plugins: [simon/skelcrew-fake]\n");
  const root = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(root, "0.1.0");
  const run = await atTerminal("y\n", root, ["install"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("Installed fake 0.1.0.");
  expect(run.out).not.toContain("different commits");
  expect(existsSync(lock())).toBe(false);
});

// A broken file in one repository can't hide another repository's pin that disagrees with yours.
test("sc install checks this checkout against the personal lock and ignores another broken repository", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  publishFake("0.1.0");
  const repos = join(home, ".local", "share", "skelcrew", "repos", "simon");
  repositoryLocksFake(join(repos, "app"), "0.1.0");
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site')");`;
  Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } });
  mkdirSync(join(repos, "site"), { recursive: true });
  writeFileSync(join(repos, "site", "skelcrew.yaml"), "plugins: [./plugin]\n");
  const root = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(root, "0.1.0");
  const run = await atTerminal("y\n", root, ["install"]);
  expect(run.code).toBe(1);
  expect(run.out).toContain("simon/skelcrew-fake is pinned at");
  expect(run.out).not.toContain("[Y/n]");
  expect(existsSync(fakeFolder())).toBe(false);
  expect(run.out).not.toContain("site:");
  expect(run.out).not.toContain("must be owner/repo");
  // Unfinished for the pins that disagree, which plain sc says again.
  expect(existsSync(join(home, ".local", "share", "skelcrew", "install-done"))).toBe(false);
});

// A plugin only a repository's skelcrew.lock pins, with no line in its skelcrew.yaml, is stale,
// but removing it would lose its settings and tokens, so it stays.
test("sc install keeps a plugin a repository's skelcrew.lock pins, though its skelcrew.yaml doesn't name it", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  cloneEach();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  repositoryLocksFake(clone, "0.1.0");
  writeFileSync(join(clone, "skelcrew.yaml"), "");
  writeFileSync(config(), configText().replace(/plugins: .*\n/, ""));
  writeFileSync(lock(), "");
  expect((await skel("", bin, main(), home, {}, ["plugin", "ls"])).out).toBe(
    "fake 0.1.0 io: tracker\n",
  );
  const run = await install();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("Removed");
  expect(existsSync(fakeFolder())).toBe(true);
});

// A repository whose files can't be read, even one that names no plugin, stops nothing else:
// every plugin stays, the machine is set up, and sc install fails, so a script can tell.
test("outside a checkout a broken repository lock does not block personal installation", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  cloneEach();
  const clone = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  writeFileSync(join(clone, "skelcrew.lock"), "simon/skelcrew-fake: [\n");
  writeFileSync(config(), configText().replace(/plugins: .*\n/, ""));
  writeFileSync(lock(), "");
  const run = await install();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("couldn't read");
  expect(run.out).not.toContain("Removed");
  expect(existsSync(fakeFolder())).toBe(true);
  expect(existsSync(join(home, ".local", "share", "skelcrew", "install-done"))).toBe(false);
});

// A failure in another repository's install, such as for want of a terminal, can't hide it.
test("sc install names an unreadable checkout and ignores other repositories", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const repos = join(home, ".local", "share", "skelcrew", "repos", "simon");
  repositoryLocksFake(join(repos, "app"), "0.1.0");
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site')");`;
  Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } });
  mkdirSync(join(repos, "site"), { recursive: true });
  writeFileSync(join(repos, "site", "skelcrew.yaml"), "plugins: [./plugin]\n");
  const root = checkoutWith("bad", "git@example.com:simon/bad.git");
  writeFileSync(join(root, "skelcrew.yaml"), "plugins: [./plugin]\n");
  const run = await skel("y\n", bin, main(), root, {}, ["install"]);
  expect(run.code).toBe(1);
  expect(run.err).toBe("");
  expect(run.out).toContain("This checkout");
  expect(run.out).toContain("must be owner/repo");
});

// The machine is set up, but a repository's plugin left out by pins that disagree still fails
// sc install, so a script running it can tell.
test("sc install ignores another repository pinning a different commit", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  const repos = join(home, ".local", "share", "skelcrew", "repos", "simon");
  repositoryLocksFake(join(repos, "app"), "0.1.0");
  publishFake("0.1.0");
  const code = `import { openDb } from ${JSON.stringify(join(checkout, "src", "db.ts"))};
openDb().run("INSERT INTO repositories (name, owner, repo) VALUES ('site', 'simon', 'site')");`;
  Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: home } });
  repositoryLocksFake(join(repos, "site"), "0.1.0");
  const root = checkoutWith("app", "git@example.com:simon/app.git");
  repositoryLocksFake(root, "0.1.0");
  const run = await atTerminal("y\n", root, ["install"]);
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("simon/skelcrew-fake is pinned at");
  expect(existsSync(fakeFolder())).toBe(true);
  expect(existsSync(join(home, ".local", "share", "skelcrew", "install-done"))).toBe(false);
  // With the pins agreeing and the plugin in, it succeeds.
  repositoryLocksFake(join(repos, "site"), "0.1.0", fakeCommit("0.1.0"));
  repositoryLocksFake(join(repos, "app"), "0.1.0", fakeCommit("0.1.0"));
  expect((await install("y\n")).code).toBe(0);
  expect((await install()).code).toBe(0);
});

test("sc install ignores an unpinned personal plugin in config", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  appendFileSync(config(), "plugins: [simon/skelcrew-fake]\n");
  const run = await install();
  expect(run.out).not.toContain("fake plugin");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
});

test("install reads only this checkout's plugins and asks no machine questions", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  const root = join(home, "app");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "git@example.com:simon/app.git");
  onExample("git@example.com:simon/app.git");
  writeFileSync(join(root, "skelcrew.yaml"), "plugins: [simon/skelcrew-fake]\n");
  writeFileSync(
    join(root, "skelcrew.lock"),
    `simon/skelcrew-fake: { name: fake, version: 0.1.0, commit: ${fakeCommit("0.1.0")} }\n`,
  );
  const run = await skel("", bin, main(), root, {}, ["install"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain("needs your yes at a terminal");
  expect(run.out).not.toContain("Sign in");
  expect(run.out).not.toContain("Choose the coding agent");
  expect(existsSync(config())).toBe(false);
  expect(existsSync(token())).toBe(false);
  expect(existsSync(unit())).toBe(false);
  expect(calls()).not.toContain("systemctl");
});

test("plain sc uses repository roles and never writes a personal harness override", async () => {
  fakeCodex();
  const root = join(home, ".local", "share", "skelcrew", "repos", "simon", "app");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "skelcrew.yaml"),
    "roles: { lead: { harness: codex }, builder: { harness: codex } }\n",
  );
  const run = await skel();
  expect(run.code).toBe(0);
  expect(calls()).toContain("codex login --device-auth");
  expect(run.out).not.toContain("claude setup-token");
  expect(existsSync(config())).toBe(false);
  expect(existsSync(unit())).toBe(true);
});

test("plain sc leaves personal plugins for explicit install", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("sk-ant-oat01-good\n");
  lockFake("0.1.0");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(existsSync(fakeFolder())).toBe(false);
  expect(run.out).not.toContain("Install the fake plugin");
  expect((await install("y\n")).out).toContain("Installed fake 0.1.0.");
});
