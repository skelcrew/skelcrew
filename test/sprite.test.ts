// skel --remote sprite:<name> and skel remote add sprite:<name>, run as you would run them on
// your laptop, against a fake sprite
// command that plays Sprites in folders of the test, and a fake bun that builds a stand-in
// skel.
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
let laptop = { main: "", commit: "" };

// The skel the fake bun builds: it says what reached it, one argument per line, so a test
// can see that each one arrived exactly as typed. Built with a commit, it stops as a copied
// skel does when the laptop's build differs. Without one, it is a skel from before builds
// carried their commit.
const spriteSkel = (built?: string) => `#!/bin/sh
${built === undefined ? "" : `test -n "$SKEL_LAPTOP_BUILD" && test "$SKEL_LAPTOP_BUILD" != "${built}" && { echo "skel on $SKEL_REMOTE_NAME is from ${built}"; exit 98; }\n`}test "$1" = first-run && { echo "the first run on the Sprite"; test ! -f first-run-fails; exit; }
echo "skel on the Sprite got $# arguments"
for word in "$@"; do echo "[$word]"; done
exit 3
`;

// Each fake writes its calls to one log, even when run inside a Sprite with a home of its own.
function fake(name: string, body: string): void {
  const log = join(home, "calls");
  writeFileSync(join(home, "bin", name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, {
    mode: 0o755,
  });
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-sprite-test-")));
  for (const folder of ["bin", "sprites", "tmp"]) mkdirSync(join(home, folder));
  // Like the real sprite: list fails until you log in, exec runs its command as given in the
  // Sprite's home, with the PATH a Sprite gives it, and a command it can't find exits 1.
  fake(
    "sprite",
    `test -f "$HOME/logged-out" && { echo "Error: no organizations configured. Run 'sprite login' to authenticate" >&2; exit 1; }
case "$1" in
  list)
    printf '{"sprites":['
    sep=
    for d in "$HOME"/sprites/*/; do
      test -d "$d" || continue
      printf '%s{"name":"%s","status":"warm"}' "$sep" "$(basename "$d")"
      sep=,
    done
    printf '],"org":{"name":"simon"}}\\n' ;;
  create) mkdir "$HOME/sprites/$3" ;;
  exec)
    shift
    while [ "$1" != -- ]; do test "$1" = -s && { name=$2; shift; }; shift; done
    shift
    cd "$HOME/sprites/$name" || exit 1
    command -v "$1" > /dev/null || exit 1
    HOME=$PWD PATH="$PWD/.local/bin:${join(home, "bin")}:/usr/bin:/bin" exec "$@" ;;
  file) test -f "$HOME/push-fails" && exit 1; cp "$5" "$HOME/sprites/$4/$6" ;;
  config) test ! -f "$HOME/config-fails" || { echo "no such option" >&2; exit 1; } ;;
esac`,
  );
  // Like apt over sprite exec, which has no terminal for debconf's dialogs: it prints
  // warnings that look like errors even when the install works.
  fake(
    "sudo",
    `echo "debconf: unable to initialize frontend: Dialog"
test -f "${join(home, "apt-fails")}" && { echo "E: Unable to locate package bubblewrap" >&2; exit 100; }
exit 0`,
  );
  fake("node", 'echo "v22.0.0"');
  // Builds the stand-in skel with the commit skel stamps into the build.
  fake(
    "bun",
    `while [ $# -gt 1 ]; do
  test "$1" = --outfile && out=$2
  test "$1" = --define && built=$(echo "$2" | sed 's/^SKEL_BUILD="\\(.*\\)"$/\\1/')
  shift
done
sed "s/@BUILT@/$built/g" > "$out" <<'EOF'
${spriteSkel("@BUILT@")}EOF
chmod +x "$out"`,
  );
  // Like sprite-env on a Sprite: services get answers with the service as JSON, and fails
  // when there is none.
  fake(
    "sprite-env",
    `test "$1 $2 $3" = "services get skel" && { cat "$HOME/service.json" 2>/dev/null || exit 1; }
exit 0`,
  );
  laptop = laptopSkel();
});
// Returns a skel checkout of its own on the laptop, on main with one commit, so a test knows
// what is built and from which commit.
function laptopSkel(): { main: string; commit: string } {
  const folder = join(home, "code", "skel");
  cpSync(source(), join(folder, "src"), { recursive: true });
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

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Makes a Sprite with skel already copied to it, built from the given commit.
function existing(name: string, built?: string): void {
  const bin = join(home, "sprites", name, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "skel"), spriteSkel(built), { mode: 0o755 });
}

// Returns a checkout whose origin is the given GitHub repository.
function checkout(full: string): string {
  const folder = join(home, "app");
  mkdirSync(folder);
  Bun.spawnSync(["git", "init", "-q", folder]);
  Bun.spawnSync(["git", "-C", folder, "remote", "add", "origin", `git@github.com:${full}.git`]);
  return folder;
}

async function skel(args: string[], typed = "", cwd = home, path = join(home, "bin")) {
  const run = Bun.spawn([process.execPath, laptop.main, ...args], {
    cwd,
    env: { PATH: `${path}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, "tmp") },
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

// How skel runs itself on the Sprite: with the laptop's build, so a copied skel can tell it
// is out of date, or without, to run whatever skel is there. Always with the Sprite's name.
const exec = (name: string, build: string | null = laptop.commit) =>
  `sprite exec -s ${name} --tty -- env SKEL_REMOTE_NAME=sprite:${name} ${build ? `SKEL_LAPTOP_BUILD=${build} ` : ""}sh -c exec skel "$@" skel`;

// Runs skel in a terminal, and returns all it wrote there, escape codes included.
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

test("the raw command sprite puts in the title is replaced, and yours comes back", async () => {
  existing("demo");
  // The real sprite writes its own title as it connects, naming the command it runs.
  const sprite = join(home, "bin", "sprite");
  const said = readFileSync(sprite, "utf8").replace(
    "  exec)\n",
    "  exec)\n    printf '\\033]0;demo: raw command\\033\\\\'\n",
  );
  writeFileSync(sprite, said);
  const wrote = await skelInTerminal(["--remote", "sprite:demo", "ps"]);
  const saved = wrote.indexOf("\x1b[22;0t");
  const raw = wrote.indexOf("\x1b]0;demo: raw command");
  const short = wrote.indexOf("\x1b]2;skel · sprite:demo\x07");
  const skelRan = wrote.indexOf("skel on the Sprite got 1 arguments");
  expect([saved, raw, short, skelRan]).toEqual([saved, raw, short, skelRan].sort((a, b) => a - b));
  expect(saved).toBe(0);
  expect(wrote.endsWith("\x1b[23;0t")).toBe(true);
});

test("says it is connecting before anything reaches the Sprite, which can take a while to wake", async () => {
  existing("demo");
  const wrote = await skelInTerminal(["--remote", "sprite:demo", "ps"]);
  const connecting = wrote.indexOf("skel · connecting to sprite:demo…");
  expect(connecting).toBeGreaterThan(-1);
  expect(connecting).toBeLessThan(wrote.indexOf("skel on the Sprite got 1 arguments"));
});

test("keeps the connecting line out of a pipe, so a command's output stays its own", async () => {
  existing("demo");
  const run = await skel(["--remote", "sprite:demo", "ps"]);
  expect(run.out).not.toContain("connecting");
});

test("runs skel on the Sprite with the repository you are in", async () => {
  existing("demo");
  const run = await skel(["--remote", "sprite:demo"], "", checkout("simon/app"));
  expect(calls()).toBe(`sprite list --json\n${exec("demo")} --from git@github.com:simon/app.git\n`);
  expect(run.out).toBe(
    "skel on the Sprite got 2 arguments\n[--from]\n[git@github.com:simon/app.git]\n",
  );
  // What skel exits with on the Sprite is what skel exits with here.
  expect(run.code).toBe(3);
});

test("a command reaches the Sprite exactly as typed", async () => {
  existing("demo");
  const body = "Don't crash; it's \"bad\" when $HOME * `x` \\ happens\nTwice.";
  const run = await skel(
    ["--remote", "sprite:demo", "task", "create", "app", "Fix it", body, ""],
    "",
    checkout("simon/app"),
  );
  expect(run.out).toBe(
    `skel on the Sprite got 6 arguments\n[task]\n[create]\n[app]\n[Fix it]\n[${body}]\n[]\n`,
  );
});

test("lists what the laptop is missing, with the command to run again, and creates nothing", async () => {
  const run = await skel(["--remote", "sprite:demo", "ps"], "", home, join(home, "none"));
  expect(run.err).toStartWith("skel: install sprite, Fly.io's command for Sprites,");
  expect(run.err).toContain("curl -fsSL https://sprites.dev/install.sh | sh");
  expect(run.err).toContain("Then run skel --remote sprite:demo ps again.");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("says to log in when sprite isn't logged in", async () => {
  writeFileSync(join(home, "logged-out"), "");
  const run = await skel(["--remote", "sprite:demo"]);
  expect(run.err).toContain("sprite login");
  expect(run.err).toContain("Then run skel --remote sprite:demo again.");
  expect(run.code).toBe(1);
  expect(calls()).toBe("sprite list --json\n");
});

test("--remote only connects: it creates no Sprite and says how to set one up", async () => {
  const run = await skel(["--remote", "sprite:demo"]);
  expect(run.err).toBe(
    "skel: sprite:demo isn't set up. Run this on your laptop:\n  skel remote add sprite:demo\n",
  );
  expect(run.code).toBe(1);
  expect(calls()).toBe("sprite list --json\n");
  expect(readdirSync(join(home, "sprites"))).toEqual([]);
});

test("--remote only connects: it sets up nothing on a Sprite without skel", async () => {
  mkdirSync(join(home, "sprites", "demo"));
  const run = await skel(["--remote", "sprite:demo", "ps"]);
  expect(run.err).toContain("skel remote add sprite:demo");
  expect(run.code).toBe(1);
  expect(calls()).not.toContain("apt-get");
  expect(calls()).not.toContain("sprite file push");
});

test("shows apt's output only when installing bubblewrap fails", async () => {
  writeFileSync(join(home, "apt-fails"), "");
  const run = await skel(["remote", "add", "sprite:demo"], "y\n");
  expect(run.code).toBe(1);
  expect(run.out).not.toContain("debconf");
  expect(run.err).toContain("skel: couldn't install bubblewrap on sprite:demo:\n");
  expect(run.err).toContain("debconf: unable to initialize frontend: Dialog\n");
  expect(run.err).toContain("E: Unable to locate package bubblewrap");
  expect(calls()).not.toContain("sprite file push");
});

test("says why a Sprite's URL couldn't be made public", async () => {
  writeFileSync(join(home, "config-fails"), "");
  const run = await skel(["remote", "add", "sprite:demo"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain(
    "sprite couldn't make sprite:demo's URL public, so GitHub's webhooks can't wake it: no such option",
  );
});

// sprite file push writes through a link, like scp, so a link left there would have the
// file it points to overwritten.
test("replaces a link at ~/.local/bin/skel instead of writing through it", async () => {
  const sprite = join(home, "sprites", "demo");
  mkdirSync(join(sprite, ".local", "bin"), { recursive: true });
  writeFileSync(join(sprite, "launcher"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  symlinkSync(join(sprite, "launcher"), join(sprite, ".local", "bin", "skel"));
  const run = await skel(["remote", "add", "sprite:demo"]);
  expect(run.code).toBe(0);
  expect(readFileSync(join(sprite, "launcher"), "utf8")).toBe("#!/bin/sh\nexit 127\n");
  expect(lstatSync(join(sprite, ".local", "bin", "skel")).isSymbolicLink()).toBe(false);
});

// A name sprite would read as one of its own options must never reach it.
test("refuses a Sprite name that isn't one", async () => {
  const run = await skel(["--remote", "sprite:-o"]);
  expect(run.err).toContain("-o");
  expect(run.code).toBe(1);
  expect(calls()).toBe("");
});

test("runs the command with no offer when skel there is from the laptop's commit", async () => {
  existing("demo", laptop.commit);
  const run = await skel(["--remote", "sprite:demo", "ps"]);
  expect(run.out).toBe("skel on the Sprite got 1 arguments\n[ps]\n");
  expect(calls()).toBe(`sprite list --json\n${exec("demo")} ps\n`);
});

test("offers to update an out-of-date skel on the Sprite, updates it, then runs the command", async () => {
  existing("demo", "0000000");
  const run = await skel(["--remote", "sprite:demo", "ps"], "y\n");
  expect(run.out).toContain("skel on sprite:demo is from 0000000\n");
  expect(run.out).toContain("skel · Update it? [Y/n]");
  expect(run.out).toContain(
    `skel · updated sprite:demo to the skel in ~/code/skel (commit ${laptop.commit}) and restarted its daemon.`,
  );
  expect(run.out).toEndWith("skel on the Sprite got 1 arguments\n[ps]\n");
  const sprite = join(home, "sprites", "demo", ".local", "bin", "skel");
  expect(readFileSync(sprite, "utf8")).toBe(spriteSkel(laptop.commit));
  const lines = calls().trim().split("\n");
  expect(lines).toContain(
    "sprite exec -s demo --no-stdin -- sh -c mv -f .local/bin/skel.new .local/bin/skel",
  );
  // The daemon restarts only once the new skel is in place, so it runs the new build. A
  // Sprite whose URL was never made public wants a Fly.io login there, which GitHub's
  // webhooks can't give, so the URL goes public then, once the new daemon holds its port.
  // The command runs after that.
  expect(lines.at(-4)).toBe(
    "sprite exec -s demo --no-stdin -- sh -c sprite-env services restart skel",
  );
  expect(lines.at(-3)).toBe("sprite-env services restart skel");
  expect(lines.at(-2)).toBe("sprite config update --url-auth public -s demo");
  expect(lines.at(-1)).toBe(`${exec("demo", null)} ps`);
  expect(calls()).not.toContain("apt-get");
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("runs the command on the old skel on the Sprite when you say no", async () => {
  existing("demo", "0000000");
  const run = await skel(["--remote", "sprite:demo", "ps"], "n\n");
  expect(run.out).toContain("skel · running it on the old skel on sprite:demo.");
  expect(run.out).toEndWith("skel on the Sprite got 1 arguments\n[ps]\n");
  expect(calls()).not.toContain("file push");
});

// A transfer that breaks off must leave the skel that works in place, or the daemon has
// nothing to restart with.
test("the update keeps the old skel on the Sprite when the copy fails", async () => {
  existing("demo", "0000000");
  writeFileSync(join(home, "push-fails"), "");
  const run = await skel(["--remote", "sprite:demo", "ps"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("sprite couldn't copy skel to sprite:demo");
  const sprite = join(home, "sprites", "demo", ".local", "bin", "skel");
  expect(readFileSync(sprite, "utf8")).toBe(spriteSkel("0000000"));
  expect(calls()).not.toContain("services restart");
  // Until the new daemon holds port 8080, whatever else listens there would become public.
  expect(calls()).not.toContain("--url-auth");
});

// A Sprite service keeps the skel it was made with. Made from a checkout, a copy left in
// ~/.local/bin runs nothing the daemon does.
test("the update goes by what the Sprite service runs, not by ~/.local/bin", async () => {
  existing("demo", "0000000");
  const sprite = join(home, "sprites", "demo");
  mkdirSync(join(sprite, "skel", "bin"), { recursive: true });
  mkdirSync(join(sprite, "skel", "src"));
  writeFileSync(join(sprite, "skel", "bin", "skel"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(sprite, "skel", "src", "main.ts"), "");
  const service = { name: "skel", cmd: join(sprite, "skel", "bin", "skel"), args: ["serve"] };
  writeFileSync(join(sprite, "service.json"), JSON.stringify(service));
  const run = await skel(["--remote", "sprite:demo", "ps"], "y\n");
  expect(run.out).toContain(
    `skel · skel on sprite:demo runs from a checkout at ${join(sprite, "skel")}, so it wasn't replaced.`,
  );
  expect(run.out).toContain(
    "git pull there updates it, and the next skel there restarts its daemon on it.",
  );
  expect(run.out).toEndWith("skel on the Sprite got 1 arguments\n[ps]\n");
  expect(calls()).not.toContain("file push");
  expect(calls()).not.toContain("sprite-env services restart");
});

test("skel remote add creates the Sprite after asking, sets it up, and prints how to connect", async () => {
  // The Sprite is x64, whatever CPU this machine has.
  writeFileSync(join(home, "bin", "uname"), "#!/bin/sh\necho x86_64\n", { mode: 0o755 });
  const run = await skel(["remote", "add", "sprite:demo"], "y\n");
  expect(run.code).toBe(0);
  expect(run.out).toContain("skel · setting up sprite:demo: installing bubblewrap,");
  expect(run.out).toContain("skel · No Sprite named demo. Create it? [y/N]");
  expect(run.out).toContain("the first run on the Sprite\n");
  expect(run.out).toEndWith(
    "skel · sprite:demo is ready. Connect to it with:\n  skel --remote sprite:demo\n",
  );
  const lines = calls().split("\n");
  expect(lines[0]).toBe("sprite list --json");
  expect(lines[1]).toBe("sprite create --skip-console demo");
  const install = "sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap";
  expect(lines[2]).toBe(`sprite exec -s demo --no-stdin -- ${install}`);
  // A new Sprite's node writes to /etc on its first run, which the sandbox makes read-only,
  // so it runs once outside, right after bubblewrap.
  expect(lines[4]).toBe("sprite exec -s demo --no-stdin -- node --version");
  // GitHub's webhooks wake the Sprite through its URL, and GitHub has no Fly.io login.
  expect(lines[6]).toBe("sprite config update --url-auth public -s demo");
  // A first attempt comes first, which finds no skel. Then skel asks the Sprite's CPU, and
  // builds for Linux on it, whatever the laptop runs.
  expect(lines[7]).toBe(`${exec("demo")} first-run`);
  expect(lines[8]).toBe("sprite exec -s demo --no-stdin -- sh -c uname -m");
  expect(lines[9]).toMatch(
    new RegExp(
      `^bun build --compile --target=bun-linux-x64 --define SKEL_BUILD="${laptop.commit}" ${laptop.main} --outfile ${home}/tmp/\\S+/skel$`,
    ),
  );
  expect(lines[10]).toBe(
    "sprite exec -s demo --no-stdin -- sh -c mkdir -p .local/bin && rm -f .local/bin/skel.new",
  );
  expect(lines[11]).toMatch(
    new RegExp(`^sprite file push -s demo ${home}/tmp/\\S+/skel .local/bin/skel.new$`),
  );
  expect(lines[12]).toBe(
    "sprite exec -s demo --no-stdin -- sh -c mv -f .local/bin/skel.new .local/bin/skel",
  );
  // A fresh copy is the laptop's build, so it runs without the check.
  expect(lines[13]).toBe(`${exec("demo", null)} first-run`);
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
  expect(readFileSync(join(home, "sprites", "demo", ".local", "bin", "skel"), "utf8")).toBe(
    spriteSkel(laptop.commit),
  );
});

test("skel remote add creates nothing when you say no", async () => {
  const run = await skel(["remote", "add", "sprite:demo"], "n\n");
  expect(run.out).toContain("no Sprite was created");
  expect(run.code).toBe(1);
  expect(calls()).toBe("sprite list --json\n");
});

// A URL that failed to go public, or a first run that stopped, is finished by running add
// again, even though skel is already on the Sprite.
test("skel remote add again finishes the setup of a Sprite that has skel", async () => {
  existing("demo", laptop.commit);
  const run = await skel(["remote", "add", "sprite:demo"]);
  expect(run.code).toBe(0);
  const made = calls();
  expect(made).not.toContain("sprite create");
  expect(made).not.toContain("sprite file push");
  expect(made).toContain("sprite config update --url-auth public -s demo\n");
  expect(made).toContain(`${exec("demo")} first-run\n`);
});

test("skel remote add says what the laptop is missing, with the command to run again", async () => {
  const run = await skel(["remote", "add", "sprite:demo"], "", home, join(home, "none"));
  expect(run.err).toContain("Then run skel remote add sprite:demo again.");
  expect(run.code).toBe(1);
});

test("skel remote add refuses a Sprite name that isn't one", async () => {
  const run = await skel(["remote", "add", "sprite:--help"]);
  expect(run.err).toContain("can't name a Sprite");
  expect(calls()).toBe("");
});
