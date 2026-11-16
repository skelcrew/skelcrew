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
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { source } from "./harness.ts";

let home = "";
// The real ssh, which reads ssh configs for the fake one.
const realSsh = Bun.which("ssh") ?? "ssh";
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
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "", { mode: 0o600 });
  // Like ssh, it joins the words after the host into one line for the server's shell, which
  // runs in the server's home with the bare PATH a command over ssh gets. serverbin comes
  // first, so the server's systemctl is a fake and never the real one of this machine.
  // ssh -G, which only reads your ssh config, isn't logged. The real ssh answers it with
  // ~/.ssh/config in the test's home, and without this machine's system config, which must
  // not count. The options before the host are skipped.
  writeFileSync(
    join(home, "bin", "ssh"),
    `#!/bin/sh
test "$1" = -G && exec ${realSsh} -G -F "$HOME/.ssh/config" "$2"
echo "ssh $*" >> "$HOME/calls"
while test "$1" = -o || test "$1" = -t; do
  if test "$1" = -t; then shift; else shift 2; fi
done
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
    `test -f "$HOME/scp-fails" && exit 1\nwhile test "$1" = -o; do shift 2; done\ncp "$1" "$HOME/server/\${2#*:}"`,
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

// The options that make every ssh and scp to the server share one connection.
const shared = `-o ControlMaster=auto -o ControlPersist=60 -o ControlPath=/tmp/sc-${userInfo().uid}/%C`;
// How Skelcrew starts every ssh command to the server, sharing one connection.
const ssh = `ssh ${shared} simon@workbox`;

// The line ssh runs on the server, saying only errors so that ssh doesn't say each time the
// connection closes: with the laptop's build, so a copied Skelcrew can tell it is
// out of date, or without, to run whatever Skelcrew is there. Always with the server's name, for
// the title of your terminal.
const onServer = (words: string, build: string | null = laptop.commit) =>
  `ssh -o LogLevel=ERROR -t ${shared} simon@workbox env PATH="$HOME/.local/bin:$PATH" SKELCREW_REMOTE_NAME=simon@workbox ${build ? `SKELCREW_LAPTOP_BUILD=${build} ` : ""}sc${words}`;

// Runs sc in a terminal and types the next of `answers` at each [Y/n] or [y/N] question it asks.
// Returns all it wrote there, escape codes included, and its exit code.
async function skelInTerminal(args: string[], answers: string[] = []) {
  let wrote = "";
  let answered = 0;
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
    cwd: home,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
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

// A PR's number names a PR of the repository you are in, which only your laptop knows, so it
// goes along as --from. A thread's name already names its repository.
test("sc pr show with a number passes the repository you are in", async () => {
  installed();
  const app = checkout("simon/app");
  const run = await skel(["--remote", "simon@workbox", "pr", "show", "#31", "--json"], "", app);
  expect(run.out).toBe(
    "Skelcrew on the server got 6 arguments\n[pr]\n[show]\n[#31]\n[--json]\n[--from]\n[git@github.com:simon/app.git]\n",
  );
  const named = await skel(["--remote", "simon@workbox", "pr", "show", "app-12"], "", app);
  expect(named.out).toBe("Skelcrew on the server got 3 arguments\n[pr]\n[show]\n[app-12]\n");
  const away = await skel(["--remote", "simon@workbox", "pr", "show", "31"]);
  expect(away.out).toBe("Skelcrew on the server got 3 arguments\n[pr]\n[show]\n[31]\n");
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
  // It connects right away, so it prints no command to connect.
  expect(wrote).not.toContain("Connect to it with");
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

// Runs main.ts as the Skelcrew on a server would run it, built from the given commit
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
  expect(run.out).toContain("Setting up simon@workbox: copying Skelcrew there and setting it up.");
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
    new RegExp(`^scp ${shared} ${home}/tmp/\\S+/sc simon@workbox:.local/bin/sc.new$`),
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
// shares one connection, through sockets in a folder only you can reach.
test("every ssh and scp for a setup shares one connection, through a private folder", async () => {
  await skel(["remote", "add", "simon@workbox"]);
  const lines = calls()
    .trim()
    .split("\n")
    .filter((line) => /^(ssh|scp) /.test(line));
  expect(lines.length).toBeGreaterThanOrEqual(5);
  for (const line of lines)
    expect(line).toMatch(/^(ssh -o LogLevel=ERROR -t|ssh|scp) -o ControlMaster=auto /);
  for (const line of lines) expect(line).toContain(` ${shared} `);
  const folder = lstatSync(`/tmp/sc-${userInfo().uid}`);
  expect(folder.isDirectory()).toBe(true);
  expect(folder.uid).toBe(userInfo().uid);
  expect(folder.mode & 0o777).toBe(0o700);
});

// Two sc commands starting at once can both find the folder missing, and both must still
// connect, sharing. The folder is the real one, so it is removed first only when empty: then no
// connection of yours is using it.
test("two sc commands starting at once both share connections", async () => {
  installed(laptop.commit);
  try {
    rmdirSync(`/tmp/sc-${userInfo().uid}`);
  } catch {
    // Not empty, or not there: either way the two runs below still meet a folder they share.
  }
  const runs = await Promise.all([1, 2].map(() => skel(["--remote", "simon@workbox", "ps"])));
  expect(runs.map((run) => run.code)).toEqual([3, 3]);
  expect(calls()).toBe(`${onServer(" ps")}\n${onServer(" ps")}\n`);
});

// Options given to ssh beat your ssh config, so when your config already says how to share
// connections for the host, Skelcrew adds nothing. The real ssh reads your config here.
for (const { what, yours } of [
  { what: "a ControlPath of yours", yours: "Host workbox\n  ControlPath ~/.ssh/cm-%C\n" },
  { what: "ControlMaster auto", yours: "Host workbox\n  ControlMaster auto\n" },
  {
    what: "ControlMaster yes under Match final",
    yours: "Match final host workbox\n  ControlMaster yes\n",
  },
  // ssh -G prints these two as if nothing were set, so only reading your config finds them.
  { what: "ControlPath none", yours: "Host workbox\n  ControlPath none\n" },
  { what: "ControlMaster no", yours: "Host workbox\n  ControlMaster no\n" },
  // A setting for another host counts too: Skelcrew leaves sharing to you.
  { what: "controlpath=none for another host", yours: "Host gate\n  controlpath=none\n" },
])
  test(`${what} in your ssh config is kept`, async () => {
    writeFileSync(join(home, ".ssh", "config"), yours);
    installed(laptop.commit);
    await skel(["--remote", "simon@workbox", "ps"]);
    expect(calls()).toStartWith("ssh -o LogLevel=ERROR -t simon@workbox env ");
  });

// A setting in a file your config includes counts as if it were in your config. Include
// finds a name without a leading / or ~ under ~/.ssh, and expands globs.
test("ControlPath none in a file your ssh config includes is kept", async () => {
  mkdirSync(join(home, ".ssh", "conf.d"));
  writeFileSync(join(home, ".ssh", "conf.d", "work.conf"), "Host workbox\n  ControlPath none\n");
  writeFileSync(join(home, ".ssh", "config"), "Include conf.d/*.conf\n");
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  expect(calls()).toStartWith("ssh -o LogLevel=ERROR -t simon@workbox env ");
});

// A setting turned into a comment sets nothing, so Skelcrew shares the connection.
test("a commented-out ControlPath in your ssh config doesn't count", async () => {
  writeFileSync(join(home, ".ssh", "config"), "Host workbox\n  # ControlPath none\n");
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  expect(calls()).toStartWith(`ssh -o LogLevel=ERROR -t ${shared} simon@workbox `);
});

// A config that ssh can't read gives nothing to go by, so nothing is added.
test("an ssh config ssh can't read adds no options", async () => {
  writeFileSync(join(home, ".ssh", "config"), "Host workbox\n  NoSuchOption yes\n");
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  expect(calls()).toStartWith("ssh -o LogLevel=ERROR -t simon@workbox env ");
});

// ssh starts another ssh for a ProxyJump host. If that one took the server's socket, later
// commands would run on the jump host. Real ssh is given Skelcrew's options, and a stand-in for
// the ssh it starts shows that the jump host gets none of them.
test("a ProxyJump host gets none of the sharing options", async () => {
  writeFileSync(join(home, ".ssh", "config"), "Host workbox\n  ProxyJump gate\n");
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  expect(calls()).toStartWith(`ssh -o LogLevel=ERROR -t ${shared} simon@workbox `);
  mkdirSync(join(home, "jumpbin"));
  writeFileSync(join(home, "jumpbin", "ssh"), `#!/bin/sh\necho "$*" > "${home}/jump"\n`, {
    mode: 0o755,
  });
  const config = join(home, ".ssh", "config");
  const argv = [realSsh, "-F", config, ...shared.split(" "), "workbox", "true"];
  // ssh starts the jump host's ssh by the name it was run by, so it is run as plain ssh.
  const env = { PATH: `${join(home, "jumpbin")}:/usr/bin:/bin`, HOME: home };
  Bun.spawnSync(argv, { env, argv0: "ssh" });
  const jump = readFileSync(join(home, "jump"), "utf8");
  expect(jump).toEndWith(" gate\n");
  expect(jump).not.toContain("Control");
});

test("sc remote add copies your setup there before the first run", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    "Copying your settings, Claude sign-in and plugins to simon@workbox.\ntook the laptop's setup\nthe first run on the server\n",
  );
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

test("a host that names a machine plugin is refused, not taken as an SSH host", async () => {
  for (const plugin of ["sprite", "3cloud"]) {
    for (const args of [
      ["remote", "add", `${plugin}:demo`],
      ["--remote", `${plugin}:demo`, "ps"],
    ]) {
      const run = await skel(args);
      expect(run.err).toContain(`no machine plugin named ${plugin}`);
      expect(run.code).toBe(1);
    }
  }
  expect(calls()).toBe("");
});

test("an IPv6 address is an SSH host, though it starts like a plugin name", async () => {
  for (const host of ["abcd::1", "[abcd::1]", "simon@abcd::1"]) {
    for (const args of [
      ["remote", "add", host],
      ["--remote", host, "ps"],
    ]) {
      const run = await skel(args);
      expect(run.err).not.toContain("no machine plugin");
    }
    // The host comes after ssh's options, as a word of its own.
    expect(calls()).toContain(` ${host} `);
  }
});

test("an agent can't set up a machine", () => {
  const env = { PATH: "/usr/bin:/bin", HOME: home, SKELCREW_SANDBOX: "1" };
  const said = (args: string[]) =>
    Bun.spawnSync([process.execPath, laptop.main, ...args], { env }).stderr.toString();
  expect(said(["remote", "add", "simon@workbox"])).toContain("only for your own terminal");
  expect(said(["first-run"])).toContain("only for your own terminal");
  expect(calls()).toBe("");
});
