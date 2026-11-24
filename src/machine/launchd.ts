// The daemon on a Mac: a launchd agent in place of the systemd user service. It loads at
// login, starts the daemon, and starts it again after a crash.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// The name launchd knows the daemon's agent by.
const label = "dev.skelcrew.daemon";

// Returns the agent's definition file, which also marks the daemon as installed.
export const plistFile = () => join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
// Returns where the daemon's log goes, as a Mac has no journal.
export const daemonLog = () => join(homedir(), "Library", "Logs", "skelcrew.log");

// The login session's domain, not the user's: only there can the daemon reach the Keychain,
// where gh keeps your GitHub login on a Mac.
const domain = () => `gui/${userInfo().uid}`;

// Returns text safe inside a plist, which is XML.
const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function plistText(skel: string, path: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(skel)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(log)}</string>
</dict>
</plist>
`;
}

// Runs launchctl quietly and returns whether it worked, its exit code, and what it said.
function launchctl(args: string[]): { ok: boolean; code: number; said: string } {
  const run = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, code: run.exitCode, said: `${run.stdout}${run.stderr}`.trim() };
}

const service = () => `${domain()}/${label}`;

// Whether launchd has the agent, asked with print, as launchctl promises no stable message or
// exit code for a missing service.
const hasAgent = () => launchctl(["print", service()]).ok;

// Loads the agent from its file, which starts the daemon, and notes `why` in the daemon's log.
// launchd keeps a definition it has loaded, so one already loaded is taken out first, or a moved
// bun, claude or checkout would never reach it. That stops the daemon, while agents keep running
// in tmux. bootout returns before launchd has dropped the agent, and a bootstrap meanwhile fails
// with error 5, so the load waits for print to stop finding it. A bootstrap that still fails with
// error 5 is tried once more. When that fails with error 5 too, an agent launchd has since the old
// one dropped is the new one, and is started instead. An old one that never dropped is reported.
export function loadLaunchAgent(why: string): void {
  mkdirSync(dirname(daemonLog()), { recursive: true });
  appendFileSync(daemonLog(), `${new Date().toISOString()} sc reloads the launchd agent: ${why}\n`);
  launchctl(["bootout", service()]);
  const began = Date.now();
  let waiting = false;
  let dropped = !hasAgent();
  while (!dropped && Date.now() < began + 10_000) {
    if (!waiting && Date.now() > began + 1000) {
      console.log("Waiting for macOS to stop Skelcrew's old daemon…");
      waiting = true;
    }
    Bun.sleepSync(100);
    dropped = !hasAgent();
  }
  let loaded = launchctl(["bootstrap", domain(), plistFile()]);
  if (loaded.ok) return;
  if (loaded.code === 5) {
    Bun.sleepSync(500);
    loaded = launchctl(["bootstrap", domain(), plistFile()]);
    if (loaded.ok) return;
    if (dropped && loaded.code === 5 && hasAgent() && launchctl(["kickstart", service()]).ok)
      return;
  }
  throw new Error(`launchctl couldn't load Skelcrew's daemon: ${loaded.said}`);
}

// Starts the daemon through launchd, ending a running one first when `restart` holds. launchd
// can lose the agent while its file stays, so Skelcrew thinks the daemon installed, and kickstart
// then fails with "Could not find service". The agent is then loaded from its file, which starts
// the daemon. Any other failure is launchd refusing a daemon it has, so it is reported as is.
function kickstart(restart: boolean): void {
  const started = launchctl(["kickstart", ...(restart ? ["-k"] : []), service()]);
  if (started.ok) return;
  if (hasAgent()) {
    const doing = restart ? "restart" : "start";
    throw new Error(`launchctl couldn't ${doing} Skelcrew's daemon: ${started.said}`);
  }
  loadLaunchAgent("launchd had lost it while its file stayed");
}

// Returns the process id of the daemon launchd runs as the agent, or 0 when it runs none.
// launchctl print has no stable format, so a line such as "pid = 123" is looked for.
export function launchAgentPid(): number {
  const printed = launchctl(["print", service()]);
  return printed.ok ? Number(printed.said.match(/^\s*pid = (\d+)$/m)?.[1] ?? 0) : 0;
}

// Restarts the daemon, for a Skelcrew newer than the one the daemon runs: a newer release, or a
// checkout on another commit. launchd ends the running daemon first, and agents keep running in
// tmux.
export const restartLaunchAgent = () => kickstart(true);

// Starts the daemon, for a Skelcrew that finds no daemon answering.
export const startLaunchAgent = () => kickstart(false);
