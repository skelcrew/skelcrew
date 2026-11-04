// skel --remote: runs a skel command on your server over ssh -t, from your laptop, and
// offers to copy skel there when it is missing. skel update --remote puts a new build there.
// Your laptop can be a Mac, so this file loads nothing of the skel that runs on the server.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { originHere } from "./origin.ts";
import { skelLine } from "./say.ts";

// A command over ssh gets a bare PATH: no login shell reads ~/.profile, and Ubuntu's
// ~/.bashrc stops early when nobody types into it. So ~/.local/bin, where skel copies
// itself and where Claude Code installs, is added here. env, since every shell runs it the
// same way.
const onServer = 'env PATH="$HOME/.local/bin:$PATH" skel';

// Returns a word the server's shell reads back exactly as given. ssh joins its words with
// spaces into one line for that shell, so a space, quote or $ would split or expand it.
export const quoted = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

// Runs a program with your terminal, so ssh can ask for a password and attach, and returns
// its exit code.
export const run = (argv: string[]) =>
  Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] }).exited;

// Runs a skel command on the host and returns its exit code. Plain skel passes the
// repository you are in on the laptop, so the lead knows it too. When the host has no
// skel, offers to copy it there, then runs the command.
export async function remote(host: string, args: string[]): Promise<number> {
  const from = args.length === 0 ? originHere() : null;
  const line = [onServer, ...(from ? ["--from", from] : args).map(quoted)].join(" ");
  const code = await run(["ssh", "-t", host, line]);
  // The server's shell exits 127 when it finds no skel to run. skel itself never does: it
  // exits 1 on any error.
  if (code !== 127) return code;
  console.log(`skel isn't installed on ${host}.`);
  const answer = prompt("Copy it to ~/.local/bin/skel there? [y/N]");
  if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
    console.log(`skel isn't on ${host}, so the command didn't run.`);
    return 1;
  }
  await withLinuxSkel((file) => copySkel(host, file));
  return run(["ssh", "-t", host, line]);
}

// Copies a skel built for the host to its ~/.local/bin.
async function copySkel(host: string, file: string): Promise<void> {
  // The copy goes to a file beside skel and is renamed over it once complete, so a transfer
  // that breaks off leaves the skel that works. scp writes through a link, so whatever
  // is at the new file's name is removed first. A rename replaces a link at skel itself,
  // such as one to a checkout's launcher, without touching the file it points to.
  if ((await run(["ssh", host, "mkdir -p .local/bin && rm -f .local/bin/skel.new"])) !== 0)
    throw new Error(`couldn't make ~/.local/bin on ${host}, so skel wasn't copied`);
  if ((await run(["scp", file, `${host}:.local/bin/skel.new`])) !== 0)
    throw new Error(`scp couldn't copy skel to ${host}`);
  if ((await run(["ssh", host, "mv -f .local/bin/skel.new .local/bin/skel"])) !== 0)
    throw new Error(`couldn't put the new skel in place on ${host}`);
}

// Updates skel on the host over ssh, where systemd runs the daemon.
export const updateServer = (host: string) =>
  update(host, {
    shell: (script) => ["ssh", host, script],
    copy: (file) => copySkel(host, file),
    restart: "systemctl --user restart skel",
  });

// How update reaches a server or a Sprite: the command that runs a shell line there, how a
// built skel is copied there, and the line that restarts the daemon's service there.
export type Machine = {
  shell: (script: string) => string[];
  copy: (file: string) => Promise<void>;
  restart: string;
};

// Runs a shell line on the machine and returns what it printed, quietly: the service
// commands print their logs, which matter only when they fail.
async function quietly(argv: string[]): Promise<{ said: string; ok: boolean }> {
  const ran = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(ran.stdout).text(),
    new Response(ran.stderr).text(),
    ran.exited,
  ]);
  return { said: `${out}${err}`.trim(), ok: code === 0 };
}

// Prints what you should know about the checkout skel is built from, and returns its folder
// and commit as skel names them. The build is the checkout as it is, so changes not
// committed, or a branch other than main, go along, which is allowed but worth a line.
function describeCheckout(): { folder: string; commit: string } {
  const folder = resolve(import.meta.dir, "..");
  const shown = folder.startsWith(`${homedir()}/`) ? `~${folder.slice(homedir().length)}` : folder;
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", folder, ...args], { stdout: "pipe", stderr: "pipe" })
      .stdout.toString()
      .trim();
  if (git("status", "--porcelain") !== "")
    console.log(skelLine(`${shown} has uncommitted changes, and they are copied too.`));
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") console.log(skelLine(`${shown} is on ${branch}, not main.`));
  return { folder: shown, commit: git("rev-parse", "--short", "HEAD") };
}

// Replaces skel on a server or Sprite with one built from this checkout, then restarts the
// daemon's service there so it runs the new build. The tmux server outlives the daemon, so
// the lead and builders keep their Claude Code running. A skel run from a checkout there is
// left alone: a copy would leave the checkout behind while the daemon kept running it.
export async function update(where: string, machine: Machine): Promise<number> {
  // What counts is the skel the daemon runs. On a server its service names it, and points at
  // a checkout once skel has run from one, even with a copy still in ~/.local/bin. A Sprite
  // service keeps the skel it was made with. A checkout's launcher, linked or not, is
  // bin/skel beside its sources.
  const script = `f=.local/bin/skel
u=.config/systemd/user/skel.service
if [ -f "$u" ]; then f=$(sed -n 's/^ExecStart="\\(.*\\)" serve$/\\1/p' "$u"); fi
d=$(dirname "$(readlink -f "$f")")/..
if [ -f "$d/src/main.ts" ]; then echo "checkout $(cd "$d" && pwd)"
elif [ -e "$f" ]; then echo copied
else echo missing; fi`;
  const asked = await quietly(machine.shell(script));
  const found = asked.said.match(/^(checkout (.+)|copied|missing)$/m);
  if (!found) throw new Error(`couldn't tell how skel is installed on ${where}:\n${asked.said}`);
  if (found[2]) {
    console.log(
      skelLine(
        `skel on ${where} runs from a checkout at ${found[2]}, so it wasn't replaced. git pull there updates it, and ${machine.restart} there restarts its daemon with it.`,
      ),
    );
    return 0;
  }
  if (found[1] === "missing")
    throw new Error(`skel isn't on ${where} yet: skel --remote ${where} sets it up`);
  const { folder, commit } = describeCheckout();
  await withLinuxSkel(machine.copy);
  const restarted = await quietly(machine.shell(machine.restart));
  if (!restarted.ok)
    throw new Error(
      `the new skel is on ${where}, but its daemon didn't restart, so it still runs the old one:\n${restarted.said}`,
    );
  console.log(
    skelLine(
      `updated ${where} to the skel in ${folder} (commit ${commit}) and restarted its daemon. The lead and builders keep running, and the lead picks up new instructions when it's next started.`,
    ),
  );
  return 0;
}

// Builds skel as one file for a server or Sprite, which is Linux on x64 whatever the laptop
// runs, hands it to copy, and removes it after. Built from this checkout each time, so the
// machine gets the skel you run here.
export async function withLinuxSkel(copy: (file: string) => Promise<void>): Promise<void> {
  // A single-file skel runs its modules from a folder only it sees, with no sources to
  // build from.
  if (import.meta.dir.startsWith("/$bunfs"))
    throw new Error("this skel is a single file and can't build one: run skel from a checkout");
  const folder = mkdtempSync(join(tmpdir(), "skel-"));
  try {
    const file = join(folder, "skel");
    console.log("Building skel for Linux.");
    const main = join(import.meta.dir, "main.ts");
    const target = "--target=bun-linux-x64";
    if ((await run(["bun", "build", "--compile", target, main, "--outfile", file])) !== 0)
      throw new Error("bun build failed, so skel wasn't copied");
    await copy(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
