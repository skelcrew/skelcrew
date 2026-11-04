// skel --remote sprite:<name>, run as you would run it on your laptop, against a fake sprite
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

const main = join(import.meta.dir, "..", "src", "main.ts");
let home = "";

// The skel the fake bun builds: it says what reached it, one argument per line, so a test
// can see that each one arrived exactly as typed.
const spriteSkel = `#!/bin/sh
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
  fake(
    "bun",
    `while [ $# -gt 1 ]; do test "$1" = --outfile && out=$2; shift; done
cat > "$out" <<'EOF'
${spriteSkel}EOF
chmod +x "$out"`,
  );
  fake("sprite-env", "");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Makes a Sprite with skel already copied to it.
function existing(name: string): void {
  const bin = join(home, "sprites", name, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "skel"), spriteSkel, { mode: 0o755 });
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
  const run = Bun.spawn([process.execPath, main, ...args], {
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

const exec = (name: string) => `sprite exec -s ${name} --tty -- sh -c exec skel "$@" skel`;

test("runs skel on the Sprite with the repository you are in", async () => {
  existing("demo");
  const run = await skel(["--remote", "sprite:demo"], "", checkout("simon/app"));
  expect(calls()).toBe(`sprite list --json\n${exec("demo")} --from simon/app\n`);
  expect(run.out).toBe("skel on the Sprite got 2 arguments\n[--from]\n[simon/app]\n");
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

test("asks before creating a Sprite, and creates none when you say no", async () => {
  const run = await skel(["--remote", "sprite:demo"], "n\n");
  expect(run.out).toContain("skel · No Sprite named demo. Create it? [y/N]");
  expect(run.out).toContain("no Sprite was created");
  expect(run.code).toBe(1);
  expect(calls()).toBe("sprite list --json\n");
  expect(readdirSync(join(home, "sprites"))).toEqual([]);
});

test("creates the Sprite, sets it up, and runs the first run there", async () => {
  const run = await skel(["--remote", "sprite:demo"], "y\n", checkout("simon/app"));
  expect(run.out).toEndWith("skel on the Sprite got 2 arguments\n[--from]\n[simon/app]\n");
  const lines = calls().split("\n");
  expect(lines[0]).toBe("sprite list --json");
  expect(lines[1]).toBe("sprite create --skip-console demo");
  const install = "sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap";
  expect(lines[2]).toBe(`sprite exec -s demo --no-stdin -- ${install}`);
  expect(lines[3]).toBe(install);
  // "the Sprite demo" would read as a demo of Sprites, so skel names it as you typed it.
  expect(run.out).toContain(
    "skel · setting up sprite:demo: installing bubblewrap and copying skel there.\n",
  );
  expect(run.out).not.toContain("debconf");
  // Built for the Sprite, which is Linux on x64, whatever the laptop runs.
  expect(lines[4]).toMatch(
    new RegExp(
      `^bun build --compile --target=bun-linux-x64 ${main} --outfile ${home}/tmp/\\S+/skel$`,
    ),
  );
  expect(lines[5]).toBe(
    "sprite exec -s demo --no-stdin -- sh -c mkdir -p .local/bin && rm -f .local/bin/skel.new",
  );
  expect(lines[6]).toMatch(
    new RegExp(`^sprite file push -s demo ${home}/tmp/\\S+/skel .local/bin/skel.new$`),
  );
  expect(lines[7]).toBe(
    "sprite exec -s demo --no-stdin -- sh -c mv -f .local/bin/skel.new .local/bin/skel",
  );
  expect(lines[8]).toBe(`${exec("demo")} --from simon/app`);
  expect(readFileSync(join(home, "sprites", "demo", ".local", "bin", "skel"), "utf8")).toBe(
    spriteSkel,
  );
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

test("offers to set up a Sprite that has no skel, then runs the command", async () => {
  mkdirSync(join(home, "sprites", "demo"));
  const run = await skel(["--remote", "sprite:demo", "ps"], "y\n");
  expect(run.out).toContain("skel · sprite:demo doesn't have skel installed.");
  expect(run.out).toEndWith("skel on the Sprite got 1 arguments\n[ps]\n");
  expect(calls()).toContain("sprite file push -s demo");
});

test("shows apt's output only when installing bubblewrap fails", async () => {
  writeFileSync(join(home, "apt-fails"), "");
  const run = await skel(["--remote", "sprite:demo"], "y\n");
  expect(run.code).toBe(1);
  expect(run.err).toContain("skel: couldn't install bubblewrap on sprite:demo:\n");
  expect(run.err).toContain("debconf: unable to initialize frontend: Dialog\n");
  expect(run.err).toContain("E: Unable to locate package bubblewrap");
  expect(calls()).not.toContain("sprite file push");
});

test("sets up nothing on a Sprite without skel when you say no", async () => {
  mkdirSync(join(home, "sprites", "demo"));
  const run = await skel(["--remote", "sprite:demo", "ps"], "n\n");
  expect(run.out).toContain("skel isn't on sprite:demo, so the command didn't run.");
  expect(run.code).toBe(1);
  expect(calls()).not.toContain("apt-get");
});

// sprite file push writes through a link, like scp, so a link left there would have the
// file it points to overwritten.
test("replaces a link at ~/.local/bin/skel instead of writing through it", async () => {
  const sprite = join(home, "sprites", "demo");
  mkdirSync(join(sprite, ".local", "bin"), { recursive: true });
  writeFileSync(join(sprite, "launcher"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
  symlinkSync(join(sprite, "launcher"), join(sprite, ".local", "bin", "skel"));
  const run = await skel(["--remote", "sprite:demo", "ps"], "y\n");
  expect(run.out).toEndWith("skel on the Sprite got 1 arguments\n[ps]\n");
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

async function update(laptop: { main: string }, name = "demo") {
  const run = Bun.spawn([process.execPath, laptop.main, "update", "--remote", `sprite:${name}`], {
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

test("update replaces skel on the Sprite and restarts its daemon's service", async () => {
  const sprite = join(home, "sprites", "demo", ".local", "bin", "skel");
  existing("demo");
  writeFileSync(sprite, "old skel");
  const laptop = laptopSkel();
  const run = await update(laptop);
  expect(run.code).toBe(0);
  expect(readFileSync(sprite, "utf8")).toBe(spriteSkel);
  const lines = calls().split("\n");
  expect(lines).toContain(
    "sprite exec -s demo --no-stdin -- sh -c mv -f .local/bin/skel.new .local/bin/skel",
  );
  // The daemon restarts only once the new skel is in place, so it runs the new build.
  expect(lines.at(-3)).toBe(
    "sprite exec -s demo --no-stdin -- sh -c sprite-env services restart skel",
  );
  expect(lines.at(-2)).toBe("sprite-env services restart skel");
  expect(run.out).toContain(
    `skel · updated sprite:demo to the skel in ~/code/skel (commit ${laptop.commit}) and restarted its daemon.`,
  );
  expect(run.out).toContain("the lead picks up new instructions when it's next started");
  expect(calls()).not.toContain("apt-get");
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
});

// A transfer that breaks off must leave the skel that works in place, or the daemon has
// nothing to restart with.
test("update keeps the old skel on the Sprite when the copy fails", async () => {
  existing("demo");
  const sprite = join(home, "sprites", "demo", ".local", "bin", "skel");
  writeFileSync(sprite, "old skel");
  writeFileSync(join(home, "push-fails"), "");
  const run = await update(laptopSkel());
  expect(run.code).toBe(1);
  expect(readFileSync(sprite, "utf8")).toBe("old skel");
  expect(calls()).not.toContain("services restart");
});

test("update leaves skel run from a checkout on the Sprite alone", async () => {
  const sprite = join(home, "sprites", "demo");
  mkdirSync(join(sprite, "skel", "bin"), { recursive: true });
  writeFileSync(join(sprite, "skel", "bin", "skel"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(join(sprite, ".local", "bin"), { recursive: true });
  symlinkSync(join(sprite, "skel", "bin", "skel"), join(sprite, ".local", "bin", "skel"));
  const run = await update(laptopSkel());
  expect(run.code).toBe(0);
  expect(run.out).toContain(
    `skel · skel on sprite:demo runs from a checkout at ${join(sprite, "skel")}, so it wasn't replaced.`,
  );
  expect(run.out).toContain("sprite-env services restart skel");
  expect(calls()).not.toContain("file push");
  expect(calls()).not.toContain("sprite-env services restart");
});

test("update creates no Sprite", async () => {
  const run = await update(laptopSkel());
  expect(run.code).toBe(1);
  expect(run.err).toContain("No Sprite named demo");
  expect(calls()).toBe("sprite list --json\n");
  expect(readdirSync(join(home, "sprites"))).toEqual([]);
});
