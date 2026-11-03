// The first plain skel on a machine, run as you would run it, against fake tools.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";
let bin = "";

// Each fake writes its calls to a log, so a test can see what skel ran.
function fake(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`, {
    mode: 0o755,
  });
}

function loggedOutOfClaude(): void {
  fake("claude", `echo '{"loggedIn":false}'; exit 1`);
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-setup-test-")));
  bin = join(home, "bin");
  mkdirSync(bin);
  // PATH holds only this folder, so a test can take a tool away.
  symlinkSync(Bun.which("git") ?? "git", join(bin, "git"));
  fake("tmux", "exit 0");
  fake("bwrap", "exit 0");
  fake(
    "gh",
    `case "$1 $2" in
  "auth status") test -f "$HOME/gh-login" ;;
  "auth login") : > "$HOME/gh-login" ;;
  "repo view") echo '{"name":"app","owner":{"login":"simon"}}' ;;
esac`,
  );
  fake("claude", `echo '{"loggedIn":true,"authMethod":"claude.ai"}'`);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

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

async function skel(typed = "") {
  const run = Bun.spawn([process.execPath, main], {
    env: { PATH: bin, HOME: home },
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
  const first = await skel("1\n");
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(calls()).toContain("gh auth login");
  expect(first.out).toContain("Claude Code");
  expect(first.out).toContain("done");
  expect(readFileSync(config(), "utf8")).toContain("harness: claude");

  writeFileSync(join(home, "calls"), "");
  const second = await skel();
  expect(second.err).toBe("");
  expect(second.code).toBe(0);
  expect(second.out).not.toContain("Claude Code");
  expect(second.out).toContain("done");
  expect(calls()).not.toContain("gh auth login");
});

test("says how to add a repository while none is added", async () => {
  const run = await skel("1\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("skel init");
  expect(run.out).toContain("Setup is done.");
});

test("says nothing about adding a repository once one is added", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const path = repository();
  const added = Bun.spawnSync([process.execPath, main, "repo", "add", path], {
    env: { PATH: bin, HOME: home },
    stdin: new Blob(["y\n"]),
  });
  expect(added.exitCode).toBe(0);
  const run = await skel("1\n");
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("trust");
  expect(run.out).not.toContain("skel init");
  expect(run.out).toContain("Setup is done.");
});

test("skips the GitHub login when gh is logged in already", async () => {
  writeFileSync(join(home, "gh-login"), "");
  const run = await skel("1\n");
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

test("doesn't save a harness while Claude Code is logged out", async () => {
  loggedOutOfClaude();
  const run = await skel("1\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("run claude");
  expect(existsSync(config())).toBe(false);
});

test("keeps the other settings in config.yaml", async () => {
  mkdirSync(join(home, ".config", "skel"), { recursive: true });
  writeFileSync(config(), "# mine\ncolor: blue\n");
  const run = await skel("1\n");
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
    const run = await skel("1\n");
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
  const run = await skel("1\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("config.yaml");
});
