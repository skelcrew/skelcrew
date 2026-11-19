// The first plain sc on a machine, run as you would run it, against fake tools.
import { Database } from "bun:sqlite";
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
  // PATH holds only this folder, so a test can take a tool away.
  symlinkSync(Bun.which("git") ?? "git", join(bin, "git"));
  fake("tmux", "exit 0");
  bwrapVersion("0.11.1");
  // Only there to be found: you run claude setup-token yourself.
  fake("claude", "exit 0");
  // The service runs the fake daemon, whose process id is 1, once started.
  fake(
    "systemctl",
    `case "$*" in
  "--user start skelcrew"|"--user enable --now skelcrew") : > "$HOME/started" ;;
  "--user show -p MainPID --value skelcrew") test -e "$HOME/started" && echo 1 || echo 0 ;;
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
  // Only Skelcrew's own lines: you run claude setup-token yourself, in another terminal.
  expect(first.out).toBe(
    [
      "Setting up Skelcrew...",
      "",
      "Choose the coding agent:",
      "  1) Claude Code",
      "  2) Codex",
      "Number: [1] ",
      "Sign in to Claude. In another terminal, run:",
      "",
      "  claude setup-token",
      "",
      "Then paste the token here.",
      "Token: ",
      "Codex isn't installed, so reviews run on Claude Code.",
      "",
      "Skelcrew is set up.",
      "Keeping Skelcrew running after you log out or restart.",
      "Your agents keep running. Run sc to come back.",
      "",
    ].join("\n"),
  );
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
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
  const first = await skel("1\nsk-ant-oat01-good\n");
  expect(first.code).toBe(0);
  const skelBin = join(checkout, "bin", "sc");
  const written = readFileSync(unit(), "utf8");
  expect(written).toContain(`ExecStart="${skelBin}" up\n`);
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

test("sc up --bg installs and starts the service, then returns without attaching", async () => {
  // As a first run that finished leaves a machine, with no service yet.
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".local", "share", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "skelcrew", "set-up"), "");
  const run = await skel("", bin, main(), home, {}, ["up", "--bg"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("running in the background");
  expect(readFileSync(unit(), "utf8")).toContain(" up\n");
  expect(calls()).toBe(
    "systemctl --user daemon-reload\nsystemctl --user enable --now skelcrew\nloginctl enable-linger\n",
  );

  // With the daemon running, a second sc up --bg changes nothing.
  writeFileSync(join(home, "calls"), "");
  const again = await skel("", bin, main(), home, {}, ["up", "--bg"]);
  expect(again.code).toBe(0);
  expect(calls()).toBe("");
});

// A service started beside a daemon you run in a terminal would fail on its lock, again on each
// retry, until systemd gave up on it, and then fail to start once you stopped yours.
test("sc up --bg leaves a daemon outside the service running, and starts no service", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  mkdirSync(join(home, ".local", "share", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "skelcrew", "set-up"), "");
  // The fake daemon answers, but systemd runs no service.
  writeFileSync(join(home, "started"), "");
  fake("systemctl", 'test "$2" = show && echo 0; exit 0');
  const run = await skel("", bin, main(), home, {}, ["up", "--bg"]);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("outside its service");
  expect(existsSync(unit())).toBe(false);
  expect(calls()).toBe("");
});

// The service has no terminal, so a daemon started before the first run would only fail.
test("sc up --bg refuses before the first run, and says to run sc", async () => {
  const run = await skel("", bin, main(), home, {}, ["up", "--bg"]);
  expect(run.code).toBe(1);
  expect(run.err).toContain("run sc");
  expect(existsSync(unit())).toBe(false);
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
  expect(calls()).toContain("screen on app-12\n");
});

// A builder on a plugin's host still talks to the daemon, through its hooks and sc, so the
// daemon starts before the host attaches you, as on tmux.
test("sc attach starts the daemon before attaching to a builder on a plugin's host", async () => {
  await skel("1\nsk-ant-oat01-good\n");
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
  print) test -e "$HOME/started" && echo "pid = 1" ;;
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
    `<string>${join(checkout, "bin", "sc")}</string>\n    <string>up</string>`,
  );
  expect(text).toContain("<key>AbandonProcessGroup</key>\n  <true/>");
  expect(text).toContain(`<string>${join(home, "Library", "Logs", "skelcrew.log")}</string>`);
  expect(calls()).toContain("daemon lead");
});

test("says nothing about a laptop sleeping, on a Mac or on Linux", async () => {
  const onLinux = await skel("1\nsk-ant-oat01-good\n");
  expect(onLinux.out).toContain("Skelcrew is set up.\n");
  expect(onLinux.out).not.toContain("sleeps");
  // The Mac's first run starts afresh, as setup doesn't depend on the daemon's service.
  rmSync(config());
  rmSync(token());
  asMac();
  const onMac = await skelOnMac("1\nsk-ant-oat01-good\n");
  expect(onMac.out).toContain("Skelcrew is set up.\n");
  expect(onMac.out).not.toContain("sleeps");
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
  await skelOnMac("1\nsk-ant-oat01-good\n");
  rmSync(join(home, "loaded"));
  rmSync(join(home, "started"));
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac();
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(calls()).toContain(`launchctl bootstrap gui/${uid} ${plist()}\n`);
});

// launchd restarts a daemon that crashed on the definition it loaded, not on the file. So once
// the file changes, such as from an older Skelcrew's sc serve to sc up, launchd must hold the new
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
  await skelOnMac("1\nsk-ant-oat01-good\n");
  const older = readFileSync(plist(), "utf8").replace(
    "<string>up</string>",
    "<string>serve</string>",
  );
  writeFileSync(plist(), older);
  writeFileSync(join(home, "loaded.plist"), older);
  writeFileSync(join(home, "calls"), "");
  const run = await skelOnMac("", `${bin}:/usr/bin`);
  expect(run.err).toBe("");
  const loaded = readFileSync(join(home, "loaded.plist"), "utf8");
  expect(loaded).toBe(readFileSync(plist(), "utf8"));
  expect(loaded).toContain("<string>up</string>");
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

// The offer is the plugin's own question, showing what it runs.
const offer =
  "github 0.1.0 from skelcrew/skelcrew-github is an I/O plugin that provides tracker, forge.";
// The offer's own question, asked before anything is fetched.
const offered =
  "GitHub detected.\n\nThe GitHub plugin lets Skelcrew work with issues, pull requests\nand CI on your repositories.\nAdd it? [Y/n]";

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

// The GitHub plugin is offered where you work on a GitHub repository, and only there, on any run
// until it is installed or you say no.
test("offers the GitHub plugin only in a checkout on github.com, on any run", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishGitHubPlugin();
  const outside = await skel("1\nsk-ant-oat01-good\n");
  expect(outside.code).toBe(0);
  expect(outside.out).not.toContain("GitHub");
  const folder = checkoutWith("app");
  expect((await atTerminal("", folder)).out).not.toContain("GitHub");
  git(folder, "remote", "add", "origin", "git@gitlab.com:simon/app.git");
  expect((await atTerminal("", folder)).out).not.toContain("GitHub");
  git(folder, "remote", "set-url", "origin", "git@github.com:simon/app.git");
  const later = await atTerminal("n\n", folder);
  expect(later.out).toStartWith(offered);
  // A no fetches nothing, so the plugin's own question never comes.
  expect(later.out).not.toContain(offer);
});

test("a no holds for the repository, in every checkout of it, and another repository asks once", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishGitHubPlugin();
  const app = checkoutWith("app", "git@github.com:simon/app.git");
  const first = await atTerminal("n\n1\nsk-ant-oat01-good\n", app);
  expect(first.code).toBe(0);
  expect(first.out).toContain(offered);
  expect(first.out).toContain(
    "Skelcrew won't ask again for simon/app. To install it: sc add -g skelcrew/skelcrew-github",
  );
  // The offer comes before the first step.
  expect(first.out.indexOf(offered)).toBeLessThan(first.out.indexOf("Choose the coding agent"));
  expect(parse(readFileSync(config(), "utf8"))).toMatchObject({
    harness: "claude",
    github_declined: ["simon/app"],
  });
  const again = checkoutWith("app-again", "https://github.com/Simon/app.git");
  expect((await atTerminal("", again)).out).not.toContain("GitHub");
  expect((await atTerminal("", app)).out).not.toContain("GitHub");
  const site = checkoutWith("site", "git@github.com:simon/site.git");
  const other = await atTerminal("n\n", site);
  expect(other.out).toContain(offered);
  expect(parse(readFileSync(config(), "utf8")).github_declined).toEqual([
    "simon/app",
    "simon/site",
  ]);
  // Nothing is written into the repository.
  expect(git(app, "status", "--porcelain")).toBe("");
});

// The offer is asked from the checkout's remote alone, so a no is saved with GitHub out of reach.
test("a no to the offer needs no network, and is saved with GitHub out of reach", async () => {
  noGitHubPlugin();
  // github.com leads to a folder that isn't there, and nothing is published.
  writeFileSync(
    join(home, ".gitconfig"),
    `[url "file://${home}/nowhere/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`,
  );
  await skel("1\nsk-ant-oat01-good\n");
  const app = checkoutWith("app", "git@github.com:simon/app.git");
  const run = await atTerminal("n\n", app);
  expect(run.out).toContain(offered);
  expect(run.out).not.toContain("Couldn't install");
  expect(run.out).toContain("Skelcrew won't ask again for simon/app.");
  expect(parse(readFileSync(config(), "utf8")).github_declined).toEqual(["simon/app"]);
});

test("over --remote, the offer reads the remote sc brought from your laptop", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishGitHubPlugin();
  await skel("1\nsk-ant-oat01-good\n");
  const run = await atTerminal("n\n", home, ["--from", "git@github.com:simon/app.git"]);
  expect(run.out).toContain(offered);
  expect(parse(readFileSync(config(), "utf8")).github_declined).toEqual(["simon/app"]);
});

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

// Enter takes the offer, and Enter again the plugin's own question, which shows what it runs.
// GitHub is then the repository's tracker, so nothing is written into the checkout, and the line
// saying Skelcrew is set up goes straight on to bringing the repository in.
test("a yes installs the GitHub plugin after the offer and its own question, writes nothing here, and the lead opens", async () => {
  const site = siteOnGitHub();
  const run = await atTerminal("\n\n1\nsk-ant-oat01-good\n", site);
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain(offered);
  expect(run.out).toContain(offer);
  expect(run.out).toContain("Install it? [Y/n] Installed github 0.1.0.\n");
  expect(run.out.match(/\[Y\/n\]/g)).toHaveLength(2);
  expect(run.out).not.toContain("[y/N]");
  expect(readFileSync(join(home, "handed"), "utf8")).toBe("https://github.com/simon/site\n");
  expect(run.out).not.toContain("sc init");
  expect(run.out).toContain(
    "Skelcrew is set up.\nKeeping Skelcrew running after you log out or restart.\nCloning simon/site for Skelcrew.\n",
  );
  expect(existsSync(join(site, "skelcrew.yaml"))).toBe(false);
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");
});

test("on a run after setup, a yes installs the plugin and the lead opens, with nothing written here", async () => {
  const site = siteOnGitHub();
  await skel("1\nsk-ant-oat01-good\n");
  const run = await atTerminal("\n\n", site);
  expect(run.err).toBe("");
  expect(run.out).toStartWith("GitHub detected.");
  expect(run.out).toContain("Installed github 0.1.0.");
  expect(run.out).not.toContain("sc init");
  expect(existsSync(join(site, "skelcrew.yaml"))).toBe(false);
  expect(calls()).toEndWith("daemon lead\nscreen on lead\n");
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toStartWith("Skelcrew: Install these first:\n");
  expect(run.err).toContain("sudo apt install tmux");
  expect(run.err).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).not.toContain("bubblewrap");
  expect(calls()).toBe("");
});

test("names git when it is missing, as Skelcrew clones and pushes with it", async () => {
  unlinkSync(join(bin, "git"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toStartWith("Skelcrew: Install these first:\n");
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

// Reviews look at the thread's clone through an overlay, which bubblewrap has only since 0.11.
// Ubuntu 24.04's is 0.9, which would pass every other check and fail every review.
test("refuses a bwrap too old for reviews, before asking anything", async () => {
  bwrapVersion("0.9.0");
  const run = await skel("1\nsk-ant-oat01-good\n");
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
    const run = await skel(`1\n${pasted}\nsk-ant-oat01-good\n`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(why);
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

// Reviews on your own harness save nothing, so only the first run's end shows the question was
// answered. Here your harness has its login before the question is asked.
test("asks about reviews again after a first run stopped at that question", async () => {
  fakeCodex();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  const stopped = await skel("");
  expect(stopped.code).toBe(1);
  expect(stopped.out).toContain("Choose the coding agent for reviews:");
  expect(existsSync(unit())).toBe(false);

  const again = await skel("2\n");
  expect(again.err).toBe("");
  expect(again.code).toBe(0);
  expect(again.out).toContain("Choose the coding agent for reviews:");
  expect(again.out).toContain("Skelcrew is set up.");
  expect((await skel("")).out).not.toContain("for reviews");
});

test("logs the reviewer in to Codex with a login of Skelcrew's own", async () => {
  fakeCodex();
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "\nSign in to Codex for reviews. Press Enter to start.\nSigned in to Codex.\n",
  );
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
  expect(statSync(codexHome()).mode & 0o777).toBe(0o700);
  // The reviewer's login comes before the service.
  expect(calls().indexOf("codex login --device-auth")).toBeLessThan(calls().indexOf("systemctl"));
  expect(run.out.indexOf("Token:")).toBeLessThan(run.out.indexOf("Sign in to Codex"));
});

// Codex's sign-in gets the terminal's alternate screen, so its text never mixes with Skelcrew's,
// which is as it was once Codex ends. Run at a real terminal, in tmux on a socket of its own.
test("at a terminal, Codex signs in on a screen of its own", async () => {
  fakeCodex('echo "Open the link and enter CODE-1"; : > "$CODEX_HOME/auth.json"');
  // The token's question reads keys one by one, through stty.
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
    await waitFor("Number:");
    tmux("send-keys", "-t", "setup", "1", "Enter");
    await waitFor("for a second opinion");
    tmux("send-keys", "-t", "setup", "Enter");
    await waitFor("Token:");
    tmux("send-keys", "-t", "setup", "sk-ant-oat01-good", "Enter");
    await waitFor("Press Enter to start.");
    tmux("send-keys", "-t", "setup", "Enter");
    await waitFor("FINISHED");
    const after = screen();
    expect(after).toContain("Sign in to Codex for reviews. Press Enter to start.");
    expect(after).toContain("Signed in to Codex.");
    expect(after).not.toContain("CODE-1");
    expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
  } finally {
    tmux("kill-server");
  }
}, 60_000);

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
  expect(run.out).toContain("\nCodex isn't installed, so reviews run on Claude Code.\n");
});

test("finishes no setup when the reviewer's login fails, so the next sc tries again", async () => {
  fakeCodex("exit 1");
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("codex login");
  expect(run.out).not.toContain("Signed in to Codex");
  expect(existsSync(unit())).toBe(false);

  fakeCodex();
  writeFileSync(join(home, "calls"), "");
  const again = await skel();
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("Sign in to Claude");
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
  expect(run.out).toContain("\nSign in to Codex. Press Enter to start.\nSigned in to Codex.\n");
  expect(run.out).not.toContain("for reviews");
  expect(run.out).not.toContain("the reviewer");
  expect(readFileSync(config(), "utf8")).toContain("harness: codex");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(calls()).not.toContain("claude");
  expect(existsSync(token())).toBe(false);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("set up");
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

test("picking Codex for agents and reviews where Claude Code is installed too skips Claude's login", async () => {
  fakeCodex();
  const run = await skel("2\n2\n");
  expect(run.code).toBe(0);
  expect(readFileSync(config(), "utf8")).toContain("harness: codex");
  expect(run.out).not.toContain("Sign in to Claude");
  expect(calls()).toContain("codex login --device-auth");
});

test("asks which harness reviews, offering the other one first", async () => {
  fakeCodex();
  const run = await skel("1\n\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  const asked = run.out.slice(run.out.indexOf("Choose the coding agent for reviews:"));
  expect(asked).toStartWith(
    "Choose the coding agent for reviews:\n  1) Codex, for a second opinion\n  2) Claude Code\n",
  );
  expect(parse(readFileSync(config(), "utf8"))).toEqual({
    harness: "claude",
    roles: { reviewer: { harness: "codex" } },
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
  expect(run.out).toContain(
    "Sign in to Claude for reviews. In another terminal, run:\n\n  claude setup-token\n",
  );
  expect(run.out).toContain("Sign in to Codex. Press Enter to start.");
  expect(parse(readFileSync(config(), "utf8"))).toEqual({
    harness: "codex",
    roles: { reviewer: { harness: "claude" } },
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
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
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

// Logging in on a machine is what sc --remote <host> install is for, so --remote never starts it. The laptop
// tells the exit code apart from a failure, and offers to set the machine up.
test("over --remote, a machine whose first run isn't done exits with its own code and takes no step", async () => {
  const run = await skel("", bin, main(), home, { SKELCREW_REMOTE_NAME: "simon@workbox" });
  expect(run.err).toBe("");
  expect(run.code).toBe(97);
  expect(calls()).not.toContain("claude");
});

test("over --remote, a machine that finished its first run attaches as usual", async () => {
  await skel("1\nsk-ant-oat01-good\n");
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
  await skel("1\nsk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  const run = await install();
  expect(run.err).toBe("");
  expect(run.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
});

test("sc install installs your plugins at the version your lock pins after asking, and asks nothing the second time", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0", "0.2.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  writeFileSync(join(home, "calls"), "");
  const first = await install("y\n");
  expect(first.err).toBe("");
  expect(first.out).toContain("fake 0.1.0 from simon/skelcrew-fake is an I/O plugin");
  expect(first.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toBe("fake setup 0.1.0\n");
  const lockBefore = readFileSync(lock(), "utf8");
  writeFileSync(join(home, "calls"), "");
  const second = await install();
  expect(second.out).toBe("Nothing to install: this machine has everything your files ask for.\n");
  expect(calls()).toBe("");
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
});

// Such as when your files come from a laptop where you removed it: the files say what this
// machine runs, so a plugin they don't name goes, with its settings and tokens.
test("sc install removes a plugin from GitHub your files don't name", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  writeFileSync(
    config(),
    readFileSync(config(), "utf8").replace("plugins: [simon/skelcrew-fake]", "plugins: []"),
  );
  writeFileSync(lock(), "");
  expect((await skel("", bin, main(), home, {}, ["plugins"])).out).toBe(
    "fake 0.1.0 io: tracker. sc install removes it.\n",
  );
  const run = await install();
  expect(run.err).toBe("");
  expect(run.out).toContain("Removed fake, with its settings and tokens.");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
  expect((await install()).out).toBe(
    "Nothing to install: this machine has everything your files ask for.\n",
  );
});

// A plugin a repository uses as its forge, and so its tracker, can't go, so the machine doesn't count as set up, and
// sc --remote <host> install fails rather than say it matched your files.
test("sc install fails when a plugin your files don't name can't be removed", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  const db = new Database(join(home, ".local", "share", "skelcrew", "skelcrew.db"));
  db.run(
    "INSERT INTO repositories (owner, repo, name, forge) VALUES ('simon', 'other', 'other', 'fake')",
  );
  db.close();
  writeFileSync(
    config(),
    readFileSync(config(), "utf8").replace("plugins: [simon/skelcrew-fake]", "plugins: []"),
  );
  writeFileSync(lock(), "");
  const run = await install();
  expect(run.code).toBe(1);
  expect(run.out).toContain(
    "Skelcrew couldn't remove fake: fake is the tracker of other, so Skelcrew keeps it.",
  );
  expect(run.out).toContain(
    "Skelcrew isn't set up yet, as this machine still has fake, which your files don't name.",
  );
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(true);
});

test("sc install with no answer to read installs nothing", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  const run = await install("");
  expect(run.code).toBe(1);
  expect(run.err).toContain("Skelcrew left out simon/skelcrew-fake, as each runs its commands");
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
});

test("sc install installs the commit your lock pins, even after its tag moved, and a changed commit asks again", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
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
  // Your lock from another machine pins the new commit, which asks again, and moves the plugin
  // with the lock left as it was.
  writeFileSync(config(), "harness: claude\n");
  lockFake("0.1.0");
  const newLock = readFileSync(lock(), "utf8");
  writeFileSync(join(home, "calls"), "");
  const moved = await install("y\n");
  expect(moved.err).toBe("");
  expect(moved.out).toContain("Update it? [Y/n]");
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
  await skel("1\nsk-ant-oat01-good\n");
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
  expect(run.err).not.toContain("sc update -g");
  expect(readFileSync(lock(), "utf8")).toBe(lockBefore);
});

test("a locked commit the repository no longer has is refused, and sc update -g moves past it", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0", "deadbeef".repeat(5));
  const refused = await install("y\n");
  expect(refused.code).toBe(1);
  expect(refused.err).toContain("simon/skelcrew-fake no longer serves commit deadbeefdead");
  expect(refused.err).toContain("sc update -g moves it to its newest version");
  const updated = await atTerminal("y\n", home, ["update", "-g", "fake"]);
  expect(updated.err).toBe("");
  expect(updated.out).toContain("Installed fake 0.1.0.");
  expect(readFileSync(lock(), "utf8")).toContain(fakeCommit("0.1.0"));
  expect((await install()).out).toContain("Nothing to install");
});

test("sc update -g moves an installed plugin to its tag's new commit, after asking", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  await install("y\n");
  expect((await atTerminal("", home, ["update", "-g", "fake"])).out).toContain(
    "fake is at its newest version, 0.1.0.",
  );
  publishFake("0.1.0");
  writeFileSync(join(home, "calls"), "");
  const moved = await atTerminal("y\n", home, ["update", "-g", "fake"]);
  expect(moved.err).toBe("");
  expect(moved.out).toContain("Update it? [Y/n]");
  expect(calls()).toBe("fake setup 0.1.0\n");
  expect(readFileSync(lock(), "utf8")).toContain(fakeCommit("0.1.0"));
});

test("sc install without a terminal installs nothing, even with a yes piped in, and names each plugin left out", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  publishPlugin("bar", "0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  writeFileSync(
    config(),
    readFileSync(config(), "utf8").replace(
      "plugins: [simon/skelcrew-fake]",
      "plugins: [simon/skelcrew-fake, simon/skelcrew-bar]",
    ),
  );
  const run = await skel("y\n", bin, main(), home, {}, ["install"]);
  expect(run.out).toContain("There is no terminal to answer in");
  // It fails, so a script running it can tell the machine doesn't match your files.
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "Skelcrew left out simon/skelcrew-fake, simon/skelcrew-bar, as each runs its commands, which needs your yes at a terminal",
  );
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
  expect(existsSync(join(home, ".local", "share", "skelcrew", "plugins", "bar"))).toBe(false);
});

// The harness and its login are there, as copied from another machine, and only the service is
// missing. Bun's own prompts read ahead of piped input, so this keeps the plugin's question first.
// An older release marked the machine set up at the first run's end, without ever installing the
// plugins your files name, so plain sc after an upgrade still runs sc install once.
test("plain sc on a machine set up by an older release installs the plugins your files name", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  // The older release left only its own mark, and a release update its note beside it.
  const data = join(home, ".local", "share", "skelcrew");
  rmSync(join(data, "install-done"));
  expect(existsSync(join(data, "set-up"))).toBe(true);
  writeFileSync(join(data, "installed"), "0.2.0\n");
  lockFake("0.1.0");
  const run = await atTerminal("y\n");
  expect(run.err).toBe("");
  expect(run.out).toContain("Install it? [Y/n]");
  expect(run.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toContain("fake setup 0.1.0\n");
  expect(existsSync(join(data, "install-done"))).toBe(true);
  // The release update's note is left as it was, for the next sc to tell you about.
  expect(readFileSync(join(data, "installed"), "utf8")).toBe("0.2.0\n");
  // A daemon starting deletes that note, which leaves sc install done: plain sc asks nothing.
  rmSync(join(data, "installed"));
  const later = await atTerminal("");
  expect(later.err).toBe("");
  expect(later.out).not.toContain("[Y/n]");
  expect(later.out).not.toContain("Nothing to install");
});

test("plain sc on a machine that isn't set up installs your plugins too", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  lockFake("0.1.0");
  const run = await atTerminal("y\n");
  expect(run.err).toBe("");
  expect(run.out).toContain("Installed fake 0.1.0.");
  expect(calls()).toContain("fake setup 0.1.0\n");
});

// A plugin that fails to install leaves the machine not set up, so the next plain sc tries again.
test("after a first run whose plugin failed to install, plain sc installs it again", async () => {
  noGitHubPlugin();
  fakeGitHub();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  // The plugin isn't published yet, so fetching it fails.
  appendFileSync(config(), "plugins: [simon/skelcrew-fake]\n");
  const failed = await atTerminal("y\n");
  expect(failed.code).not.toBe(0);
  expect(failed.out).not.toContain("Skelcrew is set up.");
  publishFake("0.1.0");
  const retried = await atTerminal("y\n");
  expect(retried.err).toBe("");
  expect(retried.out).toContain("Installed fake 0.1.0.");
  expect(retried.out).toContain("Skelcrew is set up.");
  expect(calls()).toContain("fake setup 0.1.0\n");
});

// A plugin you said no to is still named in your files, so the machine isn't set up until it is in.
test("after a first run where you said no to a plugin, plain sc asks again", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  lockFake("0.1.0");
  const declined = await atTerminal("n\n");
  expect(declined.out).toContain("Skelcrew didn't install fake.");
  expect(declined.out).toContain(
    "Skelcrew isn't set up yet, as your config.yaml names simon/skelcrew-fake, which this machine doesn't have at the version your lock pins. Plain sc asks again.",
  );
  expect(declined.out).not.toContain("Skelcrew is set up.");
  const asked = await atTerminal("y\n");
  expect(asked.err).toBe("");
  expect(asked.out).toContain("Install it? [Y/n]");
  expect(asked.out).toContain("Installed fake 0.1.0.");
  expect(asked.out).toContain("Skelcrew is set up.");
});

// A machine already set up loses its mark when a plugin newly named in your files is declined.
test("on a machine already set up, a declined plugin your files name makes plain sc ask again", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  const declined = await install("n\n");
  expect(declined.out).toContain("Skelcrew didn't install fake.");
  expect(declined.out).toContain("Skelcrew isn't set up yet");
  // A plugin left out fails sc install, so sc --remote doesn't go on to the command you asked for.
  expect(declined.code).toBe(1);
  const asked = await atTerminal("y\n");
  expect(asked.err).toBe("");
  expect(asked.out).toContain("Install it? [Y/n]");
  expect(asked.out).toContain("Installed fake 0.1.0.");
  // Installed, it is asked about no more.
  expect((await atTerminal("")).out).not.toContain("[Y/n]");
});

// A failed sc install takes the mark away too, so plain sc tries again.
test("on a machine already set up, sc install failing for want of a terminal makes plain sc ask again", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  await skel("1\nsk-ant-oat01-good\n");
  lockFake("0.1.0");
  const failed = await skel("", bin, main(), home, {}, ["install"]);
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("Skelcrew left out simon/skelcrew-fake");
  const asked = await atTerminal("y\n");
  expect(asked.err).toBe("");
  expect(asked.out).toContain("Install it? [Y/n]");
  expect(asked.out).toContain("Installed fake 0.1.0.");
});

// On a new machine your files decide which GitHub plugin it gets, so the offer, which would
// install its newest version, isn't made.
test("in a GitHub checkout, files that name the GitHub plugin skip the offer, and sc install gets the locked commit", async () => {
  const site = siteOnGitHub();
  await skel("1\nsk-ant-oat01-good\n");
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
  expect(run.out).not.toContain("GitHub detected");
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
  await skel("1\nsk-ant-oat01-good\n");
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
test("sc install leaves every pin as it is and adds a pin for a plugin your lock lacks", async () => {
  noGitHubPlugin();
  fakeGitHub();
  publishFake("0.1.0");
  publishPlugin("other", "0.1.0", "0.2.0");
  await skel("1\nsk-ant-oat01-good\n");
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
  expect(run.out).toContain("Installed other 0.2.0.");
  expect(calls()).toBe("fake setup 0.1.0\nother setup 0.2.0\n");
  // The existing pin and its comment are as they were, and the new pin follows them.
  const now = readFileSync(lock(), "utf8");
  expect(now).toStartWith(pinned);
  const other = git(
    join(home, "github", "simon", "skelcrew-other"),
    "rev-parse",
    "v0.2.0^{commit}",
  );
  expect(parse(now)).toEqual({
    "simon/skelcrew-fake": { name: "fake", version: "0.1.0", commit: fakeCommit("0.1.0") },
    "simon/skelcrew-other": { name: "other", version: "0.2.0", commit: other },
  });
  expect((await install()).out).toContain("Nothing to install");
});
