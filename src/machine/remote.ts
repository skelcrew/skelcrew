// sc --remote: run a Skelcrew command on your server over ssh -t, from your laptop, and with
// install, set a server up by sending your personal files and running sc install there.
// --remote offers to replace Skelcrew there when it is an older release than yours, or was built
// from another commit, and warns when it runs from a checkout behind yours. Your laptop can be a
// Mac, so this file loads nothing of the Skelcrew that runs on the server until it needs it.
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { screenSocket } from "../agents/tmux.ts";
import { sshFolder } from "../paths.ts";
import { quietly } from "../run.ts";
import {
  answeredFolder,
  type Drop,
  dropAnswerOption,
  dropCommand,
  dropPath,
  runWithDrops,
} from "../screen/drops.ts";
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
// ~/.bashrc stops early when nobody types into it. So ~/.local/bin, where Skelcrew copies
// itself and where Claude Code installs, is added here. It is set through env, which works
// the same in every shell.
const pathOnServer = 'PATH="$HOME/.local/bin:$PATH"';

// The shell line that runs sc on a server, after warning when the daemon there runs from a
// checkout behind the laptop's build, or still runs older code than that checkout holds.
// --remote never replaces a checkout, so without the warning a server could keep running old
// code through many merges. The laptop sends this check with the command, rather than leaving it to Skelcrew
// there, so a checkout too old to know of it still warns, and it costs no round trip of its own.
// It runs only when the laptop passes its build. The warning goes to stderr, so --json output
// stays clean, and the command runs either way.
// It is one line, joined from these steps, so ssh's own line stays readable in logs.
export const checkThenSc = [
  // A release is checked by its tag, and a commit with changes not committed by the commit.
  `b=\${SKELCREW_LAPTOP_BUILD%-dirty}`,
  "case $b in *.*.*) b=v$b;; esac",
  // e is the sc the daemon's service starts, as its unit names it with each % doubled, or else
  // the sc on the PATH. The daemon is what must run new code, and the sc you run can be another
  // install, such as a copy in ~/.local/bin beside a service that runs a checkout. A unit an older
  // Skelcrew wrote runs sc serve rather than sc up.
  String.raw`e=$(sed -n 's/%%/%/g; s/^ExecStart="\(.*\)" up$/\1/p; s/^ExecStart="\(.*\)" serve$/\1/p' "$HOME/.config/systemd/user/skelcrew.service" 2>/dev/null); [ -n "$e" ] || e=$(command -v sc)`,
  // d is the checkout that sc runs from, or empty when it runs from none. It is the folder
  // above the sc, which is often a link to its bin/sc. A copy has no src/main.ts there, and
  // needs no warning, as Skelcrew there checks its own build.
  'd=$([ -n "$b" ] && [ -n "$e" ] && cd "$(dirname "$(readlink -f "$e")")/.." && [ -f src/main.ts ] && pwd)',
  // u is what brings the checkout to the laptop's commit or tag, when it isn't at or past it.
  // git pull can't: it fails in a checkout with no branch, and on another branch it brings that
  // branch. A commit or tag the checkout has never fetched means it is behind.
  'u=; [ -n "$d" ] && ! git -C "$d" merge-base --is-ancestor "$b" HEAD 2>/dev/null && u="git fetch --tags && git checkout $b && "',
  // o is set when the daemon didn't start from this checkout as it is now: from another commit,
  // from another folder, or so long ago that it didn't write down where from. Restarting the
  // service starts it from this checkout. A machine without the service has no daemon to check.
  'c=; f=; { read -r c f < "$HOME/.local/share/skelcrew/daemon-code"; } 2>/dev/null',
  'o=; [ -n "$d" ] && [ -f "$HOME/.config/systemd/user/skelcrew.service" ] && [ "$c $f" != "$(git -C "$d" rev-parse HEAD) $d" ] && o=1',
  // What to say. Either way the way out ends by restarting the daemon, so it runs the new code.
  'w=; [ -n "$o" ] && w="The daemon on $SKELCREW_REMOTE_NAME runs older code than its checkout."',
  '[ -n "$u" ] && w="Skelcrew on $SKELCREW_REMOTE_NAME runs from a checkout at $(git -C "$d" rev-parse --short HEAD), yours is $SKELCREW_LAPTOP_BUILD."',
  // git checkout refuses to overwrite changes to tracked files, so those are named first. Files
  // git doesn't track stay where they are, so they don't count.
  'a="To update it, run this there:"; [ -n "$u" ] && [ -n "$(git -C "$d" status --porcelain --untracked-files=no)" ] && a="It has local changes, so commit or stash them, then run this there:"',
  // The folder goes in single quotes, each of its own quotes written as '\'', so a space or a
  // $ in it reaches cd as it is when you paste the line.
  String.raw`q=$(printf %s "$d" | sed "s/'/'\\\\''/g")`,
  `[ -n "$w" ] && printf "%s %s\\n  cd '%s' && %ssystemctl --user restart skelcrew\\n" "$w" "$a" "$q" "$u" >&2`,
  'exec sc "$@"',
].join("; ");

// What a copied Skelcrew exits with when the laptop's build differs. Skelcrew otherwise exits 0 or
// 1, and the server's shell 127 when it finds no Skelcrew.
export const outdated = 98;
// What Skelcrew exits with when --remote reaches it before sc install has set the machine up,
// so the laptop can offer to set it up.
export const unfinished = 97;

// Reports whether this Skelcrew, copied to a server, is from another build than the
// laptop that runs it there with --remote, and says so. The laptop passes its build along
// with the command, so the check costs no round trip of its own. A release newer than the
// laptop's counts as up to date: it installed itself in the background, and the laptop
// catches up on its own, so asking would only offer to go back.
export function outOfDate(): boolean {
  const laptop = process.env.SKELCREW_LAPTOP_BUILD;
  // No laptop build means the command came without the check, and no build here means this
  // Skelcrew runs from a checkout. Uncommitted changes never count as the same build.
  if (!laptop || built === undefined || (laptop === built && !built.endsWith(dirty))) return false;
  if (release && isRelease(laptop) && newer(release, laptop)) return false;
  const where = process.env.SKELCREW_REMOTE_NAME;
  console.log(`Skelcrew on ${where} is from ${readable(built)}, yours is ${readable(laptop)}.`);
  return true;
}

// Says whether release `a` comes after release `b`, by number, so 0.4.10 comes after 0.4.9.
function newer(a: string, b: string): boolean {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  // The first part that differs decides.
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

// Says whether your ssh config, or a file it includes, sets ControlMaster or ControlPath on any
// line, for any host. Then you manage shared connections yourself, and Skelcrew adds none. ssh -G
// can't tell ControlPath none or ControlMaster no from nothing set, so only reading the files
// finds them. `seen` stops a loop of Includes.
function sharesItself(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  // A file that isn't there, or can't be read, sets nothing.
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    // A setting is a keyword, then its value after spaces or an =. A comment starts with #, so
    // it never matches.
    const [, keyword = "", value = ""] = line.trim().match(/^(\w+)(?:\s*=\s*|\s+)(.*)$/) ?? [];
    if (/^control(master|path)$/i.test(keyword)) return true;
    if (/^include$/i.test(keyword) && included(value).some((each) => sharesItself(each, seen)))
      return true;
  }
  return false;
}

// Returns the files an Include line of your ssh config names, as ssh finds them: each word, in
// double quotes when it has spaces, under ~/.ssh unless it starts at / or ~, with its globs
// expanded.
function included(value: string): string[] {
  const home = homedir();
  return (value.match(/"[^"]*"|\S+/g) ?? []).flatMap((word) => {
    const name = word.replace(/^"(.*)"$/, "$1");
    const path = name.startsWith("~/")
      ? join(home, name.slice(2))
      : name.startsWith("/")
        ? name
        : join(home, ".ssh", name);
    if (!/[*?[]/.test(path)) return [path];
    // The glob is matched from / so the whole path counts.
    return [...new Bun.Glob(path.slice(1)).scanSync({ cwd: "/", absolute: true, dot: true })];
  });
}

// Returns the ssh options that make every ssh and scp Skelcrew runs for the host share one
// connection. One setup takes five or more of them, and each new connection can ask for your
// passphrase or a touch of your key. The shared connection ends a minute after the last
// command, which covers one setup or connect. Options given to ssh beat your ssh config, so
// when your config says anything about sharing connections, there are none.
function sharedConnection(host: string): string[] {
  // Your own config, read as text, catches ControlPath none and ControlMaster no, for any host.
  if (sharesItself(join(homedir(), ".ssh", "config"))) return [];
  // ssh -G prints what ssh would use for the host, from the system's config too, without
  // connecting. A read that fails prints no controlmaster, and then nothing is added either.
  const said = Bun.spawnSync(["ssh", "-G", host], { stdout: "pipe", stderr: "ignore" });
  const settings = said.stdout.toString();
  const master = settings.match(/^controlmaster (.*)$/m)?.[1];
  if (master === undefined || !["false", "no"].includes(master)) return [];
  if (/^controlpath /m.test(settings)) return [];
  // Anyone who can reach the sockets can run commands on your servers as you, so the folder must
  // be yours alone. Someone else can make it first in /tmp, or put a link there, and then
  // nothing is shared. It is made private again each time, in case its mode changed.
  const folder = sshFolder();
  // Two sc commands starting at once can both find it missing, so one made by the other, or
  // anything else already there, is left to the check below.
  try {
    mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const made = lstatSync(folder);
  if (!made.isDirectory() || made.uid !== userInfo().uid) return [];
  chmodSync(folder, 0o700);
  // %C is a hash of the connection, so each host, a ProxyJump host too, gets its own socket.
  const path = `ControlPath=${folder}/%C`;
  return ["-o", "ControlMaster=auto", "-o", "ControlPersist=60", "-o", path];
}

// Returns how to run sc on the host with these words, with `shared` from sharedConnection. It
// takes the environment to add to what it always passes, and gives back the exit code. `before`
// is a command that runs sc in its turn, such as one that takes a lock first. `run` runs ssh in
// your terminal, such as through the layer that sends dropped files. With a terminal,
// ssh says "Connection to <host> closed." each time it ends, several times in one setup, so it
// is told to say only errors.
const onServer =
  (host: string, shared: string[], words: string[], before: string[] = [], run = runInTerminal) =>
  (env: string[]) =>
    run([
      "ssh",
      "-o",
      "LogLevel=ERROR",
      "-t",
      ...shared,
      host,
      [
        "env",
        pathOnServer,
        quoted(`SKELCREW_REMOTE_NAME=${host}`),
        ...env.map(quoted),
        ...before.map(quoted),
        // The check is shell, and your login shell there may not be sh, so sh runs it. The words
        // after the second sh become its "$@".
        "sh",
        "-c",
        quoted(checkThenSc),
        "sh",
        ...words.map(quoted),
      ].join(" "),
    ]);

// Says a machine isn't set up, and how to do that.
export const notSetUp = (where: string) =>
  `${where} isn't set up. Run this on your laptop:\n  sc --remote ${where} install`;

// Asks a yes or no question in your terminal, where a bare Enter means yes. Bun's prompt answers
// a bare Enter with null.
const saysYes = (question: string) =>
  ["", "y", "yes"].includes(prompt(`${question} [Y/n]`)?.trim().toLowerCase() ?? "");

// Offers to set up a machine that --remote found not set up, and returns the exit code. A yes
// runs sc --remote <host> install, then `connect`, the command you asked for. Setting up means
// logins, so it never happens without your yes. Without a terminal nobody can answer, so it only
// says what to run.
async function setUpFirst(where: string, connect: () => Promise<number>): Promise<number> {
  if (!process.stdin.isTTY) throw new Error(notSetUp(where));
  if (!saysYes(`${where} isn't set up. Set it up now?`)) {
    console.log(`Nothing was set up. To set it up later, run:\n  sc --remote ${where} install`);
    return 1;
  }
  const installed = await installServer(where, true);
  return installed === 0 ? connect() : installed;
}

// Stops at a host that names a machine plugin, such as demo:box, rather than taking it for an
// SSH host. Skelcrew has no machine plugins yet, so every such host is refused by name. The name
// before the colon follows a plugin manifest's rule. An IPv6 address such as abcd::1 also starts
// that way, so it is let through to SSH first. user@host never matches, as it has an @ first.
function checkHost(host: string): void {
  if (isIP(host) === 6) return;
  const plugin = host.match(/^([a-z0-9][a-z0-9-]*):/)?.[1];
  if (plugin) throw new Error(`no machine plugin named ${plugin}`);
}

// Runs a Skelcrew command on the host and returns its exit code. Plain Skelcrew passes the
// repository you are in on the laptop, so it opens that repository's lead there. Offers to set
// the host up when it has no Skelcrew, or sc install hasn't set it up. install sets it up.
export async function remote(host: string, args: string[]): Promise<number> {
  checkHost(host);
  if (args.length === 1 && args[0] === "install") return installServer(host);
  // The server can't see the checkout you are in, so its remote goes along as --from where the
  // command needs it: plain sc and sc --list. A thread's name already names its repository.
  const words = args.filter((arg) => arg !== "--json");
  const plain = words.length === 0 || (words[0] === "--list" && words.length === 1);
  const from = plain ? originHere() : null;
  const machine = serverMachine(host);
  const scWords = from ? [...args, "--from", from] : args;
  // The screen there, which plain sc opens in your terminal, gets a name picked here, so files
  // you drop onto it can go to the agent it shows.
  const screen = words.length === 0 && process.stdin.isTTY ? `screen-${randomName()}` : null;
  const there =
    screen === null
      ? machine.sc(scWords)
      : (env: string[]) =>
          machine.sc(scWords, undefined, (argv) =>
            runWithDrops(argv, dropOnServer(machine, screen)),
          )([...env, `SKELCREW_SCREEN_NAME=${screen}`]);
  const connect = () => runUpToDate(host, there, machine);
  const code = await connect();
  // The server's shell exits 127 when it finds no Skelcrew to run. Skelcrew itself never does: it
  // exits 1 on any error.
  if (code !== 127 && code !== unfinished) return code;
  return setUpFirst(host, connect);
}

// Returns a short random name, of letters and digits.
const randomName = () => Math.random().toString(36).slice(2, 10);

// Returns how files dropped onto the server's screen, named `screen`, reach the agent it shows:
// each is sent over the shared ssh connection into that agent's folder there, where the agent
// reads it, and its path there is what the paste gives. The screen's sidebar there says which
// agent that is, once it has the keys typed before the drop, as on one machine. While your typing
// goes to the sidebar, nothing is sent. These ssh calls never ask for a password, as your
// terminal is the screen's. The screen there runs on the tmux server beside Skelcrew's own,
// skelcrew-screen.
function dropOnServer(machine: Machine, screen: string): Drop {
  const quiet = (script: string) => {
    const [ssh = "ssh", ...rest] = machine.shell(script);
    return [ssh, "-o", "BatchMode=yes", ...rest];
  };
  const read = `tmux -L ${screenSocket("skelcrew")} display -p -t =${screen}: '#{${dropAnswerOption}}'`;
  // The sidebar's last answer, then the drop's question, then a wait there, of up to two seconds,
  // for the answer to change.
  const where = async (ask: () => void) => {
    const before = await quietly(quiet(read));
    if (!before.ok) return null;
    ask();
    const wait = `b=${quoted(before.out.trim())}; i=0; while [ $i -lt 200 ]; do a=$(${read}); [ "$a" != "$b" ] && { printf '%s\n' "$a"; exit 0; }; sleep 0.01; i=$((i+1)); done; exit 1`;
    const asked = await quietly(quiet(`sh -c ${quoted(wait)}`));
    return asked.ok ? answeredFolder(asked.out.trim()) : null;
  };
  const put = (folder: string, files: string[]) =>
    Promise.all(
      files.map(async (file) => {
        // The same shell as on one machine, so a link the agent made never leads the copy
        // outside its folder.
        const copy = dropPath(folder, file);
        const line = dropCommand(copy).map(quoted).join(" ");
        const sent = Bun.spawn(quiet(line), {
          stdin: Bun.file(file),
          stdout: "ignore",
          stderr: "ignore",
        });
        return (await sent.exited) === 0 ? copy : null;
      }),
    );
  return { where, put };
}

// Sets up your server, for sc --remote <host> install, and returns the exit code. It sends your
// personal files there, then runs sc install there in your terminal, where each plugin's setup
// signs in on its own. The checkout you are in goes along as --from, as a plugin's setup is handed
// it on the laptop, such as for the GitHub plugin to pick that repository. A server with no Skelcrew gets the laptop's after you say yes, unless you
// already said yes to setting it up, which `asked` says. Running it again is safe, as sc install
// skips what is done, which is how a setup that stopped partway gets finished.
export async function installServer(host: string, asked = false): Promise<number> {
  checkHost(host);
  const machine = serverMachine(host);
  const sending = await sendYourFiles(host, machine);
  try {
    return await installThere(host, machine, sending, asked);
  } finally {
    // sc install there removes the folder once it puts your files in place. It is still there
    // when sc install never started, such as after a no, and goes here.
    if (sending) await quietly(machine.shell(`rm -rf .config/skelcrew/${sending}`));
  }
}

// Runs sc install on the server, after putting Skelcrew there when it has none, and returns the
// exit code. `sending` is the folder your files were sent to, which sc install puts in place
// first, or null when you have none to send. Every question here comes before sc install starts,
// so a no to any of them leaves the server's files as they were.
async function installThere(
  host: string,
  machine: Machine,
  sending: string | null,
  asked: boolean,
): Promise<number> {
  const from = originHere();
  const words = [
    "install",
    ...(from ? ["--from", from] : []),
    ...(sending ? ["--files", sending] : []),
  ];
  // sc install there runs holding a lock, so two installs at once, even from two laptops, each
  // put their own files in place and install from them, one after the other. flock lets go of
  // the lock when it ends, so a crash leaves nothing that blocks the next install.
  const there = machine.sc(words, sending ? ["flock", ".config/skelcrew/.install"] : []);
  const code = await runUpToDate(host, there, machine);
  // 127 is the machine's shell finding no Skelcrew to run.
  if (code !== 127) return code;
  if (!asked) {
    const put = `sc --remote ${host} install`;
    if (!process.stdin.isTTY)
      throw new Error(
        `${host} has no Skelcrew. To put it there, run this in a terminal:\n  ${put}`,
      );
    if (!saysYes(`${host} has no Skelcrew. Put yours there?`)) {
      console.log(`Nothing was put there. To do it later, run:\n  ${put}`);
      return 1;
    }
  }
  await withLinuxSkel(machine);
  // A fresh copy is the laptop's build, so it skips that check.
  return runUpToDate(host, there, machine, null);
}

// Sends your config.yaml, your lock and the agents' Claude Code token to a folder of this
// install's own in the server's ~/.config/skelcrew, made readable only by you before it is
// filled. Nothing is replaced yet: sc install there puts them in place once every question
// before it is answered. Returns the folder's name in ~/.config/skelcrew, or null when the laptop
// has no setup to send.
async function sendYourFiles(where: string, machine: Machine): Promise<string | null> {
  // Loaded only here, as it brings in much of Skelcrew that other commands need none of.
  const { yourFiles } = await import("./your-files.ts");
  const files = yourFiles();
  if (files.length === 0) return null;
  // A file left out, which can only be the token, is removed there as the files go in place.
  const sent = files.flatMap(({ name, text }) => (text === null ? [] : [{ name, text }]));
  // mkdir fails on a folder already there, so the folder is this install's alone.
  const sending = `sending-${crypto.randomUUID()}`;
  const staging = `.config/skelcrew/${sending}`;
  const place = `umask 077 && mkdir -p .config/skelcrew && mkdir ${staging}`;
  if ((await runInTerminal(machine.shell(place))) !== 0)
    throw new Error(`couldn't make a place for your files on ${where}, so none were sent`);
  console.log(`Sending your ${sent.map((file) => file.name).join(", ")} to ${where}.`);
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-"));
  try {
    for (const { name, text } of sent) {
      const file = join(folder, name);
      // Readable only by you here too, and scp gives the copy the same mode.
      writeFileSync(file, text, { mode: 0o600 });
      // scp shows a progress bar named after the temporary file, which means nothing to you,
      // so the copy runs out of your terminal and says why it failed.
      const pushed = await quietly(machine.push(file, `${staging}/${name}`));
      if (!pushed.ok) {
        await quietly(machine.shell(`rm -rf ${staging}`));
        throw new Error(`couldn't send your ${name} to ${where}:\n${pushed.said}`);
      }
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return sending;
}

// Runs sc on a server through `there`, and returns its exit code. `there` takes the
// environment to add to what it always passes. When the Skelcrew there is from another build
// than this laptop's, it runs nothing and you are asked whether to replace it. Either way the
// command then runs without that check, so a build with uncommitted changes can't ask twice.
// The laptop's lock goes along by its fingerprint, so Skelcrew there says when its own differs.
// `build` is null for a Skelcrew just copied there, which is the laptop's own.
async function runUpToDate(
  where: string,
  there: (env: string[]) => Promise<number>,
  machine: Machine,
  build = release || laptopBuild(),
): Promise<number> {
  // Loaded only here, as it brings in much of Skelcrew that the check on each command needs
  // only this of.
  const { laptopLockHash } = await import("./your-files.ts");
  const lock = laptopLockHash();
  const lockCheck = lock ? [`SKELCREW_LAPTOP_LOCK=${lock}`] : [];
  // A copy there that differs exits with `outdated` before running anything.
  let code = await there([...(build ? [`SKELCREW_LAPTOP_BUILD=${build}`] : []), ...lockCheck]);
  if (code === outdated) {
    // Bun's prompt answers a bare Enter with null, so only a no keeps the old Skelcrew.
    const answer = prompt("Update it? [Y/n]")?.trim().toLowerCase() ?? "";
    if (["n", "no"].includes(answer)) console.log(`Running it on the old Skelcrew on ${where}.`);
    else await update(where, machine);
    code = await there(lockCheck);
  }
  return code;
}

// Puts a Skelcrew built for a server in its ~/.local/bin. `shell` makes the command
// that runs a line there, and `push` is the command that sends the file to
// .local/bin/sc.new there. Throws, naming `where`, at the step that failed.
async function copySkel(where: string, shell: Machine["shell"], push: string[]): Promise<void> {
  // The copy goes to a file beside Skelcrew and is renamed over it once complete, so a transfer
  // that breaks off leaves the Skelcrew that works. scp writes through a link, so whatever is at
  // the new file's name is removed first. A rename replaces a link at Skelcrew itself, such as
  // one to a checkout's launcher, without touching the file it points to.
  if ((await runInTerminal(shell("mkdir -p .local/bin && rm -f .local/bin/sc.new"))) !== 0)
    throw new Error(`couldn't make ~/.local/bin on ${where}, so Skelcrew wasn't copied`);
  if ((await runInTerminal(push)) !== 0)
    throw new Error(`${push[0]} couldn't copy Skelcrew to ${where}`);
  if ((await runInTerminal(shell("mv -f .local/bin/sc.new .local/bin/sc"))) !== 0)
    throw new Error(`couldn't put the new Skelcrew in place on ${where}`);
}

// How update reaches a server: over ssh, with systemd running the daemon. Its ssh and scp
// commands share one connection.
function serverMachine(host: string): Machine {
  const shared = sharedConnection(host);
  const shell = (script: string) => ["ssh", ...shared, host, script];
  const push = (file: string, to: string) => ["scp", ...shared, file, `${host}:${to}`];
  return {
    shell,
    push,
    sc: (words, before, run) => onServer(host, shared, words, before, run),
    // The unit names the Skelcrew the daemon runs, with each % doubled for systemd. A unit an
    // older Skelcrew wrote runs sc serve rather than sc up.
    daemonSkel: async () => {
      const unit = ".config/systemd/user/skelcrew.service";
      const sed = `sed -n 's/%%/%/g; s/^ExecStart="\\(.*\\)" up$/\\1/p; s/^ExecStart="\\(.*\\)" serve$/\\1/p' ${unit}`;
      const read = await quietly(shell(sed));
      return read.ok && read.said !== "" ? read.said : null;
    },
    copy: (file) => copySkel(host, shell, push(file, ".local/bin/sc.new")),
    restart: "systemctl --user restart skelcrew",
  };
}

// How update reaches a server.
export type Machine = {
  // Returns the command that runs a shell line there.
  shell: (script: string) => string[];
  // Returns the command that sends a file to a path in your home there.
  push: (file: string, to: string) => string[];
  // Returns how to run sc there with these words in your terminal, through the command `before`
  // when given, with `run` running ssh when given. It takes the environment to add, and gives
  // back the exit code.
  sc: (
    words: string[],
    before?: string[],
    run?: (argv: string[]) => Promise<number>,
  ) => (env: string[]) => Promise<number>;
  // Returns the sc the daemon's service starts there, or null when there is no service.
  daemonSkel: () => Promise<string | null>;
  // Copies a built Skelcrew there.
  copy: (file: string) => Promise<void>;
  // The shell line that restarts the daemon's service there.
  restart: string;
};

// Prints what you should know about the checkout Skelcrew is built from, and returns what was
// built, naming its folder and commit. The build is the checkout as it is, so changes not
// committed, or a branch other than main, go along, which is allowed but worth a line.
function describeCheckout(): string {
  const folder = checkoutFolder;
  // The folder under your home is shown with ~, as you would type it.
  const shown = folder.startsWith(`${homedir()}/`) ? `~${folder.slice(homedir().length)}` : folder;
  if (git("status", "--porcelain") !== "")
    console.log(`${shown} has uncommitted changes, and they are copied too.`);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") console.log(`${shown} is on ${branch}, not main.`);
  return `the Skelcrew in ${shown} (commit ${git("rev-parse", "--short", "HEAD")})`;
}

// Replaces Skelcrew on a server with this laptop's release, or one built from this
// checkout, then restarts the daemon's service there so it runs the new build. The tmux
// server outlives the daemon, so the leads and builders keep running on their harness. A Skelcrew
// run from a checkout there is left alone: a copy would leave the checkout behind while the
// daemon kept running it.
async function update(where: string, machine: Machine): Promise<void> {
  // Update only ever writes ~/.local/bin/sc, so first find which sc the daemon's service
  // starts. It can be a checkout's bin/sc, ~/.local/bin/sc itself, or somewhere else. If
  // ~/.local/bin/sc is a link, the copy replaces the link, not the file it points to, so a
  // service starting that file counts as somewhere else.
  const daemon = await machine.daemonSkel();
  // One line over the connection tells the three apart: a checkout has src/main.ts beside its
  // bin/sc, a copy is ~/.local/bin/sc itself, and anything else is elsewhere.
  const script = `f=${quoted(daemon ?? ".local/bin/sc")}
d=$(dirname "$(readlink -f "$f")")/..
if [ -f "$d/src/main.ts" ]; then echo "checkout $(cd "$d" && pwd)"
elif [ "$f" = .local/bin/sc ] || [ "$f" = "$HOME/.local/bin/sc" ]; then echo copied
else echo "elsewhere $f"; fi`;
  const asked = await quietly(machine.shell(script));
  const found = asked.said.match(/^(checkout (.+)|copied|elsewhere (.+))$/m);
  if (!found)
    throw new Error(`couldn't tell how Skelcrew is installed on ${where}:\n${asked.said}`);
  if (found[2]) {
    console.log(
      `Skelcrew on ${where} runs from a checkout at ${found[2]}, so it wasn't replaced. git pull there updates it, and the next sc there restarts its daemon on it.`,
    );
    return;
  }
  if (found[3])
    throw new Error(
      `the daemon on ${where} runs sc from ${found[3]}, not ~/.local/bin/sc, where update puts it, so nothing was replaced`,
    );
  // Said before the copy, so a note about the checkout shows before the build starts.
  const now = release ? `Skelcrew ${release}` : describeCheckout();
  await withLinuxSkel(machine);
  // The service commands print their logs, which matter only when they fail.
  const restarted = await quietly(machine.shell(machine.restart));
  if (!restarted.ok)
    throw new Error(
      `the new Skelcrew is on ${where}, but its daemon didn't restart, so it still runs the old one:\n${restarted.said}`,
    );
  console.log(
    `Updated ${where} to ${now} and restarted its daemon. The leads and builders keep running, and each lead picks up new instructions when it's next started.`,
  );
}

// Returns the CPU of a server as Skelcrew's builds name it, x64 or arm64, so the
// Skelcrew it gets runs there.
async function machineCpu(machine: Machine): Promise<string> {
  const cpus: Record<string, string> = { x86_64: "x64", aarch64: "arm64", arm64: "arm64" };
  // ssh's warnings arrive in the same text, so the CPU is picked out of it.
  const { said } = await quietly(machine.shell("uname -m"));
  const cpu = cpus[said.match(/\b(x86_64|aarch64|arm64)\b/)?.[1] ?? ""];
  if (!cpu) throw new Error(`Skelcrew runs on arm64 and x64 CPUs, not on "${said}"`);
  return cpu;
}

// Downloads this release's Linux Skelcrew for the machine's CPU to a file, so a Skelcrew installed
// from a release can set up a server. It has no sources to build from, and is often on a Mac. Stops
// on a download that doesn't match the release's checksums, as the install script does.
async function downloadLinuxSkel(file: string, cpu: string): Promise<void> {
  console.log(`Downloading Skelcrew ${release} for Linux.`);
  const at = `${releases}/download/v${release}`;
  const name = `skelcrew-linux-${cpu}`;
  await Bun.write(file, await downloadRelease(at, name, await releaseSum(at, name)));
  chmodSync(file, 0o755);
}

// Builds Skelcrew from this checkout as one file for a server, which is Linux whatever
// the laptop runs, on the machine's CPU, stamped with its build so it can tell when yours
// moves on.
async function buildLinuxSkel(file: string, cpu: string): Promise<void> {
  console.log("Building Skelcrew for Linux.");
  const target = `--target=bun-linux-${cpu}`;
  const build = laptopBuild();
  const stamp = build ? ["--define", `SKELCREW_BUILD=${JSON.stringify(build)}`] : [];
  const argv = ["bun", "build", "--compile", target, ...stamp, mainFile, "--outfile", file];
  if ((await runInTerminal(argv)) !== 0)
    throw new Error("bun build failed, so Skelcrew wasn't copied");
}

// Gets the Skelcrew you run here for a server, copies it there, and removes it after:
// your release when you run one, or else one built from this checkout.
async function withLinuxSkel(machine: Machine): Promise<void> {
  // A single-file Skelcrew runs its modules from a folder only it sees, with no sources to
  // build from.
  if (singleFile && !release)
    throw new Error("this Skelcrew is a single file and can't build one: run sc from a checkout");
  const folder = mkdtempSync(join(tmpdir(), "skelcrew-"));
  try {
    const file = join(folder, "sc");
    const cpu = await machineCpu(machine);
    await (singleFile ? downloadLinuxSkel(file, cpu) : buildLinuxSkel(file, cpu));
    await machine.copy(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
