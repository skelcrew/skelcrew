// skel --remote, run as you would run it on your laptop, against a fake ssh and scp that
// play a server in a folder of the test, and a fake bun that builds a stand-in skel.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";

// The skel the fake bun builds: it says what reached it, one argument per line, so a test
// can see that each one arrived exactly as typed.
const serverSkel = `#!/bin/sh
echo "skel on the server got $# arguments"
for word in "$@"; do echo "[$word]"; done
exit 3
`;

function fake(name: string, body: string): void {
  writeFileSync(
    join(home, "bin", name),
    `#!/bin/sh\necho "${name} $*" >> "$HOME/calls"\n${body}\n`,
    {
      mode: 0o755,
    },
  );
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-remote-test-")));
  for (const folder of ["bin", "server", "serverbin", "tmp"]) mkdirSync(join(home, folder));
  // Like ssh, it joins the words after the host into one line for the server's shell, which
  // runs in the server's home with the bare PATH a command over ssh gets. serverbin comes
  // first, so the server's systemctl is a fake and never the real one of this machine.
  fake(
    "ssh",
    `test "$1" = -t && shift
shift
bin="$HOME/serverbin"
cd "$HOME/server" && HOME="$HOME/server" PATH="$bin:/usr/bin:/bin" exec sh -c "$*"`,
  );
  writeFileSync(
    join(home, "serverbin", "systemctl"),
    `#!/bin/sh\necho "systemctl $*" >> "${join(home, "calls")}"\n`,
    { mode: 0o755 },
  );
  fake("scp", `test -f "$HOME/scp-fails" && exit 1\ncp "$1" "$HOME/server/\${2#*:}"`);
  fake(
    "bun",
    `while [ $# -gt 1 ]; do test "$1" = --outfile && out=$2; shift; done
cat > "$out" <<'EOF'
${serverSkel}EOF
chmod +x "$out"`,
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Puts a skel on the server where a copy would put it.
function installed(): void {
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  writeFileSync(join(home, "server", ".local", "bin", "skel"), serverSkel, { mode: 0o755 });
}

// Returns a checkout whose origin is the given GitHub repository.
function checkout(full: string): string {
  const folder = join(home, "app");
  mkdirSync(folder);
  Bun.spawnSync(["git", "init", "-q", folder]);
  Bun.spawnSync(["git", "-C", folder, "remote", "add", "origin", `git@github.com:${full}.git`]);
  return folder;
}

async function skel(args: string[], typed = "", cwd = home) {
  const run = Bun.spawn([process.execPath, main, ...args], {
    cwd,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
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

const calls = () =>
  existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8") : "";

test("runs skel on the server with the repository you are in", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox"], "", checkout("simon/app"));
  expect(calls()).toBe(
    'ssh -t simon@workbox env PATH="$HOME/.local/bin:$PATH" skel --from simon/app\n',
  );
  expect(run.out).toBe("skel on the server got 2 arguments\n[--from]\n[simon/app]\n");
  // What skel exits with on the server is what skel exits with here.
  expect(run.code).toBe(3);
});

test("passes no repository from outside one", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox"]);
  expect(calls()).toBe('ssh -t simon@workbox env PATH="$HOME/.local/bin:$PATH" skel\n');
  expect(run.out).toBe("skel on the server got 0 arguments\n");
});

test("a command reaches the server exactly as typed", async () => {
  installed();
  const body = "Don't crash; it's \"bad\" when $HOME * `x` \\ happens\nTwice.";
  const run = await skel(
    ["--remote", "simon@workbox", "task", "create", "app", "Fix it", body, ""],
    "",
    checkout("simon/app"),
  );
  expect(run.out).toBe(
    `skel on the server got 6 arguments\n[task]\n[create]\n[app]\n[Fix it]\n[${body}]\n[]\n`,
  );
});

test("offers to copy skel to a server without it, then runs the command", async () => {
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.out).toContain("skel isn't installed on simon@workbox.");
  expect(run.out).toContain("Copy it to ~/.local/bin/skel there? [y/N]");
  expect(run.out).toEndWith("skel on the server got 1 arguments\n[ps]\n");
  const lines = calls().split("\n");
  expect(lines[0]).toBe('ssh -t simon@workbox env PATH="$HOME/.local/bin:$PATH" skel ps');
  // Built for the server, which is Linux, whatever the laptop runs.
  expect(lines[1]).toMatch(
    new RegExp(
      `^bun build --compile --target=bun-linux-x64 ${main} --outfile ${home}/tmp/\\S+/skel$`,
    ),
  );
  expect(lines[2]).toBe("ssh simon@workbox mkdir -p .local/bin && rm -f .local/bin/skel.new");
  expect(lines[3]).toMatch(
    new RegExp(`^scp ${home}/tmp/\\S+/skel simon@workbox:.local/bin/skel.new$`),
  );
  expect(lines[4]).toBe("ssh simon@workbox mv -f .local/bin/skel.new .local/bin/skel");
  expect(lines[5]).toBe(lines[0]);
  expect(readFileSync(join(home, "server", ".local", "bin", "skel"), "utf8")).toBe(serverSkel);
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

// A link left at ~/.local/bin/skel, such as one to a checkout's launcher that can't find bun
// over ssh, must be replaced, not written through: a copy through it would overwrite the
// checkout's own file.
test("replaces a link at ~/.local/bin/skel instead of writing through it", async () => {
  const launcher = join(home, "server", "checkout", "bin", "skel");
  mkdirSync(join(home, "server", "checkout", "bin"), { recursive: true });
  const original = "#!/bin/sh\nexec no-such-bun main.ts\n";
  writeFileSync(launcher, original, { mode: 0o755 });
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  symlinkSync(launcher, join(home, "server", ".local", "bin", "skel"));
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.out).toEndWith("skel on the server got 1 arguments\n[ps]\n");
  expect(readFileSync(launcher, "utf8")).toBe(original);
  expect(lstatSync(join(home, "server", ".local", "bin", "skel")).isSymbolicLink()).toBe(false);
});

test("copies nothing when you say no", async () => {
  const run = await skel(["--remote", "simon@workbox", "ps"], "n\n");
  expect(run.out).toContain("skel isn't installed on simon@workbox.");
  expect(run.out).toContain("skel isn't on simon@workbox, so the command didn't run.");
  expect(run.code).toBe(1);
  expect(calls()).toBe('ssh -t simon@workbox env PATH="$HOME/.local/bin:$PATH" skel ps\n');
});

test("needs a host", async () => {
  const run = await skel(["--remote"]);
  expect(run.err).toContain("skel --remote <host> [command]");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

// A command over ssh gets a bare PATH without ~/.bun/bin, where Bun's installer puts bun, so a
// link to the checkout's launcher in ~/.local/bin must still find it.
test("the checkout's launcher finds bun in ~/.bun/bin when it isn't on the PATH", () => {
  mkdirSync(join(home, ".bun", "bin"), { recursive: true });
  writeFileSync(join(home, ".bun", "bin", "bun"), '#!/bin/sh\necho "bun got $*"\n', {
    mode: 0o755,
  });
  const launcher = join(import.meta.dir, "..", "bin", "skel");
  const run = Bun.spawnSync(["/bin/sh", launcher, "ps"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  const script = `${realpathSync(join(import.meta.dir, "..", "bin"))}/../src/main.ts`;
  expect(run.stdout.toString()).toBe(`bun got ${script} ps\n`);
});

// Returns a skel checkout of its own on the laptop, on main with one commit, so a test knows
// what update copies and from where.
function laptopSkel(): { main: string; commit: string } {
  const folder = join(home, "code", "skel");
  cpSync(join(import.meta.dir, "..", "src"), join(folder, "src"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(folder, "node_modules"));
  writeFileSync(join(folder, ".gitignore"), "node_modules\n");
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t", ...args], {
      stdout: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "skel");
  return {
    main: join(folder, "src", "main.ts"),
    commit: git("rev-parse", "--short", "HEAD").stdout.toString().trim(),
  };
}

async function update(laptop: { main: string }) {
  const run = Bun.spawn([process.execPath, laptop.main, "update", "--remote", "simon@workbox"], {
    cwd: home,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
    stdin: "ignore",
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

test("update replaces skel on the server and restarts its daemon", async () => {
  installed();
  const laptop = laptopSkel();
  const run = await update(laptop);
  expect(run.code).toBe(0);
  const lines = calls().split("\n");
  expect(lines).toContain("ssh simon@workbox mv -f .local/bin/skel.new .local/bin/skel");
  expect(lines.some((line) => line.startsWith("scp "))).toBe(true);
  // The daemon restarts only once the new skel is in place, so it runs the new build.
  expect(lines.at(-3)).toBe("ssh simon@workbox systemctl --user restart skel");
  expect(lines.at(-2)).toBe("systemctl --user restart skel");
  expect(run.out).toContain(
    `skel · updated simon@workbox to the skel in ~/code/skel (commit ${laptop.commit}) and restarted its daemon.`,
  );
  expect(run.out).toContain("the lead picks up new instructions when it's next started");
  expect(run.out).not.toContain("uncommitted");
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

// What gets copied is the laptop's checkout as it is, so you hear when that isn't main.
test("update warns about uncommitted changes and another branch, and still copies", async () => {
  installed();
  const laptop = laptopSkel();
  const folder = join(home, "code", "skel");
  Bun.spawnSync(["git", "-C", folder, "checkout", "-q", "-b", "try"]);
  writeFileSync(join(folder, "src", "new.ts"), "");
  const run = await update(laptop);
  expect(run.code).toBe(0);
  expect(run.out).toContain("skel · ~/code/skel has uncommitted changes, and they are copied too.");
  expect(run.out).toContain("skel · ~/code/skel is on try, not main.");
  expect(calls()).toContain("systemctl --user restart skel");
});

// A server where ~/.local/bin/skel links into a checkout updates with git pull there, and a
// copy would leave the checkout behind while the daemon kept running it.
test("update leaves skel run from a checkout on the server alone, and says how to update it", async () => {
  const checkout = join(home, "server", "skel");
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, ".git"));
  writeFileSync(join(checkout, "bin", "skel"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  symlinkSync(join(checkout, "bin", "skel"), join(home, "server", ".local", "bin", "skel"));
  const run = await update(laptopSkel());
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    `skel · skel on simon@workbox runs from a checkout at ${checkout}, so it wasn't replaced.`,
  );
  expect(run.out).toContain("git pull there updates it");
  expect(run.out).toContain("systemctl --user restart skel");
  expect(calls()).not.toContain("scp");
  expect(calls()).not.toContain("systemctl --user restart");
  expect(lstatSync(join(home, "server", ".local", "bin", "skel")).isSymbolicLink()).toBe(true);
});

// A transfer that breaks off must leave the skel that works in place, or the daemon has
// nothing to restart with.
test("update keeps the old skel when the copy fails", async () => {
  installed();
  const skel = join(home, "server", ".local", "bin", "skel");
  writeFileSync(skel, "old skel");
  writeFileSync(join(home, "scp-fails"), "");
  const run = await update(laptopSkel());
  expect(run.code).toBe(1);
  expect(readFileSync(skel, "utf8")).toBe("old skel");
  expect(calls()).not.toContain("systemctl --user restart");
});

test("update copies nothing to a server without skel", async () => {
  const run = await update(laptopSkel());
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "skel isn't on simon@workbox yet: skel --remote simon@workbox sets it up",
  );
  expect(calls()).not.toContain("scp");
});

test("update needs --remote and where to", async () => {
  const run = await skel(["update"]);
  expect(run.err).toContain("skel update --remote <host>");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});
