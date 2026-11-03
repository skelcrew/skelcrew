// The first plain skel on a machine, run as you would run it, against fake tools.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home = "";
let bin = "";
let checkout = "";
let daemon: Server | undefined;
const main = () => join(checkout, "src", "main.ts");

// A copy of skel to run, since the service refuses to point into a worktree, where tests
// usually run.
function copySkel(to: string): void {
  const from = join(import.meta.dir, "..");
  mkdirSync(to, { recursive: true });
  for (const part of ["bin", "src", "package.json"])
    cpSync(join(from, part), join(to, part), { recursive: true });
  symlinkSync(join(from, "node_modules"), join(to, "node_modules"));
}

// Stands in for skel's daemon on its socket. Like the real one, it answers only once
// systemd has started it.
function fakeDaemon(): Promise<Server> {
  const server = createServer((connection) =>
    connection.on("data", (data) => {
      if (!existsSync(join(home, "started"))) return connection.destroy();
      const asked = String(JSON.parse(data.toString()).command);
      appendFileSync(join(home, "calls"), `daemon ${asked}\n`);
      connection.end(asked === "lead" ? '{"lead":true}\n' : '{"running":true,"pid":1}\n');
    }),
  );
  return new Promise((listening) =>
    server.listen(join(home, "run", "skel.sock"), () => listening(server)),
  );
}

// Each fake writes its calls to a log, so a test can see what skel ran.
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
  fake(
    "gh",
    `case "$1 $2" in
  "auth status") test -f "$HOME/gh-login" ;;
  "auth login") : > "$HOME/gh-login" ;;
  "repo view") echo '{"name":"app","owner":{"login":"simon"},"viewerPermission":"READ","isFork":false}' ;;
esac`,
  );
  fake("claude", `test "$1" = setup-token && echo 'Your token: sk-ant-oat01-good'`);
  fake(
    "systemctl",
    `case "$*" in
  "--user start skel"|"--user enable --now skel") : > "$HOME/started" ;;
esac`,
  );
  fake("loginctl", "exit 0");
  daemon = await fakeDaemon();
});
afterEach(() => {
  daemon?.close();
  rmSync(home, { recursive: true, force: true });
});

function repository(): string {
  const path = join(home, "code", "app");
  mkdirSync(path, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", path]);
  Bun.spawnSync(["git", "-C", path, "remote", "add", "origin", "https://github.com/simon/app"]);
  return path;
}

function calls(): string {
  const log = join(home, "calls");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
}

const config = () => join(home, ".config", "skel", "config.yaml");
const token = () => join(home, ".config", "skel", "claude-token");
const unit = () => join(home, ".config", "systemd", "user", "skel.service");

async function skel(typed = "", path = bin, program = main()) {
  const run = Bun.spawn([process.execPath, program], {
    env: { PATH: path, HOME: home, XDG_RUNTIME_DIR: join(home, "run"), TMPDIR: join(home, "tmp") },
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
  expect(calls()).toContain("gh auth login");
  expect(first.out).toContain("Claude Code");
  expect(first.out).toContain("done");
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
  expect(calls()).toContain("claude setup-token");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
  expect(statSync(token()).mode & 0o777).toBe(0o600);

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.err).toBe("");
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("Claude Code");
  expect(second.out).not.toContain("Setup is done.");
  // Once set up, skel checks no tools, asks GitHub nothing and leaves systemd alone, so it
  // starts fast.
  expect(calls()).toBe("daemon lead\ntmux -L skel attach -t =lead\n");
});

test("installs the daemon as a systemd user service with lingering, once", async () => {
  const first = await skel("1\nsk-ant-oat01-good\n");
  expect(first.code).toBe(0);
  const skelBin = join(checkout, "bin", "skel");
  const written = readFileSync(unit(), "utf8");
  expect(written).toContain(`ExecStart="${skelBin}" serve`);
  expect(written).toContain("Restart=on-failure");
  // systemd would otherwise end the tmux server, and every agent, with the daemon.
  expect(written).toContain("KillMode=process");
  expect(written).toContain(`Environment="PATH=${bin}"`);
  expect(calls()).toContain(
    "systemctl --user daemon-reload\nsystemctl --user enable --now skel\nloginctl enable-linger\n",
  );
  expect(first.out).toContain("log out");

  writeFileSync(join(home, "calls"), "");
  await skel();
  expect(calls()).not.toContain("systemctl --user enable");
  expect(calls()).not.toContain("loginctl");
});

test("installs the service on a machine set up before skel had one", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  writeFileSync(token(), "sk-ant-oat01-good\n");
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel();
  expect(run.code).toBe(0);
  expect(existsSync(unit())).toBe(true);
  expect(calls()).toContain("systemctl --user enable --now skel");
  expect(calls()).not.toContain("claude setup-token");
});

test("installs no service when systemctl fails, so the next skel tries again", async () => {
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
  expect(calls()).toBe("systemctl --user start skel\ndaemon lead\ntmux -L skel attach -t =lead\n");
});

test("shows why when the daemon can't start the lead", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  writeFileSync(join(home, "calls"), "");
  daemon?.close();
  daemon = createServer((connection) =>
    connection.on("data", () => connection.end('{"error":"the lead exited: no login"}\n')),
  );
  await new Promise<void>((listening) => daemon?.listen(join(home, "run", "skel.sock"), listening));
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
  expect(calls()).toBe(
    "systemctl --user daemon-reload\ndaemon lead\ntmux -L skel attach -t =lead\n",
  );
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

test("refuses to install a service that runs skel from a worktree", async () => {
  const worktree = join(home, "code", "skel", ".claude", "worktrees", "daemon");
  copySkel(worktree);
  const run = await skel("1\nsk-ant-oat01-good\n", bin, join(worktree, "src", "main.ts"));
  expect(run.code).toBe(1);
  expect(run.err).toContain("main checkout");
  expect(existsSync(unit())).toBe(false);
});

test("still says how to add a repository after setup, while none is added", async () => {
  await skel("1\nsk-ant-oat01-good\n");
  const again = await skel();
  expect(again.code).toBe(0);
  expect(again.out).toContain("skel init");
});

test("says how to add a repository while none is added", async () => {
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("skel init");
  expect(run.out).toContain("Setup is done.");
});

test("says nothing about adding a repository once one is added", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const path = repository();
  const added = Bun.spawnSync([process.execPath, main(), "init", path], {
    env: { PATH: bin, HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    stdin: new Blob(["y\n\n\n"]),
  });
  expect(added.exitCode).toBe(0);
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("trust");
  expect(run.out).not.toContain("skel init");
  expect(run.out).toContain("Setup is done.");
});

test("skips the GitHub login when gh is logged in already", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("gh auth status");
  expect(calls()).not.toContain("gh auth login");
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toContain("sudo apt install tmux");
  expect(run.err).toContain("curl -fsSL https://claude.ai/install.sh | bash");
  expect(run.err).not.toContain("bubblewrap");
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
  expect(run.err).toContain(`profile skel-bwrap ${real} `);
  expect(run.err).toContain("include if exists <local/skel-bwrap>");
  expect(run.err).toContain("/etc/apparmor.d/skel-bwrap");
  expect(run.err).not.toContain("/etc/apparmor.d/bwrap ");
  expect(calls()).not.toContain("gh");
});

test("asks for a token when the harness is saved but no token is", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "harness: claude\n");
  const run = await skel("sk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("claude setup-token");
  expect(readFileSync(token(), "utf8").trim()).toBe("sk-ant-oat01-good");
});

for (const pasted of ["sk-ant-api03-key", "sk-ant-oat01-good sk-ant-oat01-again"]) {
  test(`doesn't save a token that isn't one from setup-token: ${pasted}`, async () => {
    const run = await skel(`1\n${pasted}\n`);
    expect(run.code).toBe(1);
    expect(run.err).toContain("sk-ant-oat");
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
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
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
    mkdirSync(join(home, ".config", "skel"), { recursive: true });
    writeFileSync(config(), broken);
    writeFileSync(join(home, "gh-login"), "");
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
    writeFileSync(join(home, "gh-login"), "");
    const run = await skel(typed);
    expect(run.code).toBe(1);
    expect(run.out).toContain("Claude Code");
    expect(existsSync(config())).toBe(false);
  });
}

test("refuses a config.yaml it can't read", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "harness: [1, 2]\n");
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("config.yaml");
});

test("Enter at the harness question picks Claude Code", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel("\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");
});
