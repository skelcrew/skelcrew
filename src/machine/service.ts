// The daemon's service: installing it, starting it on systemd or a Mac's launchd, and keeping
// the daemon running on this Skelcrew's code.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ask } from "../client.ts";
import { daemonSocket } from "../paths.ts";
import { checkoutFolder, git, release, singleFile } from "../version.ts";
import {
  daemonLog,
  launchAgentPid,
  loadLaunchAgent,
  plistFile,
  plistText,
  restartLaunchAgent,
  startLaunchAgent,
} from "./launchd.ts";

// Returns the systemd user service path, which also marks daemon installation complete.
const unitFile = () => join(homedir(), ".config", "systemd", "user", "skelcrew.service");

// Returns the file that defines the daemon's service here and marks it as installed.
export const serviceFile = () => (process.platform === "darwin" ? plistFile() : unitFile());

// Runs a service installation command and stops setup if it fails. systemctl's own lines, such
// as "Created symlink ...skelcrew.service", mean nothing to you during setup, so with `quiet`
// they are kept back, and shown only in the error when it fails. loginctl keeps your terminal, as
// enabling lingering can ask for your password.
function runServiceCommand(command: string[], quiet = false): void {
  const output = quiet ? "pipe" : "inherit";
  const run = Bun.spawnSync(command, { stdio: ["inherit", output, output] });
  if (run.success) return;
  const said = quiet ? `: ${`${run.stdout}${run.stderr}`.trim()}` : "";
  throw new Error(`${command.join(" ")} failed, so the daemon isn't installed${said}`);
}

// Returns a value safe for the daemon's unit file, rejecting quotes and backslashes and
// escaping percent signs. systemd reads " and \ in a unit as quoting, and % as the start of
// a name it fills in.
function unitValue(value: string): string {
  if (/["\\]/.test(value)) throw new Error(`systemd can't be given ${value}, which holds " or \\`);
  return value.replaceAll("%", "%%");
}

// Returns the PATH your login shell sets up, followed by any folders of this one it lacks.
// A command over ssh, as sc --remote runs, gets a bare PATH, and Ubuntu's ~/.bashrc adds
// folders such as nvm's only in a shell you type into. So the shell starts as one, login
// and interactive, in a session of its own: with no terminal to take over, it can't stop
// Skelcrew's. Its startup files can print, so the PATH comes after a marker. Without SHELL
// there is no login shell to ask.
export function loginPath(): string {
  const here = (process.env.PATH ?? "").split(":");
  const shell = process.env.SHELL;
  // The timeout keeps a startup file that waits for input, or hangs, from stopping sc.
  const asked = shell
    ? Bun.spawnSync([shell, "-l", "-i", "-c", 'printf "\\nskel-path=%s\\n" "$PATH"'], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        detached: true,
        timeout: 10_000,
      })
    : null;
  // Your shell's folders come first, and a folder in both is kept once, where the shell put it.
  const found =
    asked?.stdout
      .toString()
      .match(/^skel-path=(.*)$/m)?.[1]
      ?.split(":") ?? [];
  return [...new Set([...found, ...here].filter(Boolean))].join(":");
}

// Returns the folders of a PATH that will still be there when the daemon starts. Folders a
// tool runner or a temporary folder added are left out.
function lastingPath(given: string): string[] {
  // bun run and npx add a package's node_modules/.bin, which means nothing outside that run.
  const temporary = tmpdir();
  return given
    .split(":")
    .filter((p) => p && !p.includes("/node_modules/.bin") && !p.startsWith(`${temporary}/`));
}

function unitText(skel: string, given: string): string {
  const path = lastingPath(given).map(unitValue).join(":");
  return `[Unit]
Description=Skelcrew daemon

[Service]
ExecStart="${unitValue(skel)}" serve
Environment="PATH=${path}"
Restart=on-failure
KillMode=process

[Install]
WantedBy=default.target
`;
}

// Installs or updates the daemon service, enabling it and lingering on the first
// installation. On a Mac it is a launchd agent instead. Checked on every plain sc, but only by
// comparing files, so a moved bun, harness or checkout reaches the daemon without a systemctl
// or launchctl call each time: on systemd at its next start, and on a Mac at once.
export function installService(): void {
  const mac = process.platform === "darwin";
  const file = serviceFile();
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  // Skelcrew built as one file runs its modules from a folder only it sees, so the service runs
  // the file itself.
  const skel = singleFile ? process.execPath : join(checkoutFolder, "bin", "sc");
  // A worktree goes away once its work merges, and the daemon with it. Its .git is a file
  // pointing back at the repository, wherever the worktree lives.
  if (!singleFile && statSync(join(checkoutFolder, ".git"), { throwIfNoEntry: false })?.isFile()) {
    if (before !== null) return;
    throw new Error(
      `this Skelcrew runs from a worktree (${skel}): run sc from the main checkout to install its daemon`,
    );
  }
  // The service's file as it would be written for a PATH, so it can be compared with the one
  // installed.
  const text = (path: string) =>
    mac ? plistText(skel, lastingPath(path).join(":"), daemonLog()) : unitText(skel, path);
  // Asking your login shell takes a moment, so only when the PATH here would change the
  // service, as over ssh.
  if (before === text(process.env.PATH ?? "")) return;
  const unit = text(loginPath());
  if (before === unit) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, unit);
  try {
    // launchd keeps the definition it loaded, and would start the daemon again on it after a
    // crash, so a changed file is loaded at once. That restarts the daemon, and agents keep
    // running in tmux.
    if (mac) {
      loadLaunchAgent();
      return;
    }
    // An installed service only needs systemd to read its file again. It runs the new one
    // from the daemon's next start.
    runServiceCommand(["systemctl", "--user", "daemon-reload"], true);
    if (before !== null) return;
    runServiceCommand(["systemctl", "--user", "enable", "--now", "skelcrew"], true);
    // Lingering keeps the daemon running after you log out, and starts it after a reboot.
    console.log("Keeping Skelcrew running after you log out or restart.");
    runServiceCommand(["loginctl", "enable-linger"]);
  } catch (error) {
    // The unit file marks the service installed, so the old one comes back, or none, and
    // the next sc tries again.
    if (before === null) rmSync(file);
    else writeFileSync(file, before);
    throw error;
  }
}

// Returns the process id of the daemon the service runs, or 0 when it runs none or isn't
// installed. A daemon that answers with another id runs outside the service, such as sc serve in
// a terminal, which the service manager can neither restart nor start a second daemon beside.
export function servicePid(): number {
  if (process.platform === "darwin") return launchAgentPid();
  const show = Bun.spawnSync(
    ["systemctl", "--user", "show", "-p", "MainPID", "--value", "skelcrew"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return show.success ? Number(show.stdout.toString().trim()) || 0 : 0;
}

// Starts the daemon's service on this machine, and returns where its log is, for when it
// still doesn't answer. Throws when systemd refuses, as the daemon then won't come.
export function startDaemon(): string {
  if (process.platform === "darwin") {
    startLaunchAgent();
    return daemonLog();
  }
  // In your terminal, so systemd's own reason shows when it refuses.
  const start = Bun.spawnSync(["systemctl", "--user", "start", "skelcrew"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!start.success) throw new Error("systemctl couldn't start Skelcrew's daemon");
  return "journalctl --user -u skelcrew";
}

// Restarts the daemon's service on this machine, so it runs the Skelcrew installed now, and returns
// where its log is, for when it doesn't come back. Agents keep running, as their sessions live
// in tmux and only the daemon restarts. Throws when the service manager refuses.
export function restartDaemon(): string {
  if (process.platform === "darwin") {
    restartLaunchAgent();
    return daemonLog();
  }
  const argv = ["systemctl", "--user", "restart", "skelcrew"];
  const restart = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (!restart.success)
    throw new Error(
      `systemctl couldn't restart Skelcrew's daemon: ${restart.stderr.toString().trim()}`,
    );
  return "journalctl --user -u skelcrew";
}

// What the daemon says it runs: its release, or for a daemon from a checkout, that checkout's
// folder and the commit it started on, and its process id. A field an older daemon doesn't
// report comes back empty.
const DaemonBuild = z
  .object({
    release: z.string().catch(""),
    folder: z.string().catch(""),
    commit: z.string().catch(""),
    pid: z.number().catch(0),
  })
  .catch({ release: "", folder: "", commit: "", pid: 0 });

// Returns what the daemon runs, or null when no daemon answers.
async function daemonRuns(): Promise<z.infer<typeof DaemonBuild> | null> {
  const reply = await ask({ command: "status" }, 2000);
  return reply === null ? null : DaemonBuild.parse(reply);
}

// Returns what the daemon should run instead, in words, or null when a restart isn't needed or
// wouldn't help. A release wants the daemon on the same release. A checkout wants it on its
// current commit, but only when the daemon runs from this same checkout. The service always
// starts one checkout, so restarting your main one's daemon from a worktree would change
// nothing. Uncommitted changes don't count, so editing doesn't ask for a restart at every sc.
function daemonShouldRun(running: z.infer<typeof DaemonBuild>): string | null {
  if (release) return running.release === release ? null : `Skelcrew ${release}`;
  // A single file that isn't a release has no checkout to compare.
  if (singleFile || running.folder !== checkoutFolder) return null;
  const commit = git("rev-parse", "--short", "HEAD");
  return commit === "" || running.commit === commit ? null : `commit ${commit}`;
}

// How long a restarted daemon may take to answer on what this Skelcrew wants, in milliseconds.
// Tests set SKELCREW_RESTART_WAIT_MS shorter, so a daemon that never comes back doesn't cost
// them ten seconds.
const restartWait = z.coerce
  .number()
  .min(0)
  .catch(10_000)
  .parse(process.env.SKELCREW_RESTART_WAIT_MS ?? 10_000);

// Reports whether the daemon that answered runs outside its service, such as sc serve in a
// terminal. Told by its process id, which every daemon reports, so it holds for a daemon of an
// older release too. One that reports none can't be told, and counts as the service's.
const outsideService = (running: z.infer<typeof DaemonBuild>) =>
  running.pid !== 0 && running.pid !== servicePid();

const stopItFirst = (want: string) =>
  new Error(
    `Skelcrew's daemon runs outside its service, such as with sc serve in a terminal, on other code than ${want}. Stop it, such as with Ctrl-C, then run sc again. Your agents keep running.`,
  );

// Restarts the daemon when it runs another release than this Skelcrew, or another commit of this
// checkout. So a release installed in the background, or a git pull, takes over the next time
// you run sc. Agents keep running, as only the daemon restarts.
export async function restartStaleDaemon(): Promise<void> {
  const running = await daemonRuns();
  const want = running && daemonShouldRun(running);
  if (!want) return;
  if (outsideService(running)) throw stopItFirst(want);
  console.log(`Restarting the daemon on ${want}. Your agents keep running.`);
  const log = restartDaemon();
  // Done once a daemon answers that runs what this Skelcrew wants. The old one can still
  // answer for a moment while it stops.
  const deadline = Date.now() + restartWait;
  while (true) {
    const now = await daemonRuns();
    if (now && !daemonShouldRun(now)) return;
    if (Date.now() > deadline)
      throw new Error(
        `Skelcrew's daemon didn't come back on ${want} within ${restartWait / 1000} seconds: ${log} shows why`,
      );
    await Bun.sleep(100);
  }
}

export async function restartEngine(): Promise<void> {
  const before = await daemonRuns();
  const terminal =
    before !== null && (before.pid === 0 ? servicePid() === 0 : outsideService(before));
  if (terminal)
    throw new Error(
      "Skelcrew's engine runs in a terminal, with sc serve, not as its service. Stop it there, such as with Ctrl-C, then run sc serve again, or sc serve --bg to run it as the service. Your agents keep running.",
    );
  const began = Date.now();
  const log = restartDaemon();
  const deadline = began + restartWait;
  while (true) {
    const made = statSync(daemonSocket(), { throwIfNoEntry: false })?.ctimeMs ?? 0;
    if (made >= began && (await daemonRuns())) break;
    if (Date.now() > deadline)
      throw new Error(
        `Skelcrew's engine didn't come back within ${restartWait / 1000} seconds: ${log} shows why. An engine from an older release that you ran with sc serve in a terminal keeps a new one from starting: stop it there, such as with Ctrl-C.`,
      );
    await Bun.sleep(100);
  }
  console.log(`Restarted the engine on ${userInfo().username}@${hostname()}. Agents kept running.`);
}

// Runs the daemon as the background service on this Skelcrew's code, and returns once it
// answers. This is sc serve --bg, and plain sc and sc attach do it before attaching. The service is
// installed first, or rewritten when the PATH or Skelcrew it needs moved. A daemon on another
// release or commit is restarted, and one that doesn't answer is started. A daemon outside the
// service is left running, and true comes back to say so: a service started beside it would
// fail on the lock, and fail again on each retry until systemd gave up on it.
export async function upInBackground(): Promise<boolean> {
  const before = await daemonRuns();
  if (before && outsideService(before)) {
    const want = daemonShouldRun(before);
    if (want) throw stopItFirst(want);
    return true;
  }
  installService();
  await restartStaleDaemon();
  if (await daemonRuns()) return false;
  const log = startDaemon();
  // The service manager returns before the daemon listens, so wait until it answers.
  const deadline = Date.now() + 10_000;
  while (!(await daemonRuns())) {
    if (Date.now() > deadline)
      throw new Error(`Skelcrew's daemon didn't answer within 10 seconds: ${log} shows why`);
    await Bun.sleep(100);
  }
  return false;
}
