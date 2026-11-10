// skel --remote and skel remote add: run a skel command on your server over ssh -t, from your
// laptop, and set a server up for that. --remote offers to replace skel there when it is an
// older release than yours, or was built from another commit. Your laptop can be a Mac, so
// this file loads nothing of the skel that runs on the server.
import { chmodSync, mkdtempSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { quietly } from "../run.ts";
import { skelLine } from "../say.ts";
import {
  built,
  checkoutFolder,
  dirty,
  git,
  isRelease,
  laptopBuild,
  mainFile,
  readable,
  release,
  releases,
  singleFile,
} from "../version.ts";
import { originHere } from "./origin.ts";
import { downloadRelease, releaseSum } from "./update.ts";

// A command over ssh gets a bare PATH: no login shell reads ~/.profile, and Ubuntu's
// ~/.bashrc stops early when nobody types into it. So ~/.local/bin, where skel copies
// itself and where Claude Code installs, is added here. env, since every shell runs it the
// same way.
const pathOnServer = 'PATH="$HOME/.local/bin:$PATH"';

// What a copied skel exits with when the laptop's build differs. skel otherwise exits 0 or
// 1, and the server's shell 127 when it finds no skel.
export const outdated = 98;

// Reports whether this skel, copied to a server or Sprite, is from another build than the
// laptop that runs it there with --remote, and says so. The laptop passes its build along
// with the command, so the check costs no round trip of its own. A release newer than the
// laptop's counts as up to date: it installed itself in the background, and the laptop
// catches up on its own, so asking would only offer to go back.
export function outOfDate(): boolean {
  const laptop = process.env.SKEL_LAPTOP_BUILD;
  if (!laptop || built === undefined || (laptop === built && !built.endsWith(dirty))) return false;
  if (release && isRelease(laptop) && newer(release, laptop)) return false;
  const where = process.env.SKEL_REMOTE_NAME;
  console.log(
    skelLine(`skel on ${where} is from ${readable(built)}, yours is ${readable(laptop)}.`),
  );
  return true;
}

// Says whether release `a` comes after release `b`, by number, so 0.4.10 comes after 0.4.9.
function newer(a: string, b: string): boolean {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  const at = x.findIndex((part, i) => part !== y[i]);
  return at !== -1 && (x[at] ?? 0) > (y[at] ?? 0);
}

// Returns a word the server's shell reads back exactly as given. ssh joins its words with
// spaces into one line for that shell, so a space, quote or $ would split or expand it.
export const quoted = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

// Runs a program with your terminal, so ssh can ask for a password and attach, and returns
// its exit code.
export const runInTerminal = (argv: string[]) =>
  Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] }).exited;

// Runs `go` and returns what it gives back, with your terminal's title saved before and put
// back after, for skel --remote. The screen's tmux saves it too, but on a Sprite that is too
// late: sprite has already put the raw command there, and writes nothing back. Ghostty and
// some others keep no saved title and ignore this, so there your shell's prompt puts its own
// back. Written straight to the terminal, as process.exit can drop what stdout still holds.
export async function keepingTitle<T>(go: () => Promise<T>): Promise<T> {
  const say = (code: string) => process.stdout.isTTY && writeSync(1, code);
  say("\x1b[22;0t");
  try {
    return await go();
  } finally {
    say("\x1b[23;0t");
  }
}

// Returns how to run skel on the host with these words. It takes the environment to add to
// what it always passes, and gives back the exit code.
const onServer = (host: string, words: string[]) => (env: string[]) =>
  runInTerminal([
    "ssh",
    "-t",
    host,
    [
      "env",
      pathOnServer,
      quoted(`SKEL_REMOTE_NAME=${host}`),
      ...env.map(quoted),
      "skel",
      ...words.map(quoted),
    ].join(" "),
  ]);

// Says a machine isn't set up, and how to do that. --remote only connects, as setting up
// means logins and can mean a Sprite you pay for, which nobody expects from a mistyped name.
export const notSetUp = (where: string) =>
  `${where} isn't set up. Run this on your laptop:\n  skel remote add ${where}`;

// Runs a skel command on the host and returns its exit code. Plain skel passes the
// repository you are in on the laptop, so it opens that repository's lead there. Stops when
// the host has no skel.
export async function remote(host: string, args: string[]): Promise<number> {
  const from = args.length === 0 ? originHere() : null;
  const there = onServer(host, from ? ["--from", from] : args);
  const code = await upToDate(host, there, server(host));
  // The server's shell exits 127 when it finds no skel to run. skel itself never does: it
  // exits 1 on any error.
  if (code === 127) throw new Error(notSetUp(host));
  return code;
}

// Sets up your server for --remote and returns the exit code, for skel remote add.
export async function addServer(host: string): Promise<number> {
  console.log(skelLine(`setting up ${host}: copying skel there and running the first run.`));
  return addMachine(host, onServer(host, ["first-run"]), server(host));
}

// Puts skel on a server or Sprite if it isn't there, and runs the first run through `there`,
// without attaching, so that logging in there stays separate from starting to work. Ends
// with the command that connects. Running it again is safe, as the first run skips what is
// done, which is how a setup that stopped partway gets finished.
export async function addMachine(
  where: string,
  there: (env: string[]) => Promise<number>,
  machine: Machine,
): Promise<number> {
  let code = await upToDate(where, there, machine);
  if (code === 127) {
    await withLinuxSkel(machine);
    code = await there([]);
  }
  if (code !== 0) return code;
  console.log(skelLine(`${where} is ready. Connect to it with:`));
  console.log(`  skel --remote ${where}`);
  return 0;
}

// Runs skel on a server or Sprite through `there`, which takes the environment to add to
// what it always passes, and returns its exit code. A copied skel there from another build
// than this laptop's, its release or its commit, runs nothing, so you are asked to replace it
// first. Either way the command then runs, without the check, so a build with uncommitted
// changes can't ask twice.
export async function upToDate(
  where: string,
  there: (env: string[]) => Promise<number>,
  machine: Machine,
): Promise<number> {
  const build = release || laptopBuild();
  const code = await there(build ? [`SKEL_LAPTOP_BUILD=${build}`] : []);
  if (code !== outdated) return code;
  const answer = prompt(skelLine("Update it? [Y/n]"))?.trim().toLowerCase() ?? "";
  if (["n", "no"].includes(answer))
    console.log(skelLine(`running it on the old skel on ${where}.`));
  else await update(where, machine);
  return there([]);
}

// Puts a skel built for a server or Sprite in its ~/.local/bin. `shell` makes the command
// that runs a line there, and `push` is the command that sends the file to
// .local/bin/skel.new there. Throws, naming `where`, at the step that failed.
export async function copySkel(
  where: string,
  shell: Machine["shell"],
  push: string[],
): Promise<void> {
  // The copy goes to a file beside skel and is renamed over it once complete, so a transfer
  // that breaks off leaves the skel that works. scp and sprite file push write through a
  // link, so whatever is at the new file's name is removed first. A rename replaces a link
  // at skel itself, such as one to a checkout's launcher, without touching the file it
  // points to.
  if ((await runInTerminal(shell("mkdir -p .local/bin && rm -f .local/bin/skel.new"))) !== 0)
    throw new Error(`couldn't make ~/.local/bin on ${where}, so skel wasn't copied`);
  if ((await runInTerminal(push)) !== 0)
    throw new Error(`${push[0]} couldn't copy skel to ${where}`);
  if ((await runInTerminal(shell("mv -f .local/bin/skel.new .local/bin/skel"))) !== 0)
    throw new Error(`couldn't put the new skel in place on ${where}`);
}

// How update reaches a server over ssh, where systemd runs the daemon.
function server(host: string): Machine {
  const shell = (script: string) => ["ssh", host, script];
  return {
    shell,
    // The unit names the skel the daemon runs, with each % doubled for systemd.
    daemonSkel: async () => {
      const unit = ".config/systemd/user/skel.service";
      const sed = `sed -n 's/%%/%/g; s/^ExecStart="\\(.*\\)" serve$/\\1/p' ${unit}`;
      const read = await quietly(shell(sed));
      return read.ok && read.said !== "" ? read.said : null;
    },
    copy: (file) => copySkel(host, shell, ["scp", file, `${host}:.local/bin/skel.new`]),
    restart: "systemctl --user restart skel",
    updated: async () => {},
  };
}

// How update reaches a server or a Sprite: the command that runs a shell line there, the
// skel the daemon's service starts there, or null without a service, how a built skel is
// copied there, the line that restarts the daemon's service there, and what else the
// machine needs once its new daemon runs.
export type Machine = {
  shell: (script: string) => string[];
  daemonSkel: () => Promise<string | null>;
  copy: (file: string) => Promise<void>;
  restart: string;
  updated: () => Promise<void>;
};

// Prints what you should know about the checkout skel is built from, and returns what was
// built, naming its folder and commit. The build is the checkout as it is, so changes not
// committed, or a branch other than main, go along, which is allowed but worth a line.
function describeCheckout(): string {
  const folder = checkoutFolder;
  const shown = folder.startsWith(`${homedir()}/`) ? `~${folder.slice(homedir().length)}` : folder;
  if (git("status", "--porcelain") !== "")
    console.log(skelLine(`${shown} has uncommitted changes, and they are copied too.`));
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") console.log(skelLine(`${shown} is on ${branch}, not main.`));
  return `the skel in ${shown} (commit ${git("rev-parse", "--short", "HEAD")})`;
}

// Replaces skel on a server or Sprite with this laptop's release, or one built from this
// checkout, then restarts the daemon's service there so it runs the new build. The tmux
// server outlives the daemon, so the leads and builders keep running on their harness. A skel
// run from a checkout there is left alone: a copy would leave the checkout behind while the
// daemon kept running it.
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
        `skel on ${where} runs from a checkout at ${found[2]}, so it wasn't replaced. git pull there updates it, and the next skel there restarts its daemon on it.`,
      ),
    );
    return;
  }
  if (found[3])
    throw new Error(
      `the daemon on ${where} runs skel from ${found[3]}, not ~/.local/bin/skel, where update puts it, so nothing was replaced`,
    );
  const now = release ? `skel ${release}` : describeCheckout();
  await withLinuxSkel(machine);
  // The service commands print their logs, which matter only when they fail.
  const restarted = await quietly(machine.shell(machine.restart));
  if (!restarted.ok)
    throw new Error(
      `the new skel is on ${where}, but its daemon didn't restart, so it still runs the old one:\n${restarted.said}`,
    );
  await machine.updated();
  console.log(
    skelLine(
      `updated ${where} to ${now} and restarted its daemon. The leads and builders keep running, and each lead picks up new instructions when it's next started.`,
    ),
  );
}

// Returns the CPU of a server or Sprite in the words of skel's builds, x64 or arm64, so the
// skel it gets runs there.
async function machineCpu(machine: Machine): Promise<string> {
  const cpus: Record<string, string> = { x86_64: "x64", aarch64: "arm64", arm64: "arm64" };
  // ssh's warnings arrive in the same text, so the CPU is picked out of it.
  const { said } = await quietly(machine.shell("uname -m"));
  const cpu = cpus[said.match(/\b(x86_64|aarch64|arm64)\b/)?.[1] ?? ""];
  if (!cpu) throw new Error(`skel runs on arm64 and x64 CPUs, not on "${said}"`);
  return cpu;
}

// Downloads this release's Linux skel for the machine's CPU to a file, so a skel installed from
// a release can set up a server. It has no sources to build from, and is often on a Mac. Stops
// on a download that doesn't match the release's checksums, as the install script does.
async function downloadLinuxSkel(file: string, cpu: string): Promise<void> {
  console.log(`Downloading skel ${release} for Linux.`);
  const at = `${releases}/download/v${release}`;
  const name = `skel-linux-${cpu}`;
  await Bun.write(file, await downloadRelease(at, name, await releaseSum(at, name)));
  chmodSync(file, 0o755);
}

// Builds skel from this checkout as one file for a server or Sprite, which is Linux whatever
// the laptop runs, on the machine's CPU, stamped with its build so it can tell when yours
// moves on.
async function buildLinuxSkel(file: string, cpu: string): Promise<void> {
  console.log("Building skel for Linux.");
  const target = `--target=bun-linux-${cpu}`;
  const build = laptopBuild();
  const stamp = build ? ["--define", `SKELCREW_BUILD=${JSON.stringify(build)}`] : [];
  const argv = ["bun", "build", "--compile", target, ...stamp, mainFile, "--outfile", file];
  if ((await runInTerminal(argv)) !== 0) throw new Error("bun build failed, so skel wasn't copied");
}

// Gets the skel you run here for a server or Sprite, copies it there, and removes it after: your
// release when you run one, or else one built from this checkout.
async function withLinuxSkel(machine: Machine): Promise<void> {
  // A single-file skel runs its modules from a folder only it sees, with no sources to
  // build from.
  if (singleFile && !release)
    throw new Error("this skel is a single file and can't build one: run skel from a checkout");
  const folder = mkdtempSync(join(tmpdir(), "skel-"));
  try {
    const file = join(folder, "skel");
    const cpu = await machineCpu(machine);
    await (singleFile ? downloadLinuxSkel(file, cpu) : buildLinuxSkel(file, cpu));
    await machine.copy(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
