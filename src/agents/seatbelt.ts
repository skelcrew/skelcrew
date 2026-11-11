// The sandbox on a Mac: a profile for sandbox-exec that draws the same boundary bubblewrap
// draws on Linux, as far as a Mac allows. The agent's folder is writable, the rest of the
// system read-only, and your home folder, credentials and Keychain out of reach.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

// What every program needs, and nothing else. All else stays denied, so a Mac service nobody
// thought of stays closed. com.apple.SecurityServer is the Keychain's service, where gh keeps
// your GitHub token and Claude Code your login. It is open because Codex checks each site's
// certificate through it, and with it closed reaches nothing. Your logins stay out of reach
// all the same: your login keychain is a file in your home folder, which the sandbox hides,
// so the service finds none of them. com.apple.securityd.xpc, the newer Keychain, has no such
// file to hide, so it stays closed. lsopen and appleevent-send stay denied too, as open and
// osascript start programs outside the sandbox.
// Local sockets are denied here and opened one by one below: tmux's and the ssh agent's would
// run commands with your rights, and a Mac has no /run to hide them in.
const base = `(version 1)
(deny default (with message "skelcrew"))

(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))

(allow user-preference-read)
(allow mach-lookup
  (global-name "com.apple.FontObjectsServer")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.coreservices.launchservicesd")
  (global-name "com.apple.dnssd.service")
  (global-name "com.apple.fonts")
  (global-name "com.apple.logd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.networkd")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.trustd.agent")
)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow iokit-open
  (iokit-registry-entry-class "IOSurfaceRootUserClient")
  (iokit-registry-entry-class "RootDomainUserClient")
  (iokit-user-client-class "IOSurfaceSendRight")
)
(allow iokit-get-properties)
(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.tcsm_enable"))

(allow network-bind (local ip "*:*"))
(allow network-inbound (local ip "*:*"))
(allow network-outbound (remote ip "*:*"))
(allow system-socket (socket-domain AF_UNIX))
(allow network-outbound (remote unix-socket (subpath "/private/var/run/mDNSResponder")))

(allow pseudo-tty)
(allow file-ioctl
  (literal "/dev/dtracehelper")
  (literal "/dev/null")
  (literal "/dev/ptmx")
  (literal "/dev/random")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/zero")
  (regex #"^/dev/ttys")
)
(allow file-read* file-write*
  (literal "/dev/dtracehelper")
  (literal "/dev/null")
  (literal "/dev/ptmx")
  (literal "/dev/tty")
  (literal "/dev/zero")
  (regex #"^/dev/ttys")
  (subpath "/dev/fd")
)

(allow file-read*)
`;

// Returns a path as a profile writes it.
const quoted = (path: string) => JSON.stringify(path);

// Returns every folder above a path, for programs that walk down to it one name at a time,
// as Node's realpath does.
function above(path: string): string[] {
  const folders: string[] = [];
  for (let at = dirname(path); at !== "/" && at !== dirname(at); at = dirname(at)) folders.push(at);
  return folders;
}

// Returns the sandbox-exec profile for one agent, as text. The last rule that matches wins, so
// the order is the boundary: everything is readable, `hidden` is taken away, then `read`
// comes back read-only, `links` as single files, and `write` writable. The rules go by real
// paths, never by links such as /tmp. `socket` is the agent's one way to the daemon.
export function seatbeltProfile(given: {
  hidden: string[];
  read: string[];
  links: string[];
  write: string[];
  socket?: string;
}): string {
  const { hidden, read, links, write, socket } = given;
  // Hidden first, then what comes back, in the order the boundary needs.
  const rules = hidden.map((path) => `(deny file-read* (subpath ${quoted(path)}))`);
  rules.push(...read.map((path) => `(allow file-read* (subpath ${quoted(path)}))`));
  rules.push(...links.map((path) => `(allow file-read* (literal ${quoted(path)}))`));
  rules.push(...write.map((path) => `(allow file-read* file-write* (subpath ${quoted(path)}))`));
  // Only the facts of each folder on the way, so a program can find what came back. Their
  // contents stay hidden.
  const folders = new Set([...read, ...links, ...write].flatMap(above));
  for (const folder of folders)
    rules.push(`(allow file-read-metadata (literal ${quoted(folder)}))`);
  // Programs may make and reach local sockets in their own writable folders, and the agent may
  // reach the daemon's socket. All other local sockets stay denied.
  for (const path of write) {
    rules.push(`(allow network-bind (local unix-socket (subpath ${quoted(path)})))`);
    rules.push(`(allow network-outbound (remote unix-socket (subpath ${quoted(path)})))`);
  }
  if (socket)
    rules.push(`(allow network-outbound (remote unix-socket (subpath ${quoted(socket)})))`);
  return `${base}${rules.join("\n")}\n`;
}

// Returns a path with its links resolved, since a profile matches real paths only. /tmp and
// /var, where a Mac's temporary folders live, are links into /private.
const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

// Returns a socket's path with the links in its folders resolved. Only its folder is looked up:
// finding a path's real name opens the file on a Mac, and a socket can't be opened, so that
// fails with EOPNOTSUPP.
const realSocket = (path: string) => join(real(dirname(path)), basename(path));

// A Mac reaches its data through a second path too, /System/Volumes/Data, so what is hidden
// is hidden under both.
const bothPaths = (path: string) => [path, `/System/Volumes/Data${path}`];

// Returns the command that runs `command` in the sandbox on a Mac, for the same mounts
// bubblewrap would get. sandbox-exec can't show a folder empty or elsewhere, only deny it, so
// the agent gets a home and temporary folder of its own, which programs find through HOME
// and TMPDIR. A real home folder denied would stop git, which refuses a ~/.gitconfig it may
// not read. They live in your temporary folder, and go when the sandbox ends.
export function seatbeltArgs(given: {
  home: string;
  path: string;
  read: string[];
  links: string[];
  mounts: string[];
  socket?: string | undefined;
  cwd: string;
  command: string[];
}): string[] {
  const { home, path, read, links, mounts, socket, cwd, command } = given;
  // Read bubblewrap's mounts three words at a time: writable ones and read-only ones. Only a
  // folder at its own path can be shown, as a profile can't move one.
  const write: string[] = [];
  const shown = [...read];
  for (let at = 0; at < mounts.length; at += 3) {
    const [kind, from, to] = mounts.slice(at, at + 3);
    if (!from || from !== to || (kind !== "--bind" && kind !== "--ro-bind"))
      throw new Error(`a Mac's sandbox can't mount ${mounts.join(" ")}`);
    (kind === "--bind" ? write : shown).push(from);
  }
  // The agent's own home and temporary folder, made fresh for this sandbox.
  const own = realpathSync(mkdtempSync(join(tmpdir(), "skelcrew-sandbox-")));
  const [ownHome, ownTemp] = [join(own, "home"), join(own, "tmp")];
  for (const folder of [ownHome, ownTemp]) mkdirSync(folder);
  // What comes back of your home folder keeps its place under the agent's own, since agents
  // are told of it by that path: a lead finds its repository in ~/.local/share/skelcrew/repos.
  // Shortest first, so a folder inside one already linked is found there.
  const under = `${home}/`;
  for (const folder of [...shown, ...write].sort((a, b) => a.length - b.length)) {
    const place = join(ownHome, folder.slice(under.length));
    if (!folder.startsWith(under) || existsSync(place)) continue;
    mkdirSync(dirname(place), { recursive: true });
    symlinkSync(folder, place);
  }
  // tmux's socket, the ssh agent and your programs' files sit in these two, as /run does on
  // Linux, so like your home folder they are hidden.
  const hidden = [real(home), "/private/tmp", "/private/var/folders"].flatMap(bothPaths);
  // Beside the agent's folders rather than in them: it must never choose its own rules.
  const profile = join(own, "profile.sb");
  const text = seatbeltProfile({
    hidden,
    read: [...shown.map(real), ...(socket ? [real(dirname(socket))] : [])],
    links: links.map((link) => join(real(dirname(link)), basename(link))),
    write: [...write.map(real), ownHome, ownTemp],
    ...(socket ? { socket: realSocket(socket) } : {}),
  });
  writeFileSync(profile, text);
  // What the agent's environment must say instead of what it inherits: its own home and
  // temporary folder, and Skelcrew's commands first on its PATH.
  const vars = [`HOME=${ownHome}`, `TMPDIR=${ownTemp}`, "SKELCREW_SANDBOX=1", `PATH=${path}`];
  // Claude Code keeps its working files in /tmp unless told otherwise.
  vars.push(`CLAUDE_CODE_TMPDIR=${ownTemp}`);
  if (socket) vars.push(`SKELCREW_SOCKET=${socket}`);
  // Inside, a shell moves to the agent's folder and runs the command with that environment.
  const enter = 'cd "$1" && shift && exec /usr/bin/env "$@"';
  const sandboxed = ["sandbox-exec", "-f", profile, "/bin/sh", "-c", enter, "sh", cwd];
  // Outside the sandbox, a shell waits for it and then removes its folders, or every review
  // and setup command would leave a home full of caches behind. A hangup, as when tmux ends
  // a session, reaches the agent too, so the shell lets it pass and goes on to clean up. A
  // SIGKILL leaves the folders to macOS.
  const after = 'own=$1; shift; trap : HUP INT TERM; "$@"; code=$?; rm -rf "$own"; exit $code';
  return ["/bin/sh", "-c", after, "sh", own, ...sandboxed, ...vars, ...command];
}
