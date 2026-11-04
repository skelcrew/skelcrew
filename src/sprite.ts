// Everything skel knows about Sprites, Fly.io's Linux machines. From your laptop, skel
// --remote sprite:<name> creates one and runs skel there. On a Sprite, skel finds out it is
// on one, shapes the sandbox for it, and runs the daemon as a Sprite service. Your laptop can
// be a Mac, so this file loads nothing made only for Linux.
import { z } from "zod";
import { originHere } from "./origin.ts";
import { quoted, run, withLinuxSkel } from "./remote.ts";

// Reports whether skel runs on a Sprite. It goes by sprite-env, the Sprite's own tool for
// its services: every Sprite has it in /.sprite/bin, on the PATH its commands and services
// get, and other machines don't have it.
export const onSprite = (path = process.env.PATH ?? "") =>
  Boolean(Bun.which("sprite-env", { PATH: path }));

// The Sprite's control socket. Every process can reach it, and through it start a service
// that runs outside the sandbox, or restore a checkpoint and wipe the disk.
export const controlSocket = "/.sprite/api.sock";

// Commands on a Sprite run with a large set of capabilities, and bwrap refuses to start
// with them: "Unexpected capabilities but not setuid".
export const dropCapabilities = [
  "setpriv",
  "--inh-caps=-all",
  "--ambient-caps=-all",
  "--bounding-set=-all",
];

// Where a Sprite service writes what it prints, so the daemon's log is here.
export const serviceLog = "/.sprite/logs/services/skel.log";

// Reports whether the daemon's Sprite service exists. The service marks the first run as
// finished on a Sprite, as the systemd unit does on a server.
export function spriteServiceInstalled(): boolean {
  const get = ["sprite-env", "services", "get", "skel"];
  return Bun.spawnSync(get, { stdout: "pipe", stderr: "pipe" }).success;
}

// Installs the daemon as a Sprite service, unless it is there already. A Sprite has no
// systemd, and its services start at boot and come back after a crash. Creating one starts
// it, and --no-stream keeps its log out of your terminal.
export function installSpriteService(skel: string): void {
  if (spriteServiceInstalled()) return;
  const create = ["sprite-env", "services", "create", "skel", "--cmd", skel, "--args", "serve"];
  const made = Bun.spawnSync([...create, "--no-stream"], { stdout: "pipe", stderr: "pipe" });
  if (!made.success)
    throw new Error(
      `sprite-env couldn't create skel's service, so the daemon isn't installed: ${made.stderr.toString().trim()}`,
    );
}

// Starts the daemon's Sprite service, for a skel that finds no daemon answering. It is quiet,
// since sprite-env prints the service's log for a few seconds after starting it.
export function startSpriteService(): void {
  const start = ["sprite-env", "services", "start", "skel"];
  const started = Bun.spawnSync(start, { stdout: "pipe", stderr: "pipe" });
  if (!started.success)
    throw new Error(`sprite-env couldn't start skel's daemon: ${started.stderr.toString().trim()}`);
}

// Starts skel's tmux server as a Sprite service of its own, and waits until it answers. A
// Sprite service ends every process it started when it stops, even one in a session of its
// own, and while any is left the Sprite takes a crashed service for a running one. So a tmux
// server the daemon started would end with each restart, taking every agent with it, and
// keep a crashed daemon from starting again. -D keeps tmux in the foreground for the service,
// and running with no sessions.
export function startTmuxService(socket: string): void {
  const name = `skel-tmux-${socket}`;
  const quiet: { stdout: "pipe"; stderr: "pipe" } = { stdout: "pipe", stderr: "pipe" };
  const answers = (tries: number) => {
    for (let tried = 0; tried < tries; tried++) {
      if (Bun.spawnSync(["tmux", "-L", socket, "list-sessions"], quiet).success) return true;
      Bun.sleepSync(100);
    }
    return false;
  };
  const args = ["--cmd", "tmux", "--args", `-L,${socket},-f,/dev/null,-D`, "--no-stream"];
  Bun.spawnSync(["sprite-env", "services", "create", name, ...args], quiet);
  if (answers(20)) return;
  // Creating a service that exists does nothing, even when it has stopped.
  Bun.spawnSync(["sprite-env", "services", "start", name], quiet);
  if (answers(50)) return;
  throw new Error(`skel's tmux service didn't start: /.sprite/logs/services/${name}.log shows why`);
}

// How long a hold keeps the Sprite awake after its last renewal, in seconds. A few minutes,
// so a daemon that dies lets the Sprite sleep soon after, and a renewal that comes late or
// fails once never lets it sleep mid-work.
const holdFor = 300;

// Asks the Sprite's control socket to hold the Sprite awake for holdFor seconds, or to let
// go of the hold. The hold is a task, as the Sprite calls it, named skel. Throws when the
// socket doesn't answer or answers with an error.
async function holdTask(socket: string, method: "PUT" | "DELETE"): Promise<void> {
  const answer = await fetch("http://sprite/v1/tasks/skel", {
    unix: socket,
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ expire: holdFor }) : undefined,
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    throw new Error("the Sprite's control socket didn't answer");
  });
  // A hold that expired meanwhile is gone already, which is what letting go wants.
  if (!answer.ok && !(method === "DELETE" && answer.status === 404))
    throw new Error(
      `the Sprite's control socket answered ${answer.status}: ${await answer.text()}`,
    );
}

// Keeps the Sprite awake while `work` says there is work, and lets it sleep once there is
// none. A Sprite sleeps about 30 seconds after the last activity, and agents working in
// detached tmux sessions don't count, so without a hold a builder stops as soon as you
// detach. It checks every 10 seconds, so new work is held before the Sprite sleeps, and
// renews the hold once a minute. A daemon that dies stops renewing, so the hold expires a
// few minutes later. Returns a function that stops the checks.
export function keepAwake(
  work: () => boolean,
  { socket = controlSocket, every = 10_000, renew = 60_000 } = {},
): () => void {
  // When the hold was last renewed, or null once let go. It starts unknown, so a hold an
  // earlier daemon left is let go when there is no work.
  let held: number | "unknown" | null = "unknown";
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (work()) {
        if (typeof held !== "number" || Date.now() - held >= renew) {
          await holdTask(socket, "PUT");
          held = Date.now();
        }
      } else if (held !== null) {
        await holdTask(socket, "DELETE");
        held = null;
      }
    } catch (error) {
      console.log(
        `couldn't hold the Sprite awake or let it sleep: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      checking = false;
    }
  };
  check();
  const timer = setInterval(check, every);
  return () => clearInterval(timer);
}

const Listed = z.object({ sprites: z.array(z.object({ name: z.string() })) });

// Returns the names of your Sprites. Before that, checks that sprite is installed and logged
// in on the laptop, and stops with the command that fixes each, and the one to run again.
// sprite has no command that only tells whether you are logged in, but listing fails, saying
// to run sprite login, when you aren't.
function spriteNames(again: string): string[] {
  const missing = (what: string, fix: string) =>
    new Error(`${what} on this laptop first:\n  ${fix}\nThen run ${again} again.`);
  if (!Bun.which("sprite"))
    throw missing(
      "skel needs sprite, Fly.io's command for Sprites,",
      "curl -fsSL https://sprites.dev/install.sh | sh",
    );
  const listed = Bun.spawnSync(["sprite", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const said = `${listed.stderr.toString()}${listed.stdout.toString()}`.trim();
  if (!listed.success && said.includes("sprite login"))
    throw missing("sprite needs you to log in", "sprite login");
  if (!listed.success) throw new Error(`sprite list failed: ${said}`);
  try {
    return Listed.parse(JSON.parse(listed.stdout.toString())).sprites.map((sprite) => sprite.name);
  } catch {
    throw new Error("sprite list answered in a way this skel doesn't understand");
  }
}

// Returns whether you answered yes to a question.
const yes = (question: string) =>
  ["y", "yes"].includes(prompt(question)?.trim().toLowerCase() ?? "");

// Installs bubblewrap on the Sprite and copies skel there, built for it, to ~/.local/bin,
// which is on the PATH a Sprite gives its commands.
async function setUp(name: string): Promise<void> {
  // --no-stdin, since sprite can't reconnect a command whose input it forwards.
  const on = (command: string[]) => ["sprite", "exec", "-s", name, "--no-stdin", "--", ...command];
  console.log(`Setting up the Sprite ${name}.`);
  if ((await run(on(["sudo", "apt-get", "install", "-y", "bubblewrap"]))) !== 0)
    throw new Error(`couldn't install bubblewrap on the Sprite ${name}`);
  await withLinuxSkel(async (file) => {
    // sprite file push writes through a link, as scp does, so a link left there would have
    // the file it points to overwritten. Removing it first leaves that file alone.
    if ((await run(on(["sh", "-c", "mkdir -p .local/bin && rm -f .local/bin/skel"]))) !== 0)
      throw new Error(`couldn't make ~/.local/bin on the Sprite ${name}, so skel wasn't copied`);
    if ((await run(["sprite", "file", "push", "-s", name, file, ".local/bin/skel"])) !== 0)
      throw new Error(`sprite couldn't copy skel to the Sprite ${name}`);
  });
}

// Runs a skel command on the Sprite and returns its exit code. Plain skel passes the
// repository you are in on the laptop, so the lead knows it too. A Sprite that doesn't exist
// is created after asking, then set up, and one without skel is set up after asking.
export async function remoteSprite(name: string, args: string[]): Promise<number> {
  // A name starting with a dash would reach sprite as one of its options.
  if (!/^\w[\w-]*$/.test(name)) throw new Error(`"${name}" can't name a Sprite`);
  const again = ["skel", "--remote", `sprite:${name}`, ...args].map(quoted).join(" ");
  const names = spriteNames(again);
  const from = args.length === 0 ? originHere() : null;
  // sprite exec passes each word as given, with no shell between. It reports a program it
  // can't find as exit 1, like any failure, so a shell runs skel: it exits 127 when there is
  // none, which skel itself never does.
  const line = ["sh", "-c", 'exec skel "$@"', "skel", ...(from ? ["--from", from] : args)];
  const skel = ["sprite", "exec", "-s", name, "--tty", "--", ...line];
  if (!names.includes(name)) {
    // A mistyped name would otherwise make a second Sprite you pay for.
    if (!yes(`No Sprite named ${name}. Create it? [y/N]`)) {
      console.log("No Sprite was created, so the command didn't run.");
      return 1;
    }
    if ((await run(["sprite", "create", "--skip-console", name])) !== 0)
      throw new Error(`sprite couldn't create the Sprite ${name}`);
    await setUp(name);
    return run(skel);
  }
  const code = await run(skel);
  if (code !== 127) return code;
  console.log(`skel isn't installed on the Sprite ${name}.`);
  if (!yes("Install bubblewrap there and copy skel to ~/.local/bin? [y/N]")) {
    console.log(`skel isn't on the Sprite ${name}, so the command didn't run.`);
    return 1;
  }
  await setUp(name);
  return run(skel);
}
