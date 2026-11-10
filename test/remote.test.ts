// sc --remote and sc remote add, run as you would run them on your laptop, against a
// fake ssh and scp that play a server in a folder of the test, and a fake bun that builds a
// stand-in Skelcrew.
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
import { source } from "./harness.ts";

let home = "";
let laptop = { folder: "", main: "", commit: "" };

// The Skelcrew the fake bun builds: it says what reached it, one argument per line, so a test
// can see that each one arrived exactly as typed. Built with a commit, it stops as a copied
// Skelcrew does when the laptop's build differs. Without one, it is a Skelcrew from before builds
// carried their commit.
const serverSkel = (built?: string) => `#!/bin/sh
${built === undefined ? "" : `test -n "$SKELCREW_LAPTOP_BUILD" && test "$SKELCREW_LAPTOP_BUILD" != "${built}" && { echo "Skelcrew on $SKELCREW_REMOTE_NAME is from ${built}"; exit 98; }\n`}test "$1" = first-run && { echo "the first run on the server"; test ! -f first-run-fails; exit; }
echo "Skelcrew on the server got $# arguments"
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

// Returns a Skelcrew checkout of its own on the laptop, on main with one commit, so a test knows
// what is built and from which commit.
function laptopSkel(): { folder: string; main: string; commit: string } {
  const folder = join(home, "code", "skel");
  cpSync(source(), join(folder, "src"), { recursive: true });
  // The header reads its version from package.json, as in any checkout.
  cpSync(join(import.meta.dir, "..", "package.json"), join(folder, "package.json"));
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
    folder,
    main: join(folder, "src", "main.ts"),
    commit: git("rev-parse", "--short", "HEAD").stdout.toString().trim(),
  };
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
  // The server is x64, whatever CPU this machine has, unless a test says otherwise.
  writeFileSync(join(home, "serverbin", "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
  fake("scp", `test -f "$HOME/scp-fails" && exit 1\ncp "$1" "$HOME/server/\${2#*:}"`);
  // Builds the stand-in Skelcrew with the commit Skelcrew stamps into the build.
  fake(
    "bun",
    `while [ $# -gt 1 ]; do
  test "$1" = --outfile && out=$2
  test "$1" = --define && built=$(echo "$2" | sed 's/^SKELCREW_BUILD="\\(.*\\)"$/\\1/')
  shift
done
sed "s/@BUILT@/$built/g" > "$out" <<'EOF'
${serverSkel("@BUILT@")}EOF
chmod +x "$out"`,
  );
  laptop = laptopSkel();
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Puts a Skelcrew on the server where a copy would put it, built from the given commit.
function installed(built?: string): void {
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  writeFileSync(join(home, "server", ".local", "bin", "sc"), serverSkel(built), {
    mode: 0o755,
  });
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
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
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

// The line ssh runs on the server: with the laptop's build, so a copied Skelcrew can tell it is
// out of date, or without, to run whatever Skelcrew is there. Always with the server's name, for
// the title of your terminal.
const onServer = (words: string, build: string | null = laptop.commit) =>
  `ssh -t simon@workbox env PATH="$HOME/.local/bin:$PATH" SKELCREW_REMOTE_NAME=simon@workbox ${build ? `SKELCREW_LAPTOP_BUILD=${build} ` : ""}sc${words}`;

// Runs sc in a terminal, and returns all it wrote there, escape codes included.
async function skelInTerminal(args: string[]): Promise<string> {
  let wrote = "";
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
    cwd: home,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
    terminal: {
      data: (_, bytes) => {
        wrote += new TextDecoder().decode(bytes);
      },
    },
  });
  await run.exited;
  run.terminal?.close();
  return wrote;
}

test("the terminal's title is saved before the server is reached and put back after", async () => {
  installed();
  const wrote = await skelInTerminal(["--remote", "simon@workbox", "ps"]);
  expect(wrote.startsWith("\x1b[22;0t")).toBe(true);
  expect(wrote.endsWith("\x1b[23;0t")).toBe(true);
  expect(wrote).toContain("Skelcrew on the server got 1 arguments");
});

test("runs sc on the server with the repository you are in", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox"], "", checkout("simon/app"));
  expect(calls()).toBe(`${onServer(" --from git@github.com:simon/app.git")}\n`);
  expect(run.out).toBe(
    "Skelcrew on the server got 2 arguments\n[--from]\n[git@github.com:simon/app.git]\n",
  );
  // What Skelcrew exits with on the server is what Skelcrew exits with here.
  expect(run.code).toBe(3);
});

test("passes no repository from outside one", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox"]);
  expect(calls()).toBe(`${onServer("")}\n`);
  expect(run.out).toBe("Skelcrew on the server got 0 arguments\n");
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
    `Skelcrew on the server got 6 arguments\n[task]\n[create]\n[app]\n[Fix it]\n[${body}]\n[]\n`,
  );
});

test("--remote only connects: on a server without Skelcrew it says how to set it up", async () => {
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  // The server's shell says first that it found no Skelcrew.
  expect(run.err).toEndWith(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc remote add simon@workbox\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

// A link left at ~/.local/bin/sc, such as one to a checkout's launcher that can't find bun
// over ssh, must be replaced, not written through: a copy through it would overwrite the
// checkout's own file.
test("replaces a link at ~/.local/bin/sc instead of writing through it", async () => {
  const launcher = join(home, "server", "checkout", "bin", "sc");
  mkdirSync(join(home, "server", "checkout", "bin"), { recursive: true });
  const original = "#!/bin/sh\nexec no-such-bun main.ts\n";
  writeFileSync(launcher, original, { mode: 0o755 });
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  symlinkSync(launcher, join(home, "server", ".local", "bin", "sc"));
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(readFileSync(launcher, "utf8")).toBe(original);
  expect(lstatSync(join(home, "server", ".local", "bin", "sc")).isSymbolicLink()).toBe(false);
});

test("needs a host", async () => {
  const run = await skel(["--remote"]);
  expect(run.err).toContain("--remote needs a host");
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
  const launcher = join(import.meta.dir, "..", "bin", "sc");
  const run = Bun.spawnSync(["/bin/sh", launcher, "ps"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  const script = `${realpathSync(join(import.meta.dir, "..", "bin"))}/../src/main.ts`;
  expect(run.stdout.toString()).toBe(`bun got ${script} ps\n`);
});

test("runs the command with no offer when Skelcrew there is from the laptop's commit", async () => {
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.out).toBe("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(run.code).toBe(3);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

test("offers to update an out-of-date Skelcrew, updates it, then runs the command", async () => {
  installed("0000000");
  const run = await skel(["--remote", "simon@workbox", "ps"], "\n");
  expect(run.out).toContain("Skelcrew on simon@workbox is from 0000000\n");
  expect(run.out).toContain("Skelcrew · Update it? [Y/n]");
  expect(run.out).toContain(
    `Skelcrew · updated simon@workbox to the Skelcrew in ~/code/skel (commit ${laptop.commit}) and restarted its daemon.`,
  );
  expect(run.out).toContain("each lead picks up new instructions when it's next started");
  expect(run.out).not.toContain("uncommitted");
  expect(run.out).toEndWith("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(run.code).toBe(3);
  const lines = calls().trim().split("\n");
  expect(lines[0]).toBe(onServer(" ps"));
  expect(lines).toContain("ssh simon@workbox mv -f .local/bin/sc.new .local/bin/sc");
  // The daemon restarts only once the new Skelcrew is in place, so it runs the new build, and
  // the command runs after that.
  expect(lines.at(-3)).toBe("ssh simon@workbox systemctl --user restart skelcrew");
  expect(lines.at(-2)).toBe("systemctl --user restart skelcrew");
  expect(lines.at(-1)).toBe(onServer(" ps", null));
  expect(readFileSync(join(home, "server", ".local", "bin", "sc"), "utf8")).toBe(
    serverSkel(laptop.commit),
  );
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("runs the command on the old Skelcrew when you say no to the update", async () => {
  installed("0000000");
  const run = await skel(["--remote", "simon@workbox", "ps"], "n\n");
  expect(run.out).toContain("Skelcrew · running it on the old Skelcrew on simon@workbox.");
  expect(run.out).toEndWith("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(run.code).toBe(3);
  expect(calls()).toBe(`${onServer(" ps")}\n${onServer(" ps", null)}\n`);
});

// What gets built is the laptop's checkout as it is, so a build with changes not committed
// can't say which commit it is, and never counts as up to date.
test("a laptop with uncommitted changes always offers, and says what it copies", async () => {
  Bun.spawnSync(["git", "-C", laptop.folder, "checkout", "-q", "-b", "try"]);
  writeFileSync(join(laptop.folder, "src", "new.ts"), "");
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(calls().split("\n")[0]).toBe(onServer(" ps", `${laptop.commit}-dirty`));
  expect(run.out).toContain(
    "Skelcrew · ~/code/skel has uncommitted changes, and they are copied too.",
  );
  expect(run.out).toContain("Skelcrew · ~/code/skel is on try, not main.");
  expect(calls()).toContain(`--define SKELCREW_BUILD="${laptop.commit}-dirty"`);
  expect(calls()).toContain("systemctl --user restart skelcrew");
});

// Returns a Skelcrew checkout on the server, with its launcher and sources.
function serverCheckout(name = "skel"): string {
  const checkout = join(home, "server", name);
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "src"));
  writeFileSync(join(checkout, "bin", "sc"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(checkout, "src", "main.ts"), "");
  return checkout;
}

// Writes the daemon's systemd unit on the server, starting the given Skelcrew.
function unit(skel: string): void {
  const units = join(home, "server", ".config", "systemd", "user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "skelcrew.service"), `[Service]\nExecStart="${skel}" serve\n`);
}

// Skelcrew run once from a checkout points the daemon's service at it, and a copy left in
// ~/.local/bin then runs nothing the daemon does.
test("the update goes by what the daemon's service runs, not by ~/.local/bin", async () => {
  installed("0000000");
  const checkout = serverCheckout();
  unit(join(checkout, "bin", "sc"));
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.out).toContain(`Skelcrew on simon@workbox runs from a checkout at ${checkout}`);
  expect(run.out).toContain("git pull there updates it");
  expect(run.out).toEndWith("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(calls()).not.toContain("scp");
  expect(calls()).not.toContain("systemctl --user restart");
});

// systemd reads % in a unit as the start of a name it fills in, so the service doubles it.
test("the update finds a checkout whose path holds a percent sign", async () => {
  installed("0000000");
  const checkout = serverCheckout("100%Skelcrew");
  unit(join(checkout, "bin", "sc").replaceAll("%", "%%"));
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.out).toContain(`Skelcrew on simon@workbox runs from a checkout at ${checkout}`);
});

// The update puts Skelcrew in ~/.local/bin, so a service that starts a Skelcrew elsewhere would
// restart the old one.
test("the update replaces nothing when the service runs a Skelcrew outside ~/.local/bin", async () => {
  installed("0000000");
  const other = join(home, "server", "opt", "skel");
  mkdirSync(join(home, "server", "opt"));
  writeFileSync(other, "old Skelcrew", { mode: 0o755 });
  unit(other);
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain(`the daemon on simon@workbox runs sc from ${other}`);
  expect(calls()).not.toContain("scp");
  expect(calls()).not.toContain("systemctl --user restart");
  expect(readFileSync(other, "utf8")).toBe("old Skelcrew");
});

// The update renames over ~/.local/bin/sc itself, so a service that starts the file a
// link there points to would keep running the old one.
test("the update replaces nothing when the service starts the file ~/.local/bin/sc links to", async () => {
  const other = join(home, "server", "opt", "skel");
  mkdirSync(join(home, "server", "opt"));
  writeFileSync(other, serverSkel("0000000"), { mode: 0o755 });
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  symlinkSync(other, join(home, "server", ".local", "bin", "sc"));
  unit(other);
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain(`the daemon on simon@workbox runs sc from ${other}`);
  expect(calls()).not.toContain("scp");
  expect(readFileSync(other, "utf8")).toBe(serverSkel("0000000"));
});

// A transfer that breaks off must leave the Skelcrew that works in place, or the daemon has
// nothing to restart with.
test("the update keeps the old Skelcrew when the copy fails", async () => {
  installed("0000000");
  writeFileSync(join(home, "scp-fails"), "");
  const run = await skel(["--remote", "simon@workbox", "ps"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("scp couldn't copy Skelcrew to simon@workbox");
  expect(readFileSync(join(home, "server", ".local", "bin", "sc"), "utf8")).toBe(
    serverSkel("0000000"),
  );
  expect(calls()).not.toContain("systemctl --user restart");
});

// Runs main.ts as the Skelcrew on a server or Sprite would run it, built from the given commit
// or from a checkout, asked for its help by a laptop with the given build.
function farSkel(built: string | null, laptopBuild?: string, args = ["--help"]) {
  const define = built === null ? [] : ["--define", `SKELCREW_BUILD="${built}"`];
  const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home };
  if (laptopBuild)
    Object.assign(env, { SKELCREW_LAPTOP_BUILD: laptopBuild, SKELCREW_REMOTE_NAME: "x" });
  const run = Bun.spawnSync([process.execPath, ...define, laptop.main, ...args], { env });
  return { code: run.exitCode, out: run.stdout.toString() };
}

test("a copied Skelcrew runs a command from a laptop with its own commit", () => {
  const run = farSkel("abc1234", "abc1234");
  expect(run.code).toBe(0);
  expect(run.out).toContain("USAGE");
});

test("a copied Skelcrew from another commit says so and runs nothing", () => {
  expect(farSkel("abc1234", "def5678")).toEqual({
    code: 98,
    out: "Skelcrew · Skelcrew on x is from abc1234, yours is def5678.\n",
  });
});

test("a sidebar runs whichever laptop's build its tmux server remembers", () => {
  // A server started from one laptop hands its environment to the panes of every terminal.
  const socket = `skel-test-${process.pid}-no-server`;
  const run = farSkel("abc1234", "def5678", ["sidebar", socket, "screen-1", "local", "simon/app"]);
  expect(run.code).toBe(1);
  expect(run.out).toBe("");
});

test("a page runs whichever laptop's build its tmux server remembers", () => {
  const run = farSkel("abc1234", "def5678", ["page", "https://github.com/simon/app/issues/1"]);
  expect(run.code).toBe(1);
  expect(run.out).toBe("");
});

test("a copied Skelcrew built with uncommitted changes is never up to date", () => {
  expect(farSkel("abc1234-dirty", "abc1234-dirty")).toEqual({
    code: 98,
    out: "Skelcrew · Skelcrew on x is from abc1234 with uncommitted changes, yours is abc1234 with uncommitted changes.\n",
  });
});

// A checkout on the server updates with git pull there, never from the laptop.
test("Skelcrew from a checkout never says it is out of date", () => {
  expect(farSkel(null, "def5678").out).toContain("USAGE");
});

test("Skelcrew update is gone", async () => {
  const run = await skel(["update", "--remote", "simon@workbox"]);
  expect(run.err).toBe("Skelcrew: that isn't a Skelcrew command. Run sc --help to see them.\n");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("sc remote add copies Skelcrew to a server, runs the first run, and prints how to connect", async () => {
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "Skelcrew · setting up simon@workbox: copying Skelcrew there and running",
  );
  expect(run.out).toContain("the first run on the server\n");
  expect(run.out).toEndWith(
    "Skelcrew · simon@workbox is ready. Connect to it with:\n  sc --remote simon@workbox\n",
  );
  const lines = calls().split("\n");
  expect(lines[0]).toBe(onServer(" first-run"));
  expect(lines[1]).toBe("ssh simon@workbox uname -m");
  // Built for the server, which is Linux, whatever the laptop runs, with the commit it came
  // from, so the server can tell when the laptop has moved on.
  expect(lines[2]).toMatch(
    new RegExp(
      `^bun build --compile --target=bun-linux-x64 --define SKELCREW_BUILD="${laptop.commit}" ${laptop.main} --outfile ${home}/tmp/\\S+/sc$`,
    ),
  );
  expect(lines[3]).toBe("ssh simon@workbox mkdir -p .local/bin && rm -f .local/bin/sc.new");
  expect(lines[4]).toMatch(new RegExp(`^scp ${home}/tmp/\\S+/sc simon@workbox:.local/bin/sc.new$`));
  expect(lines[5]).toBe("ssh simon@workbox mv -f .local/bin/sc.new .local/bin/sc");
  // A fresh copy is the laptop's build, so it runs without the check.
  expect(lines[6]).toBe(onServer(" first-run", null));
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(readFileSync(join(home, "server", ".local", "bin", "sc"), "utf8")).toBe(
    serverSkel(laptop.commit),
  );
});

test("sc remote add builds Skelcrew for the server's CPU", async () => {
  writeFileSync(join(home, "serverbin", "uname"), "#!/bin/sh\necho aarch64\n", { mode: 0o755 });
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(calls()).toContain("bun build --compile --target=bun-linux-arm64 ");
});

// A setup that stopped partway is finished by running it again, so this must be safe.
test("sc remote add on a server with sc copies nothing and runs the first run", async () => {
  installed(laptop.commit);
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(calls()).toBe(`${onServer(" first-run")}\n`);
});

test("sc remote add prints no way to connect when the first run fails", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "first-run-fails"), "");
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(1);
  expect(run.out).not.toContain("sc --remote");
});

test("sc remote add needs a host", async () => {
  const run = await skel(["remote", "add"]);
  expect(run.err).toContain("sc remote add needs a host");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("an agent can't set up a machine", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: home, SKELCREW_SANDBOX: "1" };
  const said = (args: string[]) =>
    Bun.spawnSync([process.execPath, laptop.main, ...args], { env }).stderr.toString();
  expect(said(["remote", "add", "simon@workbox"])).toContain("only for your own terminal");
  expect(said(["first-run"])).toContain("only for your own terminal");
  expect(calls()).toBe("");
});
