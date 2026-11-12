// The sandbox every agent runs in. bubblewrap draws the boundary, or sandbox-exec on a Mac:
// the agent's folder is writable, the rest of the system read-only, and your home folder and
// credentials hidden.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { controlSocket, dropCapabilities, onSprite } from "../machine/sprite.ts";
import { checkoutFolder, singleFile } from "../version.ts";
import { seatbeltArgs } from "./seatbelt.ts";

// Where the folder of the agent's socket appears inside, whatever its path outside.
const socketFolderInside = "/run/skelcrew";

// On a Sprite, unshare gives the agent a process list of its own, with a /proc to match,
// before capabilities are dropped. bwrap can't: it runs without capabilities, and the
// Sprite's container masks parts of /proc, so the kernel refuses a new /proc to anyone
// without them. A /proc borrowed from outside would show the agent every process, under
// numbers it doesn't have inside, so setpriv, ps or kill there would find the wrong
// process or none. --kill-child ends the sandbox when unshare is stopped.
const ownProcesses = ["unshare", "--pid", "--fork", "--kill-child", "--mount", "--mount-proc"];

// Returns a read-only mount so agents can read a folder without changing its files.
export const ro = (p: string) => ["--ro-bind", p, p];
// Returns a writable mount for the agent's own work or session files.
export const rw = (p: string) => ["--bind", p, p];
// Returns an empty mount that hides a host folder and its credentials from the agent.
const hide = (p: string) => ["--tmpfs", p];

// Finds a program's package folder so its required files remain visible after hiding your
// home folder. Codex from npm links to bin/codex.js in its package, and runs a program from
// another folder of it. Codex's own installer marks a release with codex-package.json, and
// keeps rg and its bwrap beside bin. Never the home folder itself, nor above it, which would
// bring back too much.
function packageFolder(folder: string, home: string): string {
  for (let at = folder; at !== home && at !== dirname(at); at = dirname(at))
    for (const mark of ["package.json", "codex-package.json"])
      if (existsSync(join(at, mark))) return at;
  return folder;
}

// Returns every link on the way from a program to its real file, each with what it points
// to, so the sandbox can make the same links. Following a program's link only to its end
// misses the ones between: Codex's installer links ~/.local/bin/codex into a folder named
// current, itself a link to the release. It walks one name at a time, as the kernel does,
// since a link can be any folder on the way, not only the last name. The program must
// exist, so a loop of links can't reach here.
function programLinks(program: string): Map<string, string> {
  const links = new Map<string, string>();
  const rest = [basename(program)];
  let at = dirname(program);
  // `rest` holds the names still to walk. A link puts its target's names in front of them,
  // starting again from / when the target is absolute.
  for (let name = rest.shift(); name !== undefined; name = rest.shift()) {
    const next = join(at, name);
    if (lstatSync(next).isSymbolicLink()) {
      const target = readlinkSync(next);
      links.set(next, target);
      if (target.startsWith("/")) at = "/";
      rest.unshift(...target.split("/").filter(Boolean));
    } else at = next;
  }
  return links;
}

// Returns the command that runs an agent in its sandbox, hiding your credentials and exposing
// only its chosen writable folders: bubblewrap on Linux, sandbox-exec on a Mac. Keeps the
// terminal connection and network available for the harness and model, and puts Skelcrew's own
// commands on the agent's PATH. `mounts` is in bubblewrap's words. The sandbox runs at a lower
// CPU priority unless `normalPriority` says otherwise, as only the lead's does.
export function sandboxArgs(given: {
  home: string;
  path: string;
  mounts: string[];
  socket?: string;
  cwd: string;
  command: string[];
  programs?: string[] | undefined;
  normalPriority?: boolean;
}): string[] {
  const {
    home,
    path,
    mounts,
    socket,
    cwd,
    command,
    programs: namedPrograms = [command[0]],
  } = given;
  // Builders and reviewers running test suites at once can load a shared machine past its
  // CPUs. Started under nice, all they run yields to the screen, the leads and the daemon.
  // nice comes first, ahead of the setpriv that drops capabilities on a Sprite: lowering a
  // priority needs none, and every process started inside keeps it. nice replaces itself with
  // the command, so the process tmux or the reviewer ends is still the sandbox's own.
  const niced = given.normalPriority ? [] : ["nice", "-n", "10"];
  // Programs often live under the home folder: Claude Code under nvm keeps node beside it,
  // and its package where its link points. So the program's folder and the package its link
  // resolves into come back, as does bun, which Skelcrew's own commands run on. The program is
  // the command's first word unless others are named, as for a shell running a setup command.
  const programFolders = new Set<string>();
  const links = new Map<string, string>();
  for (const name of [...namedPrograms, "bun"]) {
    const found = name && Bun.which(name, { PATH: path });
    if (found) {
      programFolders.add(dirname(found));
      programFolders.add(packageFolder(dirname(realpathSync(found)), home));
      for (const [link, target] of programLinks(found))
        if (link.startsWith(`${home}/`)) links.set(link, target);
    }
  }
  // Skelcrew built as one file runs its modules from a folder only it sees, and needs nothing
  // but itself. From a checkout, only the parts Skelcrew runs from: the checkout's .git and
  // other files aren't the agent's to read. bun runs sc without node_modules by fetching
  // its packages itself, and a sandbox can't show a folder that is missing.
  const bin = singleFile ? dirname(process.execPath) : join(checkoutFolder, "bin");
  const skelcrewFiles = singleFile
    ? [process.execPath]
    : ["bin", "src", "node_modules", "package.json"]
        .map((part) => join(checkoutFolder, part))
        .filter((part) => existsSync(part));
  // On a Mac, sandbox-exec draws the same boundary from the same lists.
  if (process.platform === "darwin")
    return [
      ...niced,
      ...seatbeltArgs({
        home,
        path: `${bin}:${path}`,
        read: [...programFolders, ...skelcrewFiles],
        links: [...links.keys()],
        mounts,
        socket,
        cwd,
        command,
      }),
    ];
  // Its own process list, so your other processes can't be seen or signalled. No
  // --new-session: it moves Claude Code out of the terminal's process group, so it misses
  // resize signals and draws at the wrong width. The network stays shared for the model's
  // API.
  const sprite = onSprite(path);
  const args = sprite
    ? [...niced, ...ownProcesses, ...dropCapabilities, "bwrap", "--die-with-parent"]
    : [...niced, "bwrap", "--die-with-parent", "--unshare-pid"];
  // The whole system read-only, with a /dev, /tmp and /proc of the sandbox's own.
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", "/tmp");
  args.push(...(sprite ? ro("/proc") : ["--proc", "/proc"]));
  if (sprite) {
    // The /proc unshare mounted shows what the Sprite's container masks, so it is masked
    // again.
    for (const masked of ["kcore", "keys", "timer_list"])
      if (existsSync(join("/proc", masked))) args.push("--ro-bind", "/dev/null", `/proc/${masked}`);
    if (existsSync("/proc/scsi")) args.push(...hide("/proc/scsi"));
    // Kept as a file the agent can't use rather than hidden with /.sprite, where gh, bun and
    // node live.
    args.push("--ro-bind", "/dev/null", controlSocket);
    // sprite-env only fails without the control socket. Hidden too, the sandbox looks like
    // any Linux machine to what runs in it, Skelcrew's own tests included, rather than a Sprite
    // whose services can't be reached.
    const spriteEnv = Bun.which("sprite-env", { PATH: path });
    if (spriteEnv) args.push("--ro-bind", "/dev/null", spriteEnv);
  }
  // The ssh agent, keyring, D-Bus, systemd and docker listen under /run, and some run
  // commands for whoever connects. Only the DNS resolver comes back.
  args.push(...hide("/run"));
  if (existsSync("/run/systemd/resolve")) args.push(...ro("/run/systemd/resolve"));
  args.push(...hide(home));
  // The links on the way are made anew rather than mounted, since the folder one sits in can
  // hold what must stay hidden: Codex's sit in ~/.codex, beside your login. Made first, so
  // one in a folder that comes back is simply covered by the real one. One that a mount
  // passes through stays out: bubblewrap can't mount through a link it made, and refuses to
  // start. The mount makes a real folder there instead.
  for (const [link, target] of links)
    if (![...programFolders, ...mounts].some((p) => p.startsWith(`${link}/`)))
      args.push("--symlink", target, link);
  // Then the programs and Skelcrew read-only, and the caller's own mounts, inside the hidden
  // home folder.
  for (const p of programFolders) args.push(...ro(p));
  for (const p of skelcrewFiles) args.push(...ro(p));
  args.push(...mounts);
  // Its folder rather than the socket itself: the daemon makes the socket anew each time it
  // starts, and a mounted file would stay the old one, which nothing answers on. Read-only,
  // so the agent can't replace it. The folder must hold nothing else.
  if (socket) {
    args.push(...["--ro-bind", dirname(socket), socketFolderInside]);
    args.push("--setenv", "SKELCREW_SOCKET", join(socketFolderInside, basename(socket)));
  }
  // SKELCREW_SANDBOX tells Skelcrew's own commands, and its tests, that they run inside.
  args.push("--setenv", "SKELCREW_SANDBOX", "1", "--setenv", "PATH", `${bin}:${path}`);
  // Postgres clients default to a socket in /tmp, which the sandbox hides, so they are
  // pointed at localhost over TCP. A host the project names itself still wins.
  args.push("--setenv", "PGHOST", "localhost");
  args.push("--chdir", cwd, "--", ...command);
  return args;
}

// Returns the mounts that show the reviewer a folder whose changes are thrown away after the
// review, and where it sees that folder. A copy leaves out the entries named in `kept`, which
// the caller mounts writable over it, and bwrap makes their places in the copy.
// bwrap's throwaway overlay does it, but on a Sprite an overlay can't be made on the
// Sprite's own disk, which is an overlay already: bwrap fails with "Invalid argument". There
// the reviewer gets a copy instead, made in the review's own folder so it goes with it. A Mac
// has no overlay either, and can't show a folder at another path, so there the reviewer
// works in the copy where it lies, which the review's folder already opens to it.
export async function throwaway(given: {
  source: string;
  copy: string;
  sprite: boolean;
  signal: AbortSignal;
  kept?: string[];
}): Promise<{ mounts: string[]; at: string }> {
  const { source, copy, sprite, signal, kept = [] } = given;
  // Plain Linux: an overlay shows the folder in place, and drops every change at the end.
  const mac = process.platform === "darwin";
  if (!sprite && !mac)
    return { mounts: ["--overlay-src", source, "--tmp-overlay", source], at: source };
  // Elsewhere: copy every entry the caller doesn't mount itself.
  mkdirSync(copy);
  const entries = readdirSync(source).filter((entry) => !kept.includes(entry));
  if (entries.length > 0) {
    let copied = false;
    let err = "";
    // A copy of a clone with its installed packages is large, and cp shares the blocks
    // where the disk allows it. A Mac's cp has its own word for that, and can fail on it
    // across two disks, so it goes on to a plain copy.
    const paths = entries.map((entry) => join(source, entry));
    for (const share of mac ? [["-c"], []] : [["--reflink=auto"]]) {
      const cp = ["cp", "-a", ...share, ...paths, copy];
      const copying = Bun.spawn(cp, { stdout: "ignore", stderr: "pipe", signal });
      const [said, code] = await Promise.all([new Response(copying.stderr).text(), copying.exited]);
      err = said;
      copied = code === 0;
      if (copied) break;
    }
    // A copy cut short by a cancel is reported as the cancel, after the copy is removed.
    if (!copied && !signal.aborted)
      throw new Error(`couldn't copy ${source} for the reviewer: ${err.trim()}`);
  }
  // On a Sprite the copy is shown at the folder's own path; on a Mac it stays where it is.
  return mac ? { mounts: [], at: copy } : { mounts: ["--bind", copy, source], at: source };
}

// Rejects clone settings containing credentials or unreadable settings, so agents cannot
// receive your git login. The lead reads each clone's .git/config, so a credential in it
// would be the lead's.
export function refuseCredentials(repository: string): void {
  const read = Bun.spawnSync(
    ["git", "-C", repository, "config", "--local", "--includes", "--get-regexp", "."],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Exit 1 means an empty config. Any other failure, such as a line git can't parse, would
  // hide what the file holds, while the lead can still read it.
  if (read.exitCode !== 0 && read.exitCode !== 1)
    throw new Error(
      `git can't read ${repository}/.git/config, so Skelcrew can't check it for credentials: ${read.stderr.toString().trim()}`,
    );
  // Each line is a key and its value. A header sent with every request, or a URL with a
  // login before its host, is a credential.
  for (const line of read.stdout.toString().split("\n")) {
    const key = line.split(" ")[0] ?? "";
    if (/^http\..*extraheader$/i.test(key) || /https?:\/\/[^/\s]*@/i.test(line))
      throw new Error(
        `${repository}/.git/config holds a credential (${key}), which agents could read. Remove it from the remote URL, and leave the login to a credential helper or a forge plugin`,
      );
  }
}

// Only what a shell needs gets in. Tokens and keys in your environment stay out, and so do
// CLAUDE_CODE_* variables inherited from a Claude Code session, which make the agent
// misbehave, for example by writing no transcript.
const allowedEnv = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "LANG", "TZ"];

// Returns only the environment a shell needs, plus the harness's own API keys in `keys`, for
// those who use a key rather than a login. So tokens and keys in yours stay out of every
// sandbox, and a key for one harness's model never reaches another harness or a setup
// command, which comes from the repository.
export function keptEnv(
  env: Record<string, string | undefined>,
  keys: readonly string[] = [],
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      (allowedEnv.includes(key) || keys.includes(key) || key.startsWith("LC_"))
    )
      kept[key] = value;
  }
  return kept;
}

// Returns the sandboxed command and environment for one of the repository's skelcrew.yaml setup
// commands, to run through a shell in the thread's clone. It comes from the repository, so it
// runs in the sandbox like the agents, with no socket, no login and no API key.
export function setupCommand(
  folder: string,
  command: string,
  env: Record<string, string | undefined> = process.env,
): { argv: string[]; env: Record<string, string> } {
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts: rw(folder),
    cwd: folder,
    command: ["sh", "-c", command],
    // sh lives outside the home folder, but the programs a setup command runs, such as npm
    // under nvm, often don't. Every word is tried rather than the first, since a command
    // can start with cd or a variable; words that name no program bring back nothing. Only
    // bare names: the command comes from the repository, and a path could name a program in
    // a folder of yours that holds secrets, such as Skelcrew's own token.
    programs: command.split(/\s+/).filter((word) => !word.includes("/")),
  });
  return { argv, env: keptEnv(env) };
}
