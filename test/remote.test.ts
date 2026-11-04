// skel --remote, run as you would run it on your laptop, against a fake ssh and scp that
// play a server in a folder of the test, and a fake bun that builds a stand-in skel.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  for (const folder of ["bin", "server", "tmp"]) mkdirSync(join(home, folder));
  // Like ssh, it joins the words after the host into one line for the server's shell, which
  // runs in the server's home with the bare PATH a command over ssh gets.
  fake(
    "ssh",
    `test "$1" = -t && shift
shift
cd "$HOME/server" && HOME="$HOME/server" PATH=/usr/bin:/bin exec sh -c "$*"`,
  );
  fake("scp", `cp "$1" "$HOME/server/\${2#*:}"`);
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
  expect(lines[2]).toBe("ssh simon@workbox mkdir -p .local/bin");
  expect(lines[3]).toMatch(new RegExp(`^scp ${home}/tmp/\\S+/skel simon@workbox:.local/bin/skel$`));
  expect(lines[4]).toBe(lines[0]);
  expect(readFileSync(join(home, "server", ".local", "bin", "skel"), "utf8")).toBe(serverSkel);
  // The build is removed once copied.
  expect(readdirSync(join(home, "tmp"))).toEqual([]);
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
