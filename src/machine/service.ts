// The daemon's service: installing it so it runs on its own, and starting it, on systemd, on a
// Mac's launchd or on a Sprite.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { skelLine } from "../say.ts";
import { checkoutFolder, singleFile } from "../version.ts";
import {
  daemonLog,
  loadLaunchAgent,
  plistFile,
  plistText,
  restartLaunchAgent,
  startLaunchAgent,
} from "./launchd.ts";
import { installSpriteService, onSprite, serviceLog, startSpriteService } from "./sprite.ts";

// Returns the systemd user service path, which also marks daemon installation complete.
const unitFile = () => join(homedir(), ".config", "systemd", "user", "skel.service");

// Returns the file that defines the daemon's service here and marks it as installed.
export const serviceFile = () => (process.platform === "darwin" ? plistFile() : unitFile());

// Runs a service installation command in your terminal and stops setup if it fails.
function runServiceCommand(command: string[]): void {
  const run = Bun.spawnSync(command, { stdio: ["inherit", "inherit", "inherit"] });
  if (!run.success) throw new Error(`${command.join(" ")} failed, so the daemon isn't installed`);
}

// Returns a value safe for the daemon's unit file, rejecting quotes and backslashes and
// escaping percent signs. systemd reads " and \ in a unit as quoting, and % as the start of
// a name it fills in.
function unitValue(value: string): string {
  if (/["\\]/.test(value)) throw new Error(`systemd can't be given ${value}, which holds " or \\`);
  return value.replaceAll("%", "%%");
}

// Returns the PATH your login shell sets up, followed by any folders of this one it lacks.
// A command over ssh, as skel --remote runs, gets a bare PATH, and Ubuntu's ~/.bashrc adds
// folders such as nvm's only in a shell you type into. So the shell starts as one, login
// and interactive, in a session of its own: with no terminal to take over, it can't stop
// skel's. Its startup files can print, so the PATH comes after a marker. Without SHELL
// there is no login shell to ask.
export function loginPath(): string {
  const here = (process.env.PATH ?? "").split(":");
  const shell = process.env.SHELL;
  const asked = shell
    ? Bun.spawnSync([shell, "-l", "-i", "-c", 'printf "\\nskel-path=%s\\n" "$PATH"'], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        detached: true,
        timeout: 10_000,
      })
    : null;
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
  const temporary = tmpdir();
  return given
    .split(":")
    .filter((p) => p && !p.includes("/node_modules/.bin") && !p.startsWith(`${temporary}/`));
}

// Returns the daemon's service definition with a lasting tool PATH and sessions that
// survive daemon stops.
function unitText(skel: string, given: string): string {
  // systemd starts services with a bare PATH, which misses bun, claude and gh where they
  // usually live, so the daemon gets yours.
  const path = lastingPath(given).map(unitValue).join(":");
  // Where tmux couldn't get a scope of its own, stopping the service would otherwise end
  // the tmux server, and every agent with it.
  return `[Unit]
Description=skel daemon

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
// installation. On a Sprite, which has no systemd, it is a Sprite service instead, and on a
// Mac a launchd agent. Checked on every plain skel, but only by comparing files, so a moved
// bun, claude or checkout reaches the daemon at its next start without a systemctl call each
// time.
export function installService(): void {
  const mac = process.platform === "darwin";
  const file = serviceFile();
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  // skel built as one file runs its modules from a folder only it sees, so the service runs
  // the file itself.
  const skel = singleFile ? process.execPath : join(checkoutFolder, "bin", "skel");
  // A worktree goes away once its work merges, and the daemon with it. Its .git is a file
  // pointing back at the repository, wherever the worktree lives.
  if (!singleFile && statSync(join(checkoutFolder, ".git"), { throwIfNoEntry: false })?.isFile()) {
    if (before !== null) return;
    throw new Error(
      `this skel runs from a worktree (${skel}): run skel from the main checkout to install its daemon`,
    );
  }
  if (onSprite()) {
    installSpriteService(skel);
    return;
  }
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
    if (mac) {
      loadLaunchAgent();
      return;
    }
    runServiceCommand(["systemctl", "--user", "daemon-reload"]);
    if (before !== null) return;
    runServiceCommand(["systemctl", "--user", "enable", "--now", "skel"]);
    console.log(
      skelLine(
        "turning on lingering, so the daemon keeps running after you log out and starts after a reboot.",
      ),
    );
    runServiceCommand(["loginctl", "enable-linger"]);
  } catch (error) {
    // The unit file marks the service installed, so the old one comes back, or none, and
    // the next skel tries again.
    if (before === null) rmSync(file);
    else writeFileSync(file, before);
    throw error;
  }
}

// Starts the daemon's service on this machine, and returns where its log is, for when it
// still doesn't answer. Throws when systemd refuses, as the daemon then won't come.
export function startDaemon(): string {
  if (onSprite()) {
    startSpriteService();
    return serviceLog;
  }
  if (process.platform === "darwin") {
    startLaunchAgent();
    return daemonLog();
  }
  const start = Bun.spawnSync(["systemctl", "--user", "start", "skel"], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (!start.success) throw new Error("systemctl couldn't start skel's daemon");
  return "journalctl --user -u skel";
}

// Restarts the daemon's service on this machine, so it runs the skel installed now, and returns
// where its log is, for when it doesn't come back. Agents keep running, as their sessions live
// in tmux and only the daemon restarts. Throws when the service manager refuses.
export function restartDaemon(): string {
  if (process.platform === "darwin") {
    restartLaunchAgent();
    return daemonLog();
  }
  const sprite = onSprite();
  const argv = sprite
    ? ["sprite-env", "services", "restart", "skel"]
    : ["systemctl", "--user", "restart", "skel"];
  // sprite-env prints the service's log for a few seconds after starting it.
  const restart = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (!restart.success)
    throw new Error(
      `${argv[0]} couldn't restart skel's daemon: ${restart.stderr.toString().trim()}`,
    );
  return sprite ? serviceLog : "journalctl --user -u skel";
}
