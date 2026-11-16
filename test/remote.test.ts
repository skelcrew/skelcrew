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
// carried their commit. On a server whose first run hasn't finished, it runs nothing but the
// first run, which finishes it. Until it takes the laptop's setup, it stops on a laptop that
// has one, as a copied Skelcrew does when its setup differs.
const serverSkel = (built?: string) => `#!/bin/sh
${built === undefined ? "" : `test -n "$SKELCREW_LAPTOP_BUILD" && test "$SKELCREW_LAPTOP_BUILD" != "${built}" && { echo "Skelcrew on $SKELCREW_REMOTE_NAME is from ${built}"; exit 98; }\n`}test -n "$SKELCREW_LAPTOP_SETUP" && test ! -f setup-taken && exit 96
test "$1" = take-setup && { echo "took the laptop's setup"; cp .config/skelcrew/laptop-setup.json setup-taken; exit; }
test "$1" = first-run && { echo "the first run on the server"; rm -f first-run-unfinished; test ! -f first-run-fails; exit; }
test -f first-run-unfinished && exit 97
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
  // The config file given before the host is skipped.
  writeFileSync(
    join(home, "bin", "ssh"),
    `#!/bin/sh
echo "ssh $*" >> "$HOME/calls"
test "$1" = -t && shift
while test "$1" = -F; do shift 2; done
shift
bin="$HOME/serverbin"
cd "$HOME/server" && HOME="$HOME/server" PATH="$bin:/usr/bin:/bin" exec sh -c "$*"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(home, "serverbin", "systemctl"),
    `#!/bin/sh\necho "systemctl $*" >> "${join(home, "calls")}"\n`,
    { mode: 0o755 },
  );
  // The server is x64, whatever CPU this machine has, unless a test says otherwise.
  writeFileSync(join(home, "serverbin", "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
  fake(
    "scp",
    `test -f "$HOME/scp-fails" && exit 1\nwhile test "$1" = -F; do shift 2; done\ncp "$1" "$HOME/server/\${2#*:}"`,
  );
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

async function skel(args: string[], typed = "", cwd = home, runtime = join(home, "run")) {
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
    cwd,
    env: {
      PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: join(home, "tmp"),
      XDG_RUNTIME_DIR: runtime,
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

// Returns the commands run on the laptop, one per line, with the config of the shared ssh
// connection written as <config>, so a test needn't know its name.
const calls = () =>
  existsSync(join(home, "calls"))
    ? readFileSync(join(home, "calls"), "utf8").replaceAll(/-F \S+/g, "-F <config>")
    : "";

// How Skelcrew starts every ssh command to the server, sharing one connection.
const ssh = "ssh -F <config> simon@workbox";

// The line ssh runs on the server: with the laptop's build, so a copied Skelcrew can tell it is
// out of date, or without, to run whatever Skelcrew is there. Always with the server's name, for
// the title of your terminal.
const onServer = (words: string, build: string | null = laptop.commit) =>
  `ssh -t -F <config> simon@workbox env PATH="$HOME/.local/bin:$PATH" SKELCREW_REMOTE_NAME=simon@workbox ${build ? `SKELCREW_LAPTOP_BUILD=${build} ` : ""}sc${words}`;

// Runs sc in a terminal and types the next of `answers` at each [Y/n] or [y/N] question it asks.
// Returns all it wrote there, escape codes included, and its exit code.
async function skelInTerminal(args: string[], answers: string[] = []) {
  let wrote = "";
  let answered = 0;
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
    cwd: home,
    env: {
      PATH: `${join(home, "bin")}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: join(home, "tmp"),
      XDG_RUNTIME_DIR: join(home, "run"),
    },
    terminal: {
      data: (terminal, bytes) => {
        wrote += new TextDecoder().decode(bytes);
        const asked = wrote.match(/\[(Y\/n|y\/N)\]/g)?.length ?? 0;
        while (answered < asked && answered < answers.length)
          terminal.write(`${answers[answered++]}\r`);
      },
    },
  });
  const code = await run.exited;
  run.terminal?.close();
  return { wrote, code };
}

test("the terminal's title is saved before the server is reached and put back after", async () => {
  installed();
  const { wrote } = await skelInTerminal(["--remote", "simon@workbox", "ps"]);
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
    ["--remote", "simon@workbox", "issue", "create", "app", "Fix it", body, ""],
    "",
    checkout("simon/app"),
  );
  expect(run.out).toBe(
    `Skelcrew on the server got 6 arguments\n[issue]\n[create]\n[app]\n[Fix it]\n[${body}]\n[]\n`,
  );
});

test("without a terminal, --remote on a server without Skelcrew only says how to set it up", async () => {
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  // The server's shell says first that it found no Skelcrew.
  expect(run.err).toEndWith(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc remote add simon@workbox\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

test("without a terminal, --remote on a server whose first run isn't done only says how to set it up", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "first-run-unfinished"), "");
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc remote add simon@workbox\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

test("in a terminal, --remote offers to set up a server without Skelcrew, then runs the command", async () => {
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], [""]);
  expect(wrote).toContain("simon@workbox isn't set up. Set it up now? [Y/n]");
  expect(wrote).toContain("the first run on the server");
  expect(wrote).toContain("Skelcrew on the server got 1 arguments\r\n[ps]\r\n");
  expect(code).toBe(3);
  const lines = calls().trim().split("\n");
  expect(lines[0]).toBe(onServer(" ps"));
  // What sc remote add runs, then the command you asked for.
  expect(lines[1]).toBe(onServer(" first-run"));
  expect(lines).toContain(`${ssh} mv -f .local/bin/sc.new .local/bin/sc`);
  expect(lines.at(-2)).toBe(onServer(" first-run", null));
  expect(lines.at(-1)).toBe(onServer(" ps"));
});

test("in a terminal, --remote finishes a first run that isn't done, then runs the command", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "first-run-unfinished"), "");
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["y"]);
  expect(wrote).toContain("simon@workbox isn't set up. Set it up now? [Y/n]");
  expect(code).toBe(3);
  expect(calls()).toBe(`${onServer(" ps")}\n${onServer(" first-run")}\n${onServer(" ps")}\n`);
});

test("in a terminal, a no to setting up sets up nothing and says what to run later", async () => {
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["n"]);
  expect(wrote).toContain("sc remote add simon@workbox");
  expect(code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
  expect(existsSync(join(home, "server", ".local", "bin", "sc"))).toBe(false);
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
  expect(run.out).toContain("Update it? [Y/n]");
  expect(run.out).toContain(
    `Updated simon@workbox to the Skelcrew in ~/code/skel (commit ${laptop.commit}) and restarted its daemon.`,
  );
  expect(run.out).toContain("each lead picks up new instructions when it's next started");
  expect(run.out).not.toContain("uncommitted");
  expect(run.out).toEndWith("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(run.code).toBe(3);
  const lines = calls().trim().split("\n");
  expect(lines[0]).toBe(onServer(" ps"));
  expect(lines).toContain(`${ssh} mv -f .local/bin/sc.new .local/bin/sc`);
  // The daemon restarts only once the new Skelcrew is in place, so it runs the new build, and
  // the command runs after that.
  expect(lines.at(-3)).toBe(`${ssh} systemctl --user restart skelcrew`);
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
  expect(run.out).toContain("Running it on the old Skelcrew on simon@workbox.");
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
  expect(run.out).toContain("~/code/skel has uncommitted changes, and they are copied too.");
  expect(run.out).toContain("~/code/skel is on try, not main.");
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
    out: "Skelcrew on x is from abc1234, yours is def5678.\n",
  });
});

test("a sidebar runs whichever laptop's build its tmux server remembers", () => {
  // A server started from one laptop hands its environment to the panes of every terminal.
  const socket = `skel-test-${process.pid}-no-server`;
  const run = farSkel("abc1234", "def5678", ["sidebar", socket, "screen-1", "local", "simon/app"]);
  expect(run.code).toBe(1);
  expect(run.out).toBe("");
});

test("a list runs whichever laptop's build its tmux server remembers", () => {
  const socket = `skel-test-${process.pid}-no-server`;
  const run = farSkel("abc1234", "def5678", [
    "list",
    socket,
    "screen-1",
    "issues",
    "",
    "simon/app",
  ]);
  expect(run.code).toBe(1);
  expect(run.out).toBe("");
});

test("a copied Skelcrew built with uncommitted changes is never up to date", () => {
  expect(farSkel("abc1234-dirty", "abc1234-dirty")).toEqual({
    code: 98,
    out: "Skelcrew on x is from abc1234 with uncommitted changes, yours is abc1234 with uncommitted changes.\n",
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
  expect(run.out).toContain("Setting up simon@workbox: copying Skelcrew there and running");
  expect(run.out).toContain("the first run on the server\n");
  expect(run.out).toEndWith(
    "simon@workbox is ready. Connect to it with:\n  sc --remote simon@workbox\n",
  );
  const lines = calls().split("\n");
  expect(lines[0]).toBe(onServer(" first-run"));
  expect(lines[1]).toBe(`${ssh} uname -m`);
  // Built for the server, which is Linux, whatever the laptop runs, with the commit it came
  // from, so the server can tell when the laptop has moved on.
  expect(lines[2]).toMatch(
    new RegExp(
      `^bun build --compile --target=bun-linux-x64 --define SKELCREW_BUILD="${laptop.commit}" ${laptop.main} --outfile ${home}/tmp/\\S+/sc$`,
    ),
  );
  expect(lines[3]).toBe(`${ssh} mkdir -p .local/bin && rm -f .local/bin/sc.new`);
  expect(lines[4]).toMatch(
    new RegExp(`^scp -F <config> ${home}/tmp/\\S+/sc simon@workbox:.local/bin/sc.new$`),
  );
  expect(lines[5]).toBe(`${ssh} mv -f .local/bin/sc.new .local/bin/sc`);
  // A fresh copy is the laptop's build, so it runs without the check.
  expect(lines[6]).toBe(onServer(" first-run", null));
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(readFileSync(join(home, "server", ".local", "bin", "sc"), "utf8")).toBe(
    serverSkel(laptop.commit),
  );
});

// Each new ssh connection can ask for your passphrase or a touch of your key, so one setup
// shares one connection, through a socket only you can reach, even in a folder that was there
// before and open to others.
test("every ssh and scp for a setup shares one connection, through a private socket", async () => {
  const folder = join(home, "run", "skelcrew", "ssh");
  mkdirSync(folder, { recursive: true, mode: 0o755 });
  await skel(["remote", "add", "simon@workbox"]);
  const lines = readFileSync(join(home, "calls"), "utf8").trim().split("\n");
  const ssh = lines.filter((line) => /^(ssh|scp) /.test(line));
  expect(ssh.length).toBeGreaterThanOrEqual(5);
  const configs = new Set(ssh.map((line) => line.match(/ -F (\S+) /)?.[1]));
  expect(configs.size).toBe(1);
  const [config = ""] = configs;
  expect(lstatSync(folder).mode & 0o777).toBe(0o700);
  expect(lstatSync(config).mode & 0o777).toBe(0o600);
  const socket = readFileSync(config, "utf8").match(/ControlPath "(.+)"/)?.[1] ?? "";
  expect(socket.startsWith(`${folder}/`)).toBe(true);
  // A Mac refuses a socket path over 103 bytes, and ssh adds 17 while it makes the socket.
  expect(socket.length).toBeLessThanOrEqual(86);
});

// ssh keeps the first value it finds for each setting, so ControlPath none or ControlMaster no
// that you set still wins, also under Match final, which ssh reads in a last pass. The real
// ssh reads the config Skelcrew writes, with its Includes pointed at a config of the test: ssh
// finds ~ from your account, not HOME, and this machine's own config must not count.
test("ssh keeps your settings, even under Match final, and gives a jump host none", async () => {
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  const written = readFileSync(join(home, "calls"), "utf8").match(/ -F (\S+) /)?.[1] ?? "";
  const text = readFileSync(written, "utf8");
  const includes = "Include ~/.ssh/config\nInclude /etc/ssh/ssh_config\n";
  expect(text).toStartWith(includes);
  const socket = text.match(/ControlPath "(.+)"/)?.[1] ?? "";
  // Returns the sharing settings real ssh would use for the host, with `yours` as your ssh
  // config. A setting that isn't set reads as unset.
  const evaluated = (yours: string, host: string) => {
    writeFileSync(join(home, "yours.conf"), yours, { mode: 0o600 });
    const config = join(home, "tried.conf");
    writeFileSync(config, text.replace(includes, `Include ${home}/yours.conf\n`), { mode: 0o600 });
    const run = Bun.spawnSync(["ssh", "-G", "-F", config, host], { stdout: "pipe" });
    expect(run.exitCode).toBe(0);
    const said = run.stdout.toString();
    const setting = (name: string) => said.match(new RegExp(`^${name} (.*)$`, "m"))?.[1] ?? "unset";
    return { master: setting("controlmaster"), path: setting("controlpath") };
  };
  const jump = "Host workbox\n  ProxyJump gate\n";
  expect(evaluated(jump, "simon@workbox")).toEqual({ master: "auto", path: socket });
  // ssh hands the same config file to the ssh it starts for the jump host.
  expect(evaluated(jump, "gate")).toEqual({ master: "false", path: "unset" });
  const final = "Match final host workbox\n  ControlMaster no\n  ControlPath /mine/cm\n";
  expect(evaluated(final, "simon@workbox")).toEqual({ master: "false", path: "/mine/cm" });
  const none = "Host workbox\n  ControlPath none\n";
  expect(evaluated(none, "simon@workbox")).toEqual({ master: "auto", path: "unset" });
});

// A socket path too long for a Mac fails every connection, so then each command connects on
// its own, as ssh does by default.
test("a runtime folder too long for the socket leaves connections unshared", async () => {
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "ps"], "", home, join(home, "r".repeat(80)));
  expect(run.code).toBe(3);
  expect(calls()).toStartWith("ssh -t simon@workbox env ");
});

test("sc remote add copies your setup there before the first run", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("took the laptop's setup\nthe first run on the server\n");
  const lines = calls().trim().split("\n");
  const send = ".config/skelcrew/laptop-setup.json";
  expect(lines).toContain(
    `${ssh} umask 077 && mkdir -p .config/skelcrew && rm -f ${send} && : > ${send}`,
  );
  expect(lines.at(-1)).toMatch(/ sc first-run$/);
  expect(lines.at(-2)).toMatch(/ sc take-setup$/);
  // The file sent holds the token, so it is readable only by you there.
  const taken = join(home, "server", "setup-taken");
  expect(JSON.parse(readFileSync(taken, "utf8"))).toMatchObject({
    config: "harness: codex\n",
    token: null,
    plugins: [],
  });
  expect(lstatSync(join(home, "server", send)).mode & 0o777).toBe(0o600);
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
