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
  renameSync,
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
      const request = JSON.parse(data.toString());
      const asked = String(request.command);
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

function calls(): string {
  const log = join(home, "calls");
  // The long tmux line that opens the screen is cut to the agent it opens on.
  const said = existsSync(log) ? readFileSync(log, "utf8") : "";
  return said
    .replace(/tmux -L skel -f \/dev\/null source-file -\n/g, "")
    .replace(/tmux -L skel-screen .* sh skel (\S+) ;.*/g, "screen on $1");
}

const config = () => join(home, ".config", "skel", "config.yaml");
const token = () => join(home, ".config", "skel", "claude-token");
const unit = () => join(home, ".config", "systemd", "user", "skel.service");

async function skel(
  typed = "",
  path = bin,
  program = main(),
  cwd = home,
  more: Record<string, string> = {},
) {
  const run = Bun.spawn([process.execPath, program], {
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
  expect(calls()).toContain("gh auth login");
  expect(first.out).toContain("Claude Code");
  // skel marks where it speaks again, so its lines stand apart from what gh and claude
  // print, and numbers only the steps it takes.
  const said = [
    "skel · step 1 of 3: connect to GitHub\n",
    "skel · connected to GitHub.\n",
    "skel · step 2 of 3: pick a harness\n",
    "skel · step 3 of 3: log agents in to Claude\n",
    `──── Claude Code ${"─".repeat(63)}\n`,
    "Your token: sk-ant-oat01-good\n",
    `──── back in skel ${"─".repeat(62)}\n`,
    "skel · paste the token Claude printed above (it starts with sk-ant-oat01-):",
    "skel · setup is done.\n",
  ];
  // Each line comes after the one before, so a rule found is the one for its own step.
  let at = 0;
  for (const line of said) {
    at = first.out.indexOf(line, at);
    expect([line, at]).not.toEqual([line, -1]);
  }
  expect(first.out).toContain("──── gh ─");
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
  // Once set up, skel checks no tools, asks GitHub nothing and leaves systemd alone, so it
  // starts fast.
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
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

// skel takes a machine with sprite-env, the Sprite's own tool, on its PATH for a Sprite. Like
// the real one, it starts a service as it creates it.
function onSprite(): void {
  fake(
    "sprite-env",
    `case "$*" in
  "services get skel") test -f "$HOME/service" ;;
  "services create skel "*) : > "$HOME/service"; : > "$HOME/started" ;;
  "services start skel") : > "$HOME/started" ;;
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
    `sprite-env services create skel --cmd ${join(checkout, "bin", "skel")} --args serve --no-stream\n`,
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
  expect(calls()).toContain("sprite-env services start skel\ndaemon lead\n");
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
  expect(calls()).toBe("systemctl --user start skel\ndaemon lead\nscreen on lead\n");
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
test("refuses to install a service that runs skel from a worktree", async () => {
  const worktree = join(home, "code", "skel", ".claude", "worktrees", "12");
  copySkel(worktree);
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../.git/worktrees/12\n");
  const run = await skel("1\nsk-ant-oat01-good\n", bin, join(worktree, "src", "main.ts"));
  expect(run.code).toBe(1);
  expect(run.err).toContain("main checkout");
  expect(existsSync(unit())).toBe(false);
});

test("skips the GitHub login when gh is logged in already", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("gh auth status");
  expect(calls()).not.toContain("gh auth login");
  expect(run.out).toContain("skel · step 1 of 2: pick a harness\n");
  expect(run.out).not.toContain("connect to GitHub");
});

test("names each missing tool with what to install, and runs nothing else", async () => {
  unlinkSync(join(bin, "tmux"));
  unlinkSync(join(bin, "claude"));
  const run = await skel();
  expect(run.code).toBe(1);
  expect(run.err).toStartWith("skel: install these first:\n");
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

for (const [pasted, why] of [
  ["sk-ant-api03-key", "that doesn't start with sk-ant-oat"],
  ["sk-ant-oat01-good sk-ant-oat01-again", "that has spaces"],
  [" ", "nothing was pasted"],
]) {
  test(`asks again for a token that isn't one from setup-token: ${JSON.stringify(pasted)}`, async () => {
    const run = await skel(`1\n${pasted}\nsk-ant-oat01-good\n`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`skel · ${why}`);
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

const codexHome = () => join(home, ".local", "share", "skel", "codex");

// A login counts once Codex saved one in skel's own folder, never yours in ~/.codex.
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

test("logs the reviewer in to Codex with a login of skel's own", async () => {
  fakeCodex();
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(run.out).toContain("skel · step 4 of 4: log the reviewer in to Codex\n");
  expect(run.out).toContain("skel · the reviewer is logged in to Codex.\n");
  expect(calls()).toContain(`codex login --device-auth\nCODEX_HOME=${codexHome()}\n`);
  expect(existsSync(join(codexHome(), "auth.json"))).toBe(true);
  expect(statSync(codexHome()).mode & 0o777).toBe(0o700);
  // The token comes before the reviewer's login, and the service after it.
  const order = ["claude setup-token", "codex login --device-auth", "systemctl"];
  const at = order.map((call) => calls().indexOf(call));
  expect(at).toEqual([...at].sort((a, b) => a - b));
});

test("skips the reviewer's login when skel's Codex login works already", async () => {
  fakeCodex();
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), "auth.json"), "{}");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(calls()).toContain("codex login status");
  expect(calls()).not.toContain("codex login --device-auth");
});

test("says reviews run on Claude Code when Codex isn't installed", async () => {
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "skel · Codex isn't installed, so reviews will run on Claude Code, on the builder's own model",
  );
  expect(run.out).toContain("step 3 of 3");
  expect(run.out).toContain("second view");
});

test("finishes no setup when the reviewer's login fails, so the next skel tries again", async () => {
  fakeCodex("exit 1");
  const run = await skel("1\nsk-ant-oat01-good\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("codex login");
  // The way back is marked even when the tool fails.
  expect(run.out).toEndWith(`\n\n──── back in skel ${"─".repeat(62)}\n`);
  expect(existsSync(unit())).toBe(false);

  fakeCodex();
  writeFileSync(join(home, "calls"), "");
  const again = await skel();
  expect(again.code).toBe(0);
  expect(calls()).not.toContain("claude setup-token");
  expect(calls()).toContain("codex login --device-auth");
  expect(existsSync(unit())).toBe(true);
});

// Ubuntu's ~/.bashrc stops early in a shell nobody types into, so a folder it adds, such as
// nvm's, is known to your terminal but not to a command run over ssh, as skel --remote runs.
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
  const run = await skel("1\nsk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.err).toBe("");
  expect(run.code).toBe(0);
  expect(calls()).toContain("claude setup-token");
  // Without it, reviews would quietly run on Claude Code.
  expect(calls()).toContain("codex login --device-auth");
  expect(servicePath()).toContain(nvm);
  expect(servicePath()).toContain(bin);
});

test("keeps the login shell's folders in the service when skel runs over ssh again", async () => {
  fakeCodex();
  const nvm = onlyLoginShellKnows(["claude", "codex"]);
  await skel("1\nsk-ant-oat01-good\n", bin, main(), home, { SHELL: "/bin/bash" });
  writeFileSync(join(home, "calls"), "");
  const run = await skel("", bin, main(), home, { SHELL: "/bin/bash" });
  expect(run.code).toBe(0);
  expect(servicePath()).toContain(nvm);
  expect(calls()).toBe("daemon lead\nscreen on lead\n");
});

// skel remote add runs this on the machine it sets up, and leaves connecting to you.
test("skel first-run takes the steps and installs the service, without attaching", async () => {
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
