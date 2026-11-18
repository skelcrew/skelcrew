// The daemon on a Mac: a launchd agent in place of the systemd user service. It loads at
// login, starts the daemon, and starts it again after a crash.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

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

// Returns the agent's definition for the daemon. launchd starts a program with a bare PATH,
// which misses bun, your harness and gh where they usually live, so the daemon gets yours. It is
// started again only after a crash, since a daemon that says one is already running exits
// cleanly. AbandonProcessGroup keeps launchd from ending what the daemon leaves running when
// it stops, which is what keeps agents alive through a restart. SKELCREW_SERVICE tells sc up it
// runs as the service, not in a terminal.
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
    <string>up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>SKELCREW_SERVICE</key>
    <string>1</string>
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

// Runs launchctl quietly and returns whether it worked, and what it said.
function launchctl(args: string[]): { ok: boolean; said: string } {
  const run = Bun.spawnSync(["launchctl", ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: run.success, said: `${run.stdout}${run.stderr}`.trim() };
}

// Loads the agent from its file, which starts the daemon. launchd keeps a definition it has
// loaded, so one already loaded is taken out first, or a moved bun, claude or checkout would
// never reach it. That stops the daemon, while agents keep running in tmux. Taking out one
// that isn't loaded fails, which is fine.
export function loadLaunchAgent(): void {
  launchctl(["bootout", `${domain()}/${label}`]);
  const loaded = launchctl(["bootstrap", domain(), plistFile()]);
  if (!loaded.ok) throw new Error(`launchctl couldn't load Skelcrew's daemon: ${loaded.said}`);
}

// Restarts the daemon, for a Skelcrew newer than the one the daemon runs: a newer release, or a
// checkout on another commit. The agent is loaded again from its file, so the daemon starts on
// the definition installService last wrote, and agents keep running in tmux.
export const restartLaunchAgent = () => loadLaunchAgent();

// Starts the daemon, for a Skelcrew that finds no daemon answering. Loading from the file also
// covers launchd losing the agent while its file stays, and a file rewritten since launchd
// loaded it.
export const startLaunchAgent = () => loadLaunchAgent();
