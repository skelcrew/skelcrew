// skel --remote: runs a skel command on your server over ssh -t, from your laptop. It offers
// to copy skel there when it is missing, and to replace it when it was built from another
// commit than yours. Your laptop can be a Mac, so this file loads nothing of the skel that
// runs on the server.
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { originHere } from "./origin.ts";
import { skelLine } from "./say.ts";

// A command over ssh gets a bare PATH: no login shell reads ~/.profile, and Ubuntu's
// ~/.bashrc stops early when nobody types into it. So ~/.local/bin, where skel copies
// itself and where Claude Code installs, is added here. env, since every shell runs it the
// same way.
const pathOnServer = 'PATH="$HOME/.local/bin:$PATH"';

// The commit skel was built from, which withLinuxSkel stamps into the copy it builds for a
// server or Sprite. A skel run from a checkout has none, and updates with git pull.
declare const SKEL_BUILD: string;
const built = typeof SKEL_BUILD === "string" ? SKEL_BUILD : undefined;

// Follows the commit of a build made with changes not committed. Such a build can't say
// what it holds, so it never counts as up to date.
const dirty = "-dirty";

// What a copied skel exits with when the laptop's build differs. skel otherwise exits 0 or
// 1, and the server's shell 127 when it finds no skel.
export const outdated = 98;

// Returns a build as people read it.
const readable = (build: string) =>
  build.endsWith(dirty) ? `${build.slice(0, -dirty.length)} with uncommitted changes` : build;

// Reports whether this skel, copied to a server or Sprite, is from another build than the
// laptop that runs it there with --remote, and says so. The laptop passes its build along
// with the command, so the check costs no round trip of its own.
export function outOfDate(): boolean {
  const laptop = process.env.SKEL_LAPTOP_BUILD;
  if (!laptop || built === undefined || (laptop === built && !built.endsWith(dirty))) return false;
  const where = process.env.SKEL_REMOTE_NAME;
  console.log(
    skelLine(`skel on ${where} is from ${readable(built)}, yours is ${readable(laptop)}.`),
  );
  return true;
}

// The checkout this skel runs from on the laptop, and git in it.
const checkoutFolder = resolve(import.meta.dir, "..");
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", checkoutFolder, ...args], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .trim();

// Returns the build a copy made from this checkout gets: its commit, marked when changes
// aren't committed, or null when skel doesn't run from a checkout.
function laptopBuild(): string | null {
  // A single-file skel runs its modules from a folder only it sees, outside any checkout.
  if (import.meta.dir.startsWith("/$bunfs")) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  if (commit === "") return null;
  return git("status", "--porcelain") === "" ? commit : `${commit}${dirty}`;
}

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
  const words = (from ? ["--from", from] : args).map(quoted);
  const there = (env: string[]) =>
    run(["ssh", "-t", host, ["env", pathOnServer, ...env.map(quoted), "skel", ...words].join(" ")]);
  const code = await upToDate(host, there, server(host));
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
  return there([]);
}

// Runs skel on a server or Sprite through `there`, which takes the environment to run it
// with, and returns its exit code. A copied skel there from another build than this
// laptop's runs nothing, so you are asked to replace it first. Either way the command then
// runs, without the check, so a build with uncommitted changes can't ask twice.
export async function upToDate(
  where: string,
  there: (env: string[]) => Promise<number>,
  machine: Machine,
): Promise<number> {
  const build = laptopBuild();
  const code = await there(
    build ? [`SKEL_LAPTOP_BUILD=${build}`, `SKEL_REMOTE_NAME=${where}`] : [],
  );
  if (code !== outdated) return code;
  const answer = prompt(skelLine("Update it? [Y/n]"))?.trim().toLowerCase() ?? "";
  if (["n", "no"].includes(answer))
    console.log(skelLine(`running it on the old skel on ${where}.`));
  else await update(where, machine);
  return there([]);
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

// How update reaches a server over ssh, where systemd runs the daemon.
const server = (host: string): Machine => ({
  shell: (script) => ["ssh", host, script],
  // The unit names the skel the daemon runs, with each % doubled for systemd.
  daemonSkel: async () => {
    const unit = ".config/systemd/user/skel.service";
    const sed = `sed -n 's/%%/%/g; s/^ExecStart="\\(.*\\)" serve$/\\1/p' ${unit}`;
    const read = await quietly(["ssh", host, sed]);
    return read.ok && read.said !== "" ? read.said : null;
  },
  copy: (file) => copySkel(host, file),
  restart: "systemctl --user restart skel",
});

// How update reaches a server or a Sprite: the command that runs a shell line there, the
// skel the daemon's service starts there, or null without a service, how a built skel is
// copied there, and the line that restarts the daemon's service there.
export type Machine = {
  shell: (script: string) => string[];
  daemonSkel: () => Promise<string | null>;
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
  const folder = checkoutFolder;
  const shown = folder.startsWith(`${homedir()}/`) ? `~${folder.slice(homedir().length)}` : folder;
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
async function update(where: string, machine: Machine): Promise<void> {
  // update only ever writes ~/.local/bin/skel, so it goes by the skel the daemon's service
  // starts, which can be elsewhere: a checkout skel once ran from, or a copy put somewhere
  // else. A checkout's launcher, linked or not, is bin/skel beside its sources. The rename
  // replaces ~/.local/bin/skel itself, so a service starting the file a link there points
  // to counts as elsewhere.
  const daemon = await machine.daemonSkel();
  const script = `f=${quoted(daemon ?? ".local/bin/skel")}
d=$(dirname "$(readlink -f "$f")")/..
if [ -f "$d/src/main.ts" ]; then echo "checkout $(cd "$d" && pwd)"
elif [ "$f" = .local/bin/skel ] || [ "$f" = "$HOME/.local/bin/skel" ]; then echo copied
else echo "elsewhere $f"; fi`;
  const asked = await quietly(machine.shell(script));
  const found = asked.said.match(/^(checkout (.+)|copied|elsewhere (.+))$/m);
  if (!found) throw new Error(`couldn't tell how skel is installed on ${where}:\n${asked.said}`);
  if (found[2]) {
    console.log(
      skelLine(
        `skel on ${where} runs from a checkout at ${found[2]}, so it wasn't replaced. git pull there updates it, and ${machine.restart} there restarts its daemon with it.`,
      ),
    );
    return;
  }
  if (found[3])
    throw new Error(
      `the daemon on ${where} runs skel from ${found[3]}, not ~/.local/bin/skel, where update puts it, so nothing was replaced`,
    );
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
}

// Builds skel as one file for a server or Sprite, which is Linux on x64 whatever the laptop
// runs, hands it to copy, and removes it after. Built from this checkout each time, so the
// machine gets the skel you run here, stamped with its build so it can tell when yours moves
// on.
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
    const build = laptopBuild();
    const stamp = build ? ["--define", `SKEL_BUILD=${JSON.stringify(build)}`] : [];
    const argv = ["bun", "build", "--compile", target, ...stamp, main, "--outfile", file];
    if ((await run(argv)) !== 0) throw new Error("bun build failed, so skel wasn't copied");
    await copy(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
