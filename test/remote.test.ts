// sc --remote and sc --remote <host> install, run as you would run them on your laptop, against a
// fake ssh and scp that play a server in a folder of the test, and a fake bun that builds a
// stand-in Skelcrew.
import { Database } from "bun:sqlite";
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
import { checkThenSc, quoted } from "../src/machine/remote.ts";
import { source } from "./harness.ts";

let home = "";
// The real ssh, which reads ssh configs for the fake one.
const realSsh = Bun.which("ssh") ?? "ssh";
let laptop = { folder: "", main: "", commit: "" };

// The Skelcrew the fake bun builds: it says what reached it, one argument per line, so a test
// can see that each one arrived exactly as typed. Built with a commit, it stops as a copied
// Skelcrew does when the laptop's build differs. Without one, it is a Skelcrew from before builds
// carried their commit. On a server that sc install hasn't set up, it runs nothing but sc
// install, which sets it up, and says so before checking its build, as a copied Skelcrew does.
// Its sc install puts the files sent with --files in place, as Skelcrew's does.
const serverSkel = (built?: string) => `#!/bin/sh
test "$1" != install && test -f not-set-up && exit 97
${built === undefined ? "" : `test -n "$SKELCREW_LAPTOP_BUILD" && test "$SKELCREW_LAPTOP_BUILD" != "${built}" && { echo "Skelcrew on $SKELCREW_REMOTE_NAME is from ${built}"; exit 98; }\n`}test "$1" = install && {
  f=; prev=; for w; do test "$prev" = --files && f=$w; prev=$w; done
  if test -n "$f"; then
    for n in config.yaml skelcrew.lock claude-token; do
      if test -f ".config/skelcrew/$f/$n"; then mv ".config/skelcrew/$f/$n" ".config/skelcrew/$n"; else rm -f ".config/skelcrew/$n"; fi
    done
    rmdir ".config/skelcrew/$f"
  fi
  echo "sc install on the server"; cp .config/skelcrew/config.yaml installed-from 2>/dev/null; rm -f not-set-up; test ! -f install-fails; exit
}
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
  // It logs with printf, as sh's echo would turn the \n in the line's text into new lines.
  writeFileSync(
    join(home, "bin", "ssh"),
    `#!/bin/sh
test "$1" = -G && exec ${realSsh} -G -F "$HOME/.ssh/config" "$2"
printf '%s\\n' "ssh $*" >> "$HOME/calls"
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
  // flock on the server only says it took the lock, so the tests run where flock isn't, as on a Mac.
  writeFileSync(
    join(home, "serverbin", "flock"),
    `#!/bin/sh\necho "flock $1" >> "${join(home, "calls")}"\nshift\nexec "$@"\n`,
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

async function skel(args: string[], typed = "", cwd = home, define: string[] = []) {
  const run = Bun.spawn([process.execPath, ...define, laptop.main, ...args], {
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
  `ssh -o LogLevel=ERROR -t ${shared} simon@workbox env PATH="$HOME/.local/bin:$PATH" SKELCREW_REMOTE_NAME=simon@workbox ${build ? `SKELCREW_LAPTOP_BUILD=${build} ` : ""}sh -c ${quoted(checkThenSc)} sh${words}`;

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

test("sc --list goes to the server with the repository you are in", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox", "--list"], "", checkout("simon/app"));
  expect(run.out).toBe(
    "Skelcrew on the server got 3 arguments\n[--list]\n[--from]\n[git@github.com:simon/app.git]\n",
  );
});

// sc restart there restarts the server's daemon, with no ssh by hand.
test("sc restart goes to the server and restarts its daemon there", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox", "restart"], "", checkout("simon/app"));
  expect(calls()).toBe(`${onServer(" restart")}\n`);
  expect(run.out).toBe("Skelcrew on the server got 1 arguments\n[restart]\n");
});

test("passes no repository from outside one", async () => {
  installed();
  const run = await skel(["--remote", "simon@workbox"]);
  expect(calls()).toBe(`${onServer("")}\n`);
  expect(run.out).toBe("Skelcrew on the server got 0 arguments\n");
});

// Only plain sc and sc --list pass the repository you are in. A task's name already names its
// repository.
test("sc task passes no repository, as a task's name names its own", async () => {
  installed();
  const named = await skel(
    ["--remote", "simon@workbox", "task", "app-12"],
    "",
    checkout("simon/app"),
  );
  expect(named.out).toBe("Skelcrew on the server got 2 arguments\n[task]\n[app-12]\n");
});

test("a command reaches the server exactly as typed", async () => {
  installed();
  const body = "Don't crash; it's \"bad\" when $HOME * `x` \\ happens\nTwice.";
  const run = await skel(
    ["--remote", "simon@workbox", "task", "add", "app", "Fix it", body, ""],
    "",
    checkout("simon/app"),
  );
  expect(run.out).toBe(
    `Skelcrew on the server got 6 arguments\n[task]\n[add]\n[app]\n[Fix it]\n[${body}]\n[]\n`,
  );
});

test("serve --bg runs the daemon on the server, with no repository passed", async () => {
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "serve", "--bg"], "", checkout("simon/app"));
  expect(run.out).toBe("Skelcrew on the server got 2 arguments\n[serve]\n[--bg]\n");
  expect(calls()).toBe(`${onServer(" serve --bg")}\n`);
});

test("without a terminal, --remote on a server without Skelcrew only says how to set it up", async () => {
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  // The server's shell says first that it found no Skelcrew.
  expect(run.err).toEndWith(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc --remote simon@workbox install\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

test("without a terminal, --remote on a server that isn't set up only says how to set it up", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "not-set-up"), "");
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(
    "Skelcrew: simon@workbox isn't set up. Run this on your laptop:\n  sc --remote simon@workbox install\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n`);
});

test("in a terminal, --remote offers to set up a server without Skelcrew, then runs the command", async () => {
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], [""]);
  expect(wrote).toContain("simon@workbox isn't set up. Set it up now? [Y/n]");
  // Your yes covers putting Skelcrew there, so it isn't asked again.
  expect(wrote).not.toContain("Put yours there?");
  expect(wrote).toContain("sc install on the server");
  expect(wrote).toContain("Skelcrew on the server got 1 arguments\r\n[ps]\r\n");
  expect(code).toBe(3);
  const lines = calls().trim().split("\n");
  expect(lines[0]).toBe(onServer(" ps"));
  // What sc --remote <host> install runs, then the command you asked for.
  expect(lines[1]).toBe(onServer(" install"));
  expect(lines).toContain(`${ssh} mv -f .local/bin/sc.new .local/bin/sc`);
  expect(lines.at(-2)).toBe(onServer(" install", null));
  expect(lines.at(-1)).toBe(onServer(" ps"));
});

test("in a terminal, --remote sets up a server that isn't, then runs the command", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "not-set-up"), "");
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["y"]);
  expect(wrote).toContain("simon@workbox isn't set up. Set it up now? [Y/n]");
  expect(code).toBe(3);
  expect(calls()).toBe(`${onServer(" ps")}\n${onServer(" install")}\n${onServer(" ps")}\n`);
});

// sc install there fails while a plugin you said no to is missing, and then the command you
// asked for doesn't run on a server that isn't set up.
test("in a terminal, --remote runs nothing more when setting up the server fails", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "not-set-up"), "");
  writeFileSync(join(home, "server", "install-fails"), "");
  const { code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["y"]);
  expect(code).toBe(1);
  expect(calls()).toBe(`${onServer(" ps")}\n${onServer(" install")}\n`);
});

// Your files hold logins and name plugins to install there, which is setting the server up, so
// they wait for your yes.
test("in a terminal, --remote asks before sending your files to a server that isn't set up", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  installed(laptop.commit);
  writeFileSync(join(home, "server", "not-set-up"), "");
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["y"]);
  expect(code).toBe(3);
  const asked = wrote.indexOf("simon@workbox isn't set up. Set it up now? [Y/n]");
  expect(asked).toBeGreaterThan(-1);
  expect(
    wrote.indexOf("Sending your config.yaml, skelcrew.lock to simon@workbox."),
  ).toBeGreaterThan(asked);
  expect(wrote.indexOf("sc install on the server")).toBeGreaterThan(asked);
  expect(readFileSync(join(home, "server", ".config", "skelcrew", "config.yaml"), "utf8")).toBe(
    "harness: codex\n",
  );
});

test("in a terminal, a no to setting up a server that isn't set up sends none of your files", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  installed(laptop.commit);
  writeFileSync(join(home, "server", "not-set-up"), "");
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["n"]);
  expect(wrote).toContain("sc --remote simon@workbox install");
  expect(code).toBe(1);
  // Only the command you asked for reached the server.
  const lines = calls().trim().split("\n");
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ssh .* simon@workbox .* sh ps$/);
  expect(existsSync(join(home, "server", ".config", "skelcrew"))).toBe(false);
});

test("in a terminal, a no to setting up sets up nothing and says what to run later", async () => {
  const { wrote, code } = await skelInTerminal(["--remote", "simon@workbox", "ps"], ["n"]);
  expect(wrote).toContain(
    "Nothing was set up. To set it up later, run:\r\n  sc --remote simon@workbox install",
  );
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
  const run = await skelInTerminal(["--remote", "simon@workbox", "install"], [""]);
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

// Puts a Skelcrew checkout on the server, cloned from the laptop's, with ~/.local/bin/sc linking
// to its launcher, as running Skelcrew from a checkout leaves it. Its launcher is an older
// Skelcrew that checks no build, so any warning comes from what the laptop sends. Its daemon's
// service runs, started from the checkout as it is, and restarting the service starts it again
// from whatever the checkout then holds, writing down that commit as a daemon does.
// With `linked` false, ~/.local/bin/sc is left alone, for another install beside the service.
function checkoutOnServer(name = "skelcrew", linked = true): string {
  const folder = join(home, "server", name);
  Bun.spawnSync(["git", "clone", "-q", laptop.folder, folder]);
  mkdirSync(join(folder, "bin"));
  writeFileSync(join(folder, "bin", "sc"), '#!/bin/sh\necho "old Skelcrew ran $*"\n', {
    mode: 0o755,
  });
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  if (linked) symlinkSync(join(folder, "bin", "sc"), join(home, "server", ".local", "bin", "sc"));
  unit(join(folder, "bin", "sc"));
  writeFileSync(
    join(home, "serverbin", "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> "${join(home, "calls")}"
mkdir -p "$HOME/.local/share/skelcrew"
echo "$(git -C ${quoted(folder)} rev-parse HEAD) "${quoted(folder)} > "$HOME/.local/share/skelcrew/daemon-code"
`,
    { mode: 0o755 },
  );
  daemonRestarts();
  return folder;
}

// Restarts the daemon's service on the server, as a person there would.
const daemonRestarts = () =>
  Bun.spawnSync([join(home, "serverbin", "systemctl"), "--user", "restart", "skelcrew"], {
    env: { PATH: "/usr/bin:/bin", HOME: join(home, "server") },
  });

// Makes a commit in a checkout, as a merge on main would.
function commit(folder: string): void {
  writeFileSync(join(folder, "later.txt"), "later\n");
  const git = ["git", "-C", folder, "-c", "user.name=t", "-c", "user.email=t"];
  Bun.spawnSync([...git, "add", "later.txt"]);
  Bun.spawnSync([...git, "commit", "-q", "-m", "later"]);
}

// Returns the short commit a checkout is at.
const at = (folder: string) =>
  Bun.spawnSync(["git", "-C", folder, "rev-parse", "--short", "HEAD"]).stdout.toString().trim();

// Runs the command a warning says to run on the server, there, as a person pasting it would,
// with the server's systemctl. Returns its exit code.
function runAdvice(warning: string): number {
  const command = warning.trim().split("\n").at(-1) ?? "";
  const run = Bun.spawnSync(["sh", "-c", command], {
    cwd: join(home, "server"),
    env: { PATH: `${join(home, "serverbin")}:/usr/bin:/bin`, HOME: join(home, "server") },
  });
  return run.exitCode;
}

// A folder as the server's shell reads it back exactly, in single quotes.
const inQuotes = (folder: string) => `'${folder.replaceAll("'", `'\\''`)}'`;

// What --remote says about a checkout behind your laptop, with the line that updates it and
// restarts its daemon.
const behindWarning = (folder: string, yours: string, ref = yours, lead = "To update it,") =>
  `Skelcrew on simon@workbox runs from a checkout at ${at(folder)}, yours is ${yours}. ${lead} run this there:\n  cd ${inQuotes(folder)} && git fetch --tags && git checkout ${ref} && systemctl --user restart skelcrew\n`;

// What --remote says about a daemon that runs older code than its checkout.
const daemonWarning = (folder: string) =>
  `The daemon on simon@workbox runs older code than its checkout. To update it, run this there:\n  cd ${inQuotes(folder)} && systemctl --user restart skelcrew\n`;

test("--remote warns when the server's checkout is behind your commit, says how to update it and its daemon, then runs the command", async () => {
  const folder = checkoutOnServer();
  commit(laptop.folder);
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(behindWarning(folder, at(laptop.folder)));
  expect(run.out).toBe("old Skelcrew ran ps\n");
  expect(run.code).toBe(0);
  // Doing what it says brings the checkout to your commit, restarts its daemon on it, and the
  // warning goes.
  expect(runAdvice(run.err)).toBe(0);
  expect(at(folder)).toBe(at(laptop.folder));
  expect(calls()).toContain("systemctl --user restart skelcrew\n");
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

// git pull fails in a checkout with no branch, and on another branch brings that branch.
for (const [where, move] of [
  ["with no branch", ["checkout", "-q", "--detach"]],
  ["on another branch", ["checkout", "-q", "-b", "other"]],
] as const) {
  test(`--remote says how to reach your commit from a checkout ${where}`, async () => {
    const folder = checkoutOnServer();
    Bun.spawnSync(["git", "-C", folder, ...move]);
    commit(laptop.folder);
    const run = await skel(["--remote", "simon@workbox", "ps"]);
    expect(run.err).toBe(behindWarning(folder, at(laptop.folder)));
    expect(runAdvice(run.err)).toBe(0);
    expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
  });
}

// A space, a quote or a $ in the folder must reach cd as it is, and run nothing.
test("--remote quotes the checkout's folder in the line that updates it", async () => {
  const folder = checkoutOnServer("it's my $(touch pwned) skel");
  commit(laptop.folder);
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(behindWarning(folder, at(laptop.folder)));
  expect(runAdvice(run.err)).toBe(0);
  expect(at(folder)).toBe(at(laptop.folder));
  expect(existsSync(join(home, "server", "pwned"))).toBe(false);
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

// Checking out alone leaves the daemon on the old code, so the warning stays until it restarts.
test("--remote keeps warning after an update until the daemon restarts on it", async () => {
  const folder = checkoutOnServer();
  commit(laptop.folder);
  Bun.spawnSync(["git", "-C", folder, "pull", "-q"]);
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(daemonWarning(folder));
  expect(run.out).toBe("old Skelcrew ran ps\n");
  expect(runAdvice(run.err)).toBe(0);
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

// The sc you run can be a copy at your commit while the daemon's service runs an old checkout.
test("--remote warns about the checkout the daemon's service runs, not the sc on the PATH", async () => {
  const folder = checkoutOnServer("skelcrew", false);
  commit(laptop.folder);
  installed(at(laptop.folder));
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(behindWarning(folder, at(laptop.folder)));
  expect(run.out).toBe("Skelcrew on the server got 1 arguments\n[ps]\n");
  expect(runAdvice(run.err)).toBe(0);
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

// Restarting the service starts the daemon from its checkout, wherever it was started from.
test("--remote warns about a daemon started from another checkout than its service's", async () => {
  const folder = checkoutOnServer();
  const code = join(home, "server", ".local", "share", "skelcrew", "daemon-code");
  writeFileSync(code, readFileSync(code, "utf8").replace(folder, join(home, "elsewhere")));
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(daemonWarning(folder));
  expect(runAdvice(run.err)).toBe(0);
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

// A daemon from before daemons wrote down their commit can't say what it runs.
test("--remote warns about a daemon that doesn't say which commit it runs", async () => {
  const folder = checkoutOnServer();
  rmSync(join(home, "server", ".local", "share", "skelcrew", "daemon-code"));
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe(daemonWarning(folder));
});

test("--remote says to put local changes aside first in a checkout behind your commit", async () => {
  const folder = checkoutOnServer();
  commit(laptop.folder);
  writeFileSync(join(folder, "src", "main.ts"), "// a change on the server\n");
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe(
    behindWarning(
      folder,
      at(laptop.folder),
      at(laptop.folder),
      "It has local changes, so commit or stash them, then",
    ),
  );
  expect(run.out).toBe("old Skelcrew ran ps\n");
});

// Local changes on the server don't change which commit it is at.
test("--remote says nothing when the server's checkout, with local changes, is at your commit", async () => {
  const folder = checkoutOnServer();
  writeFileSync(join(folder, "src", "main.ts"), "// a change on the server\n");
  const run = await skel(["--remote", "simon@workbox", "ps"]);
  expect(run.err).toBe("");
  expect(run.out).toBe("old Skelcrew ran ps\n");
});

test("--remote says nothing when the server's checkout and its daemon are past your commit", async () => {
  commit(checkoutOnServer());
  daemonRestarts();
  expect((await skel(["--remote", "simon@workbox", "ps"])).err).toBe("");
});

test("--remote from a release warns when the server's checkout lacks its tag, and says how to reach it", async () => {
  const folder = checkoutOnServer();
  const release = ["--define", 'SKELCREW_BUILD="0.4.2"'];
  // The release is a commit the server hasn't fetched yet.
  commit(laptop.folder);
  Bun.spawnSync(["git", "-C", laptop.folder, "tag", "v0.4.2"]);
  const behind = await skel(["--remote", "simon@workbox", "ps"], "", home, release);
  expect(behind.err).toBe(behindWarning(folder, "0.4.2", "v0.4.2"));
  expect(behind.out).toBe("old Skelcrew ran ps\n");
  expect(runAdvice(behind.err)).toBe(0);
  expect((await skel(["--remote", "simon@workbox", "ps"], "", home, release)).err).toBe("");
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

// Writes the daemon's systemd unit on the server, starting the given Skelcrew with sc serve.
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
  expect(calls()).not.toMatch(/^systemctl --user restart/m);
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
  expect(calls()).not.toMatch(/^systemctl --user restart/m);
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
  expect(calls()).not.toMatch(/^systemctl --user restart/m);
});

// Gives the test's home a finished first run, as setupDone reads it: a harness chosen, its login
// and the daemon's service.
function firstRunDone(): void {
  const config = join(home, ".config", "skelcrew");
  const codex = join(home, ".local", "share", "skelcrew", "codex");
  const units = join(home, ".config", "systemd", "user");
  for (const folder of [config, codex, units]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  writeFileSync(join(codex, "auth.json"), "login\n");
  writeFileSync(join(units, "skelcrew.service"), "");
}

// Runs main.ts as the Skelcrew on a server would run it, built from the given commit
// or from a checkout, asked for its help by a laptop with the given build. The server's first
// run is done, so the build is what decides.
function farSkel(built: string | null, laptopBuild?: string, args = ["--help"]) {
  firstRunDone();
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
  const run = farSkel("abc1234", "def5678", [
    "sidebar",
    socket,
    "screen-1",
    "local",
    "simon/app",
    "",
  ]);
  expect(run.code).toBe(1);
  expect(run.out).toBe("");
});

// Out of date, Skelcrew there would have the laptop copy things, so a machine that isn't set up
// says so first, and the laptop asks.
test("a copied Skelcrew that isn't set up says so before its build is checked", () => {
  const run = Bun.spawnSync(
    [process.execPath, "--define", 'SKELCREW_BUILD="abc1234"', laptop.main, "ps"],
    {
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        SKELCREW_REMOTE_NAME: "x",
        SKELCREW_LAPTOP_BUILD: "def5678",
        SKELCREW_LAPTOP_LOCK: "another",
      },
    },
  );
  expect(run.exitCode).toBe(97);
  expect(run.stdout.toString()).toBe("");
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

// The old way of updating Skelcrew on a server reaches nothing.
test("Skelcrew update is gone", async () => {
  const run = await skel(["update", "--remote", "simon@workbox"]);
  expect(run.err).toStartWith("Skelcrew: plugin commands are under sc plugin now");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("install puts Skelcrew on a server after asking, then runs sc install there", async () => {
  const run = await skelInTerminal(["--remote", "simon@workbox", "install"], [""]);
  expect(run.code).toBe(0);
  expect(run.wrote).toContain("simon@workbox has no Skelcrew. Put yours there? [Y/n]");
  expect(run.wrote).toContain("sc install on the server\r\n");
  const lines = calls().split("\n");
  expect(lines[0]).toBe(onServer(" install"));
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
  expect(lines[6]).toBe(onServer(" install", null));
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(readFileSync(join(home, "server", ".local", "bin", "sc"), "utf8")).toBe(
    serverSkel(laptop.commit),
  );
});

// A server can have your old setup but no sc, such as after sc was deleted there. A no to
// putting Skelcrew there must leave that setup as it was.
test("a no to putting Skelcrew on a server leaves its files as they were", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  const there = join(home, "server", ".config", "skelcrew");
  mkdirSync(there, { recursive: true });
  writeFileSync(join(there, "config.yaml"), "harness: claude\n");
  writeFileSync(join(there, "claude-token"), "sk-ant-oat01-old");
  const run = await skelInTerminal(["--remote", "simon@workbox", "install"], ["n"]);
  expect(run.code).toBe(1);
  expect(readdirSync(there).sort()).toEqual(["claude-token", "config.yaml"]);
  expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe("harness: claude\n");
});

test("install puts nothing on a server without Skelcrew when you say no", async () => {
  const run = await skelInTerminal(["--remote", "simon@workbox", "install"], ["n"]);
  expect(run.code).toBe(1);
  expect(run.wrote).toContain(
    "Nothing was put there. To do it later, run:\r\n  sc --remote simon@workbox install",
  );
  expect(calls()).toBe(`${onServer(" install")}\n`);
});

test("without a terminal, install puts nothing on a server without Skelcrew", async () => {
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(1);
  expect(run.err).toEndWith(
    "Skelcrew: simon@workbox has no Skelcrew. To put it there, run this in a terminal:\n  sc --remote simon@workbox install\n",
  );
  expect(calls()).toBe(`${onServer(" install")}\n`);
});

// Each new ssh connection can ask for your passphrase or a touch of your key, so one setup
// shares one connection, through sockets in a folder only you can reach.
test("every ssh and scp for a setup shares one connection, through a private folder", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  await skelInTerminal(["--remote", "simon@workbox", "install"], [""]);
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

test("install sends your config.yaml, lock and Claude sign-in, readable only by you, before sc install there", async () => {
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "# mine\nharness: codex\n");
  writeFileSync(join(config, "skelcrew.lock"), pin("fake", "0.2.0"));
  writeFileSync(join(config, "claude-token"), "sk-ant-oat01-secret");
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(0);
  expect(run.out).toBe(
    "Sending your config.yaml, skelcrew.lock, claude-token to simon@workbox.\nsc install on the server\n",
  );
  const lines = calls().trim().split("\n");
  const names = ["config.yaml", "skelcrew.lock", "claude-token"];
  // The files go through a folder of this transfer's own, which is gone once they are in place.
  const sending = lines[0]?.match(/mkdir \.config\/skelcrew\/(sending-[\w-]+)$/)?.[1] ?? "";
  expect(lines[0]).toBe(
    `${ssh} umask 077 && mkdir -p .config/skelcrew && mkdir .config/skelcrew/${sending}`,
  );
  // sc install runs holding a lock, and is told where your files are, to put them in place.
  expect(lines.at(-3)).toContain(" SKELCREW_LAPTOP_LOCK=");
  expect(lines.at(-3)).toContain(" flock .config/skelcrew/.install sh -c ");
  expect(lines.at(-3)).toMatch(new RegExp(` sh install --files ${sending}$`));
  expect(lines.at(-2)).toBe("flock .config/skelcrew/.install");
  // The folder sent through goes once the install is over.
  expect(lines.at(-1)).toBe(`${ssh} rm -rf .config/skelcrew/${sending}`);
  const there = join(home, "server", ".config", "skelcrew");
  expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe("# mine\nharness: codex\n");
  expect(readFileSync(join(there, "claude-token"), "utf8")).toBe("sk-ant-oat01-secret");
  for (const name of names) expect(lstatSync(join(there, name)).mode & 0o777).toBe(0o600);
  expect(readdirSync(there).sort()).toEqual([...names].sort());
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

// Your setup is the laptop's, so an old sign-in or pin never stays in use on the server. No lock
// pins nothing, so the server gets an empty one, and sc install there removes plugins it has.
test("install removes from the server a token you no longer have, and empties its lock", async () => {
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  const there = join(home, "server", ".config", "skelcrew");
  mkdirSync(there, { recursive: true });
  writeFileSync(join(there, "claude-token"), "sk-ant-oat01-old");
  writeFileSync(join(there, "skelcrew.lock"), pin("fake", "0.1.0"));
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(0);
  expect(readdirSync(there).sort()).toEqual(["config.yaml", "skelcrew.lock"]);
  expect(readFileSync(join(there, "skelcrew.lock"), "utf8")).toBe(
    "# Your personal plugins at their exact versions, written by Skelcrew. sc install installs them.\n",
  );
});

// Two installs at once each send through their own folder, so neither removes or moves the
// other's files.
test("two installs at once both send your files", async () => {
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  writeFileSync(join(config, "claude-token"), "sk-ant-oat01-secret");
  installed(laptop.commit);
  const runs = await Promise.all([1, 2].map(() => skel(["--remote", "simon@workbox", "install"])));
  expect(runs.map((run) => run.code)).toEqual([0, 0]);
  const folders = calls().match(/mkdir \.config\/skelcrew\/sending-[\w-]+$/gm) ?? [];
  expect(new Set(folders).size).toBe(2);
  expect(readdirSync(join(home, "server", ".config", "skelcrew")).sort()).toEqual([
    "claude-token",
    "config.yaml",
    "skelcrew.lock",
  ]);
});

// A plugin's setup there is handed the repository you are in, as on the laptop.
test("install passes the repository you are in to sc install there", async () => {
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"], "", checkout("simon/app"));
  expect(run.code).toBe(0);
  expect(calls()).toBe(`${onServer(" install --from git@github.com:simon/app.git")}\n`);
});

// A laptop with no setup only reaches servers, and each keeps the setup it has.
// A run that stops before installing, such as to update Skelcrew there, leaves your files for the
// next, which installs from them.
test("install after updating Skelcrew there installs from your files", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  installed("0000000");
  const run = await skel(["--remote", "simon@workbox", "install"], "y\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("Updated simon@workbox");
  expect(readFileSync(join(home, "server", "installed-from"), "utf8")).toBe("harness: codex\n");
  expect(readdirSync(join(home, "server", ".config", "skelcrew")).sort()).toEqual([
    "config.yaml",
    "skelcrew.lock",
  ]);
});

test("install with no files of yours sends nothing and runs sc install there", async () => {
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(0);
  expect(calls()).toBe(`${onServer(" install")}\n`);
});

test("install builds Skelcrew for the server's CPU", async () => {
  writeFileSync(join(home, "serverbin", "uname"), "#!/bin/sh\necho aarch64\n", { mode: 0o755 });
  const run = await skelInTerminal(["--remote", "simon@workbox", "install"], [""]);
  expect(run.code).toBe(0);
  expect(calls()).toContain("bun build --compile --target=bun-linux-arm64 ");
});

test("a failed sc install there fails here", async () => {
  installed(laptop.commit);
  writeFileSync(join(home, "server", "install-fails"), "");
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(1);
});

// A pin in a lock, at the given version.
const pin = (name: string, version: string) =>
  `simon/skelcrew-${name}:\n  name: ${name}\n  version: ${version}\n  commit: ${"a".repeat(40)}\n`;

// Gives the laptop your config naming two plugins, a lock pinning both, and the machine plugin
// box installed, which only reaches machines from the laptop.
function laptopWithMachinePlugin(): void {
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    "harness: codex\nplugins:\n  - simon/skelcrew-fake\n  - simon/skelcrew-box\n",
  );
  writeFileSync(
    join(config, "skelcrew.lock"),
    `# pins\n${pin("box", "0.1.0")}${pin("fake", "0.2.0")}`,
  );
  const box = join(home, "box");
  mkdirSync(box);
  writeFileSync(
    join(box, "skelcrew-plugin.yaml"),
    "name: box\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Reaches boxes.\nkind: runtime\nprovides: [machine]\nadd: [./add]\nexec: [./exec]\npush: [./push]\n",
  );
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, "skelcrew.db"));
  db.run("CREATE TABLE plugins (name TEXT PRIMARY KEY, folder TEXT NOT NULL, source TEXT)");
  db.run("INSERT INTO plugins VALUES ('box', ?, 'simon/skelcrew-box')", [box]);
  db.close();
}

test("install leaves out a plugin that only reaches machines, from your config and your lock", async () => {
  laptopWithMachinePlugin();
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(0);
  const there = join(home, "server", ".config", "skelcrew");
  expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe(
    "harness: codex\nplugins:\n  - simon/skelcrew-fake\n",
  );
  expect(readFileSync(join(there, "skelcrew.lock"), "utf8")).toBe(
    `# Your personal plugins at their exact versions, written by Skelcrew. sc install installs them.\n${pin("fake", "0.2.0")}`,
  );
  // The laptop's own files stay as they were.
  expect(readFileSync(join(home, ".config", "skelcrew", "skelcrew.lock"), "utf8")).toContain("box");
});

// Only a lock makes a plugin yours, so a laptop with none sends an empty one and its config as it
// is, and pins nothing from the plugins it has.
test("install from a laptop with no lock sends an empty lock, pinning nothing", async () => {
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  const fake = join(home, "fake");
  mkdirSync(fake);
  writeFileSync(
    join(fake, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.3.0\nskelcrew: 0.1.0\nabout: Tracks.\nkind: io\nprovides: [tracker]\ncall: [./call]\n",
  );
  const data = join(home, ".local", "share", "skelcrew");
  mkdirSync(data, { recursive: true });
  const db = new Database(join(data, "skelcrew.db"));
  db.run("CREATE TABLE plugins (name TEXT PRIMARY KEY, folder TEXT NOT NULL, source TEXT)");
  db.run("INSERT INTO plugins VALUES ('fake', ?, 'simon/skelcrew-fake')", [fake]);
  db.close();
  installed(laptop.commit);
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.code).toBe(0);
  const there = join(home, "server", ".config", "skelcrew");
  expect(readFileSync(join(there, "config.yaml"), "utf8")).toBe("harness: codex\n");
  expect(readFileSync(join(there, "skelcrew.lock"), "utf8")).toBe(
    "# Your personal plugins at their exact versions, written by Skelcrew. sc install installs them.\n",
  );
  expect(existsSync(join(config, "skelcrew.lock"))).toBe(false);
});

// Makes the server run this checkout's real Skelcrew, set up with Codex, with the plugin fake
// from simon/skelcrew-fake installed, named in its config and pinned in its lock, as sc remote
// add left a server whose laptop had it.
function realServerWithFake(): void {
  const server = join(home, "server");
  mkdirSync(join(server, ".local", "bin"), { recursive: true });
  writeFileSync(
    join(server, ".local", "bin", "sc"),
    `#!/bin/sh\nexec ${process.execPath} ${laptop.main} "$@"\n`,
    { mode: 0o755 },
  );
  const config = join(server, ".config", "skelcrew");
  const data = join(server, ".local", "share", "skelcrew");
  for (const folder of [config, join(data, "codex")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(data, "codex", "auth.json"), "login\n");
  writeFileSync(join(data, "set-up"), "");
  writeFileSync(join(config, "config.yaml"), "harness: codex\nplugins: [simon/skelcrew-fake]\n");
  const fake = join(data, "plugins", "fake", "0.1.0");
  mkdirSync(fake, { recursive: true });
  writeFileSync(
    join(fake, "skelcrew-plugin.yaml"),
    "name: fake\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Tracks.\nkind: io\nprovides: [tracker]\ncall: [./call]\n",
  );
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", fake, "-c", "user.name=t", "-c", "user.email=t", ...args], {
      stdout: "pipe",
    });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fake");
  const commit = git("rev-parse", "HEAD").stdout.toString().trim();
  writeFileSync(
    join(config, "skelcrew.lock"),
    `simon/skelcrew-fake:\n  name: fake\n  version: 0.1.0\n  commit: ${commit}\n`,
  );
  const db = new Database(join(data, "skelcrew.db"));
  db.run("CREATE TABLE plugins (name TEXT PRIMARY KEY, folder TEXT NOT NULL, source TEXT)");
  db.run("INSERT INTO plugins VALUES ('fake', ?, 'simon/skelcrew-fake')", [fake]);
  db.close();
}

// Your files say which plugins your machines run, as npm's lock does, so one you removed on the
// laptop goes from the server too.
test("install removes from the server a plugin you removed on your laptop", async () => {
  realServerWithFake();
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\nplugins: []\n");
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.err).toBe("");
  expect(run.out).toContain("Removed fake, with its settings and tokens.");
  expect(run.code).toBe(0);
  const server = join(home, "server");
  expect(existsSync(join(server, ".local", "share", "skelcrew", "plugins", "fake"))).toBe(false);
  const db = new Database(join(server, ".local", "share", "skelcrew", "skelcrew.db"));
  expect(db.query("SELECT name FROM plugins").all()).toEqual([]);
  db.close();
  expect(readFileSync(join(server, ".config", "skelcrew", "config.yaml"), "utf8")).toBe(
    "harness: codex\nplugins: []\n",
  );
  // The folder the files were sent through is gone.
  expect(readdirSync(join(server, ".config", "skelcrew")).sort()).toEqual([
    "config.yaml",
    "skelcrew.lock",
  ]);
});

// The laptop leaves out a plugin that only reaches machines when it has it installed. One your
// files name that the laptop doesn't have yet is told apart on the server, by its manifest.
test("install skips a plugin that only reaches machines, even one the laptop hasn't installed", async () => {
  realServerWithFake();
  // simon/skelcrew-box on a fake GitHub the server reaches, tagged v0.1.0.
  const box = join(home, "github", "simon", "skelcrew-box");
  mkdirSync(box, { recursive: true });
  writeFileSync(
    join(box, "skelcrew-plugin.yaml"),
    "name: box\nversion: 0.1.0\nskelcrew: 0.1.0\nabout: Reaches boxes.\nkind: runtime\nprovides: [machine]\nadd: [./add]\nexec: [./exec]\npush: [./push]\n",
  );
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", box, "-c", "user.name=t", "-c", "user.email=t", ...args], {
      stdout: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "box");
  git("tag", "v0.1.0");
  const commit = git("rev-parse", "HEAD").stdout.toString().trim();
  writeFileSync(
    join(home, "server", ".gitconfig"),
    `[url "file://${home}/github/"]\n\tinsteadOf = https://github.com/\n`,
  );
  // The laptop's files name box, and keep fake, but the laptop has neither installed.
  const config = join(home, ".config", "skelcrew");
  mkdirSync(config, { recursive: true });
  writeFileSync(
    join(config, "config.yaml"),
    "harness: codex\nplugins: [simon/skelcrew-fake, simon/skelcrew-box]\n",
  );
  const fake = readFileSync(join(home, "server", ".config", "skelcrew", "skelcrew.lock"), "utf8");
  writeFileSync(
    join(config, "skelcrew.lock"),
    `${fake}simon/skelcrew-box:\n  name: box\n  version: 0.1.0\n  commit: ${commit}\n`,
  );
  const run = await skel(["--remote", "simon@workbox", "install"]);
  expect(run.err).toBe("");
  expect(run.out).toContain(
    "Skelcrew skipped box, which only reaches machines, so it belongs where you run sc --remote, not here.",
  );
  expect(run.out).not.toContain("isn't set up yet");
  expect(run.code).toBe(0);
  const db = new Database(join(home, "server", ".local", "share", "skelcrew", "skelcrew.db"));
  expect(db.query("SELECT name FROM plugins").all()).toEqual([{ name: "fake" }]);
  db.close();
});

// --files names a folder the laptop made, so a path that leads elsewhere moves nothing.
test("sc install refuses --files that isn't a folder of sent files", () => {
  for (const folder of ["../../elsewhere", "/tmp/x", "sending-a/../.."]) {
    const run = Bun.spawnSync([process.execPath, laptop.main, "install", "--files", folder], {
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toBe(`Skelcrew: ${folder} isn't a folder of sent files\n`);
  }
});

// Runs main.ts as the Skelcrew on a set-up server would run it, for a laptop that passes the
// given lock fingerprint, and returns what it said on stderr.
function serverSaid(lock: string): string {
  const server = join(home, "server");
  const config = join(server, ".config", "skelcrew");
  const codex = join(server, ".local", "share", "skelcrew", "codex");
  const units = join(server, ".config", "systemd", "user");
  for (const folder of [config, codex, units]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(codex, "auth.json"), "login\n");
  writeFileSync(join(units, "skelcrew.service"), "");
  // A server that got no config.yaml from the laptop has its own.
  if (!existsSync(join(config, "config.yaml")))
    writeFileSync(join(config, "config.yaml"), "harness: codex\n");
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: server,
    SKELCREW_REMOTE_NAME: "simon@workbox",
    SKELCREW_LAPTOP_LOCK: lock,
  };
  const run = Bun.spawnSync([process.execPath, laptop.main, "--help"], { env });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("USAGE");
  return run.stderr.toString();
}

// You send your setup when you change it, so a server whose lock differs says so, and runs the
// command anyway.
test("--remote says when the server's lock differs from yours, and how to send yours", async () => {
  laptopWithMachinePlugin();
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "install"]);
  await skel(["--remote", "simon@workbox", "ps"]);
  const lock = calls().match(/ SKELCREW_LAPTOP_LOCK=(\w+) sh -c .* sh ps$/m)?.[1] ?? "";
  expect(lock).not.toBe("");
  // The server took the laptop's lock, without the machine plugin, so they match.
  expect(serverSaid(lock)).toBe("");
  const there = join(home, "server", ".config", "skelcrew", "skelcrew.lock");
  writeFileSync(there, pin("fake", "0.1.0"));
  expect(serverSaid(lock)).toBe(
    "Your lock on simon@workbox differs from your laptop's. To send yours there, run on your laptop:\n  sc --remote simon@workbox install\n",
  );
  rmSync(there);
  expect(serverSaid(lock)).toContain("differs from your laptop's");
});

// No lock pins nothing, so a laptop without one still tells a server that pins plugins.
test("--remote from a laptop with no lock says when the server has one", async () => {
  mkdirSync(join(home, ".config", "skelcrew"), { recursive: true });
  writeFileSync(join(home, ".config", "skelcrew", "config.yaml"), "harness: codex\n");
  installed(laptop.commit);
  await skel(["--remote", "simon@workbox", "ps"]);
  const lock = calls().match(/ SKELCREW_LAPTOP_LOCK=(\w+) sh -c .* sh ps$/m)?.[1] ?? "";
  expect(lock).not.toBe("");
  expect(serverSaid(lock)).toBe("");
  writeFileSync(join(home, "server", ".config", "skelcrew", "skelcrew.lock"), pin("fake", "0.1.0"));
  expect(serverSaid(lock)).toContain("differs from your laptop's");
});

test("sc remote add names what replaced it", async () => {
  const run = await skel(["remote", "add", "simon@workbox"]);
  expect(run.err).toBe(
    "Skelcrew: sc remote add is now sc --remote <host> install, such as sc --remote simon@workbox install.\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("a host that names a machine plugin is refused, not taken as an SSH host", async () => {
  for (const plugin of ["sprite", "3cloud"]) {
    for (const args of [
      ["--remote", `${plugin}:demo`, "install"],
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
      ["--remote", host, "install"],
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
  const said = Bun.spawnSync([process.execPath, laptop.main, "install"], { env }).stderr;
  expect(said.toString()).toContain("only for your own terminal");
  expect(calls()).toBe("");
});

// Drops `shot` onto the server's screen through the laptop's sc --remote, with Enter right after,
// and returns the line the screen there got and the screen's name. With `cut`, the paste comes
// in two pieces, cut there, 200 ms apart, as over a slow link. The screen there reads one
// line, as an agent would, once it knows the name the laptop gave it. The server's sidebar
// answers that the screen shows the agent whose folder is ~/agent, with a mark that changes at
// each answer.
async function dropOnServer(shot: string, cut = 0): Promise<{ got: string; screen: string }> {
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  writeFileSync(
    join(home, "server", ".local", "bin", "sc"),
    `#!/bin/sh\necho "$SKELCREW_SCREEN_NAME" > screen-name\nIFS= read -r line\nprintf '%s\\n' "$line" > got\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(home, "serverbin", "tmux"),
    `#!/bin/sh\necho "tmux $*" >> "${join(home, "calls")}"\nn=$(($(cat n 2>/dev/null || echo 0) + 1)); echo $n > n\necho "$n $HOME/agent"\n`,
    { mode: 0o755 },
  );
  const run = Bun.spawn([process.execPath, laptop.main, "--remote", "simon@workbox"], {
    cwd: home,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
    terminal: {},
  });
  const named = join(home, "server", "screen-name");
  for (let waited = 0; !existsSync(named) && waited < 100; waited++) await Bun.sleep(50);
  const dropped = `\x1b[200~${shot.replaceAll(" ", "\\ ")}\x1b[201~\r`;
  run.terminal?.write(dropped.slice(0, cut));
  if (cut > 0) await Bun.sleep(200);
  run.terminal?.write(dropped.slice(cut));
  await run.exited;
  run.terminal?.close();
  const got = readFileSync(join(home, "server", "got"), "utf8").trim();
  return { got, screen: readFileSync(named, "utf8").trim() };
}

test("a file dropped onto the server's screen is sent to the agent it shows, and the paste says where", async () => {
  const shot = join(home, "Screen Shot.png");
  writeFileSync(shot, "pixels");
  // Enter pressed right after the drop waits for its paste.
  const { got, screen } = await dropOnServer(shot);
  expect(screen).toMatch(/^screen-\w+$/);
  // It reads the sidebar's answer there, by the screen's name.
  expect(calls()).toContain(`tmux -L skelcrew-screen display -p -t =${screen}: #{@drop-answer}`);
  const agent = join(home, "server", "agent", ".skelcrew-drops");
  // The drop's question, a right click on the top row, goes just ahead of the paste.
  expect(got.startsWith(`\x1b[<2;9999;1M\x1b[<2;9999;1m\x1b[200~${agent}/`)).toBe(true);
  expect(got.endsWith("/Screen\\ Shot.png\x1b[201~")).toBe(true);
  const copy = got
    .slice(got.indexOf("\x1b[200~") + "\x1b[200~".length, -"\x1b[201~".length)
    .replaceAll("\\ ", " ");
  expect(readFileSync(copy, "utf8")).toBe("pixels");
  // Git never sees the copy, so a builder doesn't commit it.
  expect(readFileSync(join(agent, ".gitignore"), "utf8")).toBe("*\n");
});

test("a file dropped onto the server's screen is sent though its paste's start comes in two pieces", async () => {
  const shot = join(home, "shot.png");
  writeFileSync(shot, "pixels");
  const { got } = await dropOnServer(shot, 3);
  const agent = join(home, "server", "agent", ".skelcrew-drops");
  expect(got.startsWith(`\x1b[<2;9999;1M\x1b[<2;9999;1m\x1b[200~${agent}/`)).toBe(true);
  expect(got.endsWith("/shot.png\x1b[201~")).toBe(true);
});

test("a drops folder on the server whose .gitignore doesn't ignore everything gets no copies", async () => {
  const drops = join(home, "server", "agent", ".skelcrew-drops");
  mkdirSync(drops, { recursive: true });
  writeFileSync(join(drops, ".gitignore"), "*.tmp\n");
  const shot = join(home, "shot.png");
  writeFileSync(shot, "pixels");
  const { got } = await dropOnServer(shot);
  expect(got).toBe(`\x1b[<2;9999;1M\x1b[<2;9999;1m\x1b[200~${shot}\x1b[201~`);
  expect(readdirSync(drops)).toEqual([".gitignore"]);
});

test("a dropped file named .gitignore reaches the server's agent like any other", async () => {
  mkdirSync(join(home, "project"));
  const ignore = join(home, "project", ".gitignore");
  writeFileSync(ignore, "dist\n");
  const { got } = await dropOnServer(ignore);
  const copy = got.slice(got.indexOf("\x1b[200~") + "\x1b[200~".length, -"\x1b[201~".length);
  expect(copy.startsWith(join(home, "server", "agent", ".skelcrew-drops"))).toBe(true);
  expect(copy.endsWith("/.gitignore")).toBe(true);
  expect(readFileSync(copy, "utf8")).toBe("dist\n");
});

test("a drops folder on the server that the agent made a link out of its folder is never written through", async () => {
  // A link out to a folder of yours there, with a .gitignore of its own.
  const yours = join(home, "server", "yours");
  mkdirSync(join(home, "server", "agent"), { recursive: true });
  mkdirSync(yours);
  writeFileSync(join(yours, ".gitignore"), "node_modules\n");
  symlinkSync(yours, join(home, "server", "agent", ".skelcrew-drops"));
  const shot = join(home, "shot.png");
  writeFileSync(shot, "pixels");
  const { got } = await dropOnServer(shot);
  expect(got).toBe(`\x1b[<2;9999;1M\x1b[<2;9999;1m\x1b[200~${shot}\x1b[201~`);
  expect(readdirSync(yours)).toEqual([".gitignore"]);
  expect(readFileSync(join(yours, ".gitignore"), "utf8")).toBe("node_modules\n");
});

test("a text paste reaches the server's screen as it was", async () => {
  mkdirSync(join(home, "server", ".local", "bin"), { recursive: true });
  writeFileSync(
    join(home, "server", ".local", "bin", "sc"),
    `#!/bin/sh\ntouch ready\nIFS= read -r line\nprintf '%s\\n' "$line" > got\n`,
    { mode: 0o755 },
  );
  const run = Bun.spawn([process.execPath, laptop.main, "--remote", "simon@workbox"], {
    cwd: home,
    env: { PATH: `${join(home, "bin")}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
    terminal: {},
  });
  const ready = join(home, "server", "ready");
  for (let waited = 0; !existsSync(ready) && waited < 100; waited++) await Bun.sleep(50);
  run.terminal?.write("\x1b[200~/missing.png and text\x1b[201~\r");
  await run.exited;
  run.terminal?.close();
  expect(readFileSync(join(home, "server", "got"), "utf8")).toBe(
    "\x1b[200~/missing.png and text\x1b[201~\n",
  );
  expect(calls()).not.toContain("tmux");
});
