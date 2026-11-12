// Everything Skelcrew knows about Sprites, Fly.io's Linux machines. From your laptop, sc remote add
// sprite:<name> creates one, and sc --remote sprite:<name> runs sc there. On a Sprite, Skelcrew
// finds out it is on one, shapes the sandbox for it, and runs the daemon as a Sprite service.
import { z } from "zod";
import { quietly } from "../run.ts";
import { errorText, windowTitle } from "../say.ts";
import { originHere } from "./origin.ts";
import {
  addMachine,
  copySkel,
  type Machine,
  notSetUp,
  quoted,
  runInTerminal,
  runUpToDate,
} from "./remote.ts";

// Reports whether Skelcrew runs on a Sprite. It goes by sprite-env, the Sprite's own tool for
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
export const serviceLog = "/.sprite/logs/services/skelcrew.log";

// Reports whether the daemon's Sprite service exists. The service marks the first run as
// finished on a Sprite, as the systemd unit does on a server.
export function spriteServiceInstalled(): boolean {
  const get = ["sprite-env", "services", "get", "skelcrew"];
  return Bun.spawnSync(get, { stdout: "pipe", stderr: "pipe" }).success;
}

// Installs the daemon as a Sprite service, unless it is there already. A Sprite has no
// systemd, and its services start at boot and come back after a crash. Creating one starts
// it, and --no-stream keeps its log out of your terminal.
export function installSpriteService(skel: string): void {
  if (spriteServiceInstalled()) return;
  const create = ["sprite-env", "services", "create", "skelcrew", "--cmd", skel, "--args", "serve"];
  const made = Bun.spawnSync([...create, "--no-stream"], { stdout: "pipe", stderr: "pipe" });
  if (!made.success)
    throw new Error(
      `sprite-env couldn't create Skelcrew's service, so the daemon isn't installed: ${made.stderr.toString().trim()}`,
    );
}

// Starts the daemon's Sprite service, for a Skelcrew that finds no daemon answering. It is quiet,
// since sprite-env prints the service's log for a few seconds after starting it.
export function startSpriteService(): void {
  const start = ["sprite-env", "services", "start", "skelcrew"];
  const started = Bun.spawnSync(start, { stdout: "pipe", stderr: "pipe" });
  if (!started.success)
    throw new Error(
      `sprite-env couldn't start Skelcrew's daemon: ${started.stderr.toString().trim()}`,
    );
}

// Starts the agents' tmux server as a Sprite service of its own, and waits until it answers.
// It can't be the daemon's child. Stopping a Sprite service ends every process it started, so
// each daemon restart would end every agent. And while any of them is left, the Sprite takes a
// crashed daemon for a running one and never restarts it. -D keeps tmux in the foreground, as
// a service needs, and running with no sessions.
export function startTmuxService(socket: string): void {
  // Named by the socket, so each tmux server gets a service of its own.
  const name = `skelcrew-tmux-${socket}`;
  const quiet: { stdout: "pipe"; stderr: "pipe" } = { stdout: "pipe", stderr: "pipe" };
  // Whether tmux answers within some tries, a tenth of a second apart.
  const answers = (tries: number) => {
    for (let tried = 0; tried < tries; tried++) {
      if (Bun.spawnSync(["tmux", "-L", socket, "list-sessions"], quiet).success) return true;
      Bun.sleepSync(100);
    }
    return false;
  };
  // sprite-env takes the arguments as one word, split at commas. -f /dev/null keeps your
  // tmux config out of the agents' server.
  const args = ["--cmd", "tmux", "--args", `-L,${socket},-f,/dev/null,-D`, "--no-stream"];
  Bun.spawnSync(["sprite-env", "services", "create", name, ...args], quiet);
  if (answers(20)) return;
  // Creating a service that exists does nothing, even when it has stopped.
  Bun.spawnSync(["sprite-env", "services", "start", name], quiet);
  if (answers(50)) return;
  throw new Error(
    `the tmux service for agents didn't start: /.sprite/logs/services/${name}.log shows why`,
  );
}

// The port the Sprite's URL sends requests to, where the daemon listens for GitHub's
// webhooks. A request to the URL wakes a Sprite that sleeps.
export const urlPort = 8080;

// What sprite-env info says about the Sprite, as far as Skelcrew reads it.
const SpriteInfo = z.object({ sprite_url: z.string().url() });

// Returns the Sprite's URL, for GitHub's webhooks to wake it with, as sprite-env, the
// Sprite's own tool, says it.
export function spriteUrl(): string {
  const info = Bun.spawnSync(["sprite-env", "info"], { stdout: "pipe", stderr: "pipe" });
  if (!info.success)
    throw new Error(`sprite-env couldn't say the Sprite's URL: ${info.stderr.toString().trim()}`);
  try {
    return SpriteInfo.parse(JSON.parse(info.stdout.toString())).sprite_url;
  } catch {
    throw new Error("sprite-env described the Sprite in a way this Skelcrew doesn't understand");
  }
}

// How long a hold keeps the Sprite awake after its last renewal, in seconds. A few minutes,
// so a daemon that dies lets the Sprite sleep soon after, and a renewal that comes late or
// fails once never lets it sleep mid-work.
const holdFor = 300;

// Asks the Sprite's control socket to hold the Sprite awake for some seconds, or to let go
// of the hold. A hold is a task, as the Sprite calls it, named Skelcrew unless named otherwise.
// Throws when the socket doesn't answer or answers with an error.
async function holdTask(
  socket: string,
  method: "PUT" | "DELETE",
  { task = "skelcrew", expire = holdFor } = {},
): Promise<void> {
  // The host name is only a placeholder: the request goes to the socket.
  const answer = await fetch(`http://sprite/v1/tasks/${task}`, {
    unix: socket,
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "PUT" ? JSON.stringify({ expire }) : undefined,
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
  // A check waits on the socket, so one still running when the next is due lets that one go.
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      // With work, the hold is taken, or renewed once a minute has passed. Without, it is
      // let go once.
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
      console.log(`couldn't hold the Sprite awake or let it sleep: ${errorText(error)}`);
    } finally {
      checking = false;
    }
  };
  check();
  const timer = setInterval(check, every);
  return () => clearInterval(timer);
}

// Holds the Sprite awake for some seconds after a webhook delivery. A Sprite goes back to
// sleep as soon as the delivery is answered, before the poll it asked for has run, and
// before keepAwake's next check sees any work the poll started. The hold has a name of its
// own, so keepAwake never lets go of it, and it simply expires.
export const holdAwhile = (seconds: number, socket = controlSocket) =>
  holdTask(socket, "PUT", { task: "skelcrew-webhook", expire: seconds });

// What sprite-env says about a Sprite service, as far as Skelcrew reads it.
const SpriteService = z.object({ cmd: z.string() });

// What sprite list --json says about your Sprites, as far as Skelcrew reads it.
const SpriteList = z.object({ sprites: z.array(z.object({ name: z.string() })) });

// Returns the names of your Sprites. Before that, checks that sprite is installed and logged
// in on the laptop, and stops with the command that fixes each, and the one to run again.
// sprite has no command that only tells whether you are logged in, but listing fails, saying
// to run sprite login, when you aren't.
function spriteNames(again: string): string[] {
  // The error for something the laptop lacks, with its fix and the command to run again.
  const missing = (what: string, fix: string) =>
    new Error(`${what} on this laptop first:\n  ${fix}\nThen run ${again} again.`);
  if (!Bun.which("sprite"))
    throw missing(
      "install sprite, Fly.io's command for Sprites,",
      "curl -fsSL https://sprites.dev/install.sh | sh",
    );
  // Listing is also the check that you are logged in.
  const listed = Bun.spawnSync(["sprite", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const said = `${listed.stderr.toString()}${listed.stdout.toString()}`.trim();
  if (!listed.success && said.includes("sprite login"))
    throw missing("sprite needs you to log in", "sprite login");
  if (!listed.success) throw new Error(`sprite list failed: ${said}`);
  try {
    return SpriteList.parse(JSON.parse(listed.stdout.toString())).sprites.map(
      (sprite) => sprite.name,
    );
  } catch {
    throw new Error("sprite list answered in a way this Skelcrew doesn't understand");
  }
}

// Returns whether you answered yes to a question.
const yes = (question: string) =>
  ["y", "yes"].includes(prompt(question)?.trim().toLowerCase() ?? "");

// Installs bubblewrap on the Sprite and readies its node, which Skelcrew's sandbox needs.
async function prepareSprite(name: string): Promise<void> {
  // --no-stdin, since sprite can't reconnect a command whose input it forwards.
  const on = (command: string[]) => ["sprite", "exec", "-s", name, "--no-stdin", "--", ...command];
  // apt over sprite exec has no terminal for its dialogs, and says so in lines that look
  // like errors though the install works. So its output shows only when it fails. sudo
  // drops the environment, hence env after it.
  const apt = ["sudo", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq"];
  const install = await quietly(on([...apt, "bubblewrap"]));
  if (!install.ok)
    throw new Error(`couldn't install bubblewrap on sprite:${name}:\n${install.said}`);
  // A new Sprite's node is a script that writes to /etc/profile.d the first time it runs,
  // and /etc is read-only in the sandbox, so node, biome and tsc would fail for every
  // builder. One run out here does that write, quietly. A Sprite without node has nothing to
  // fix, so a failure stops nothing.
  await Bun.spawn(on(["node", "--version"]), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
}

// Lets anyone reach the Sprite's URL without a Fly.io login, so GitHub's webhooks can wake
// it. The URL only reaches the port where the daemon listens, which acts on nothing but a
// delivery signed with Skelcrew's secret, and then only polls GitHub.
// It is quiet, as sprite says "Updated" with the Sprite's name.
async function makeUrlPublic(name: string): Promise<void> {
  const update = ["sprite", "config", "update", "--url-auth", "public", "-s", name];
  const { err, ok } = await quietly(update);
  if (!ok)
    throw new Error(
      `sprite couldn't make sprite:${name}'s URL public, so GitHub's webhooks can't wake it: ${err.trim()}`,
    );
}

// How updating and setting up reach a Sprite: sprite exec for shell lines, sprite file push
// for Skelcrew, and the daemon's Sprite service. --no-stdin, since sprite can't reconnect a
// command whose input it forwards.
function spriteMachine(name: string): Machine {
  const shell = (script: string) => [
    "sprite",
    "exec",
    "-s",
    name,
    "--no-stdin",
    "--",
    "sh",
    "-c",
    script,
  ];
  return {
    shell,
    copy: (file) =>
      copySkel(`sprite:${name}`, shell, [
        "sprite",
        "file",
        "push",
        "-s",
        name,
        file,
        ".local/bin/sc.new",
      ]),
    // A Sprite service keeps the command it was made with, even after Skelcrew moves.
    daemonSkel: async () => {
      const { out, ok } = await quietly(shell("sprite-env services get skelcrew"), {
        stderr: "ignore",
      });
      if (!ok) return null;
      try {
        return SpriteService.parse(JSON.parse(out)).cmd;
      } catch {
        throw new Error(
          `sprite-env on sprite:${name} described Skelcrew's service in a way this Skelcrew doesn't understand`,
        );
      }
    },
    restart: "sprite-env services restart skelcrew",
    // A Sprite whose URL was never made public asks for a login there, which GitHub's
    // webhooks can't give. Made public only once the new daemon runs and holds the URL's
    // port: until then, whatever else listens there would be on the internet.
    updated: () => makeUrlPublic(name),
  };
}

// Stops at a name that can't be a Sprite's. A name starting with a dash would reach sprite
// as one of its options.
function checkName(name: string): void {
  if (!/^\w[\w-]*$/.test(name)) throw new Error(`"${name}" can't name a Sprite`);
}

// Returns how to run sc on the Sprite with these words. It takes the environment to add to
// what it always passes, and gives back the exit code.
function skelOnSprite(name: string, words: string[]) {
  // sprite exec passes each word as given, with no shell between. It reports a program it
  // can't find as exit 1, like any failure, so a shell runs sc: it exits 127 when there is
  // none, which Skelcrew itself never does. sprite puts this whole line in your terminal's title
  // as it connects, and the screen can be seconds away while a daemon wakes, so the shell
  // replaces the title first. Only the laptop can tell when output goes to a pipe, as --tty
  // gives the Sprite a terminal either way. checkName keeps quotes and % out of the name.
  const where = `sprite:${name}`;
  // The words after "sc" in the shell line reach sc as "$@", each as given.
  const title = process.stdout.isTTY ? `printf '\\033]2;${windowTitle(where)}\\007'; ` : "";
  const line = ["sh", "-c", `${title}exec sc "$@"`, "sc", ...words];
  const named = `SKELCREW_REMOTE_NAME=${where}`;
  return (env: string[]) =>
    runInTerminal(["sprite", "exec", "-s", name, "--tty", "--", "env", named, ...env, ...line]);
}

// Sets up a Sprite for --remote and returns the exit code, for sc remote add. The Sprite is
// named as you typed it, sprite:demo, since "the Sprite demo" reads as a demo of Sprites. The
// URL is made public on every run, so a run that failed there is finished by the next.
export async function addSprite(name: string): Promise<number> {
  checkName(name);
  const where = `sprite:${name}`;
  const names = spriteNames(`sc remote add ${where}`);
  // Said before anything is created, so you know what a yes below leads to.
  console.log(
    `Setting up ${where}: installing bubblewrap, making its URL public for GitHub's webhooks, copying Skelcrew there and running the first run.`,
  );
  if (!names.includes(name)) {
    // A mistyped name would otherwise make a second Sprite you pay for.
    if (!yes(`No Sprite named ${name}. Create it? [y/N]`)) {
      console.log("No Sprite was created.");
      return 1;
    }
    if ((await runInTerminal(["sprite", "create", "--skip-console", name])) !== 0)
      throw new Error(`sprite couldn't create ${where}`);
  }
  // Each of these is safe to run again on a Sprite that has it already.
  await prepareSprite(name);
  await makeUrlPublic(name);
  return addMachine(where, skelOnSprite(name, ["first-run"]), spriteMachine(name));
}

// Runs a Skelcrew command on the Sprite and returns its exit code. Plain Skelcrew passes the
// repository you are in on the laptop, so it opens that repository's lead there. Stops at a
// Sprite that doesn't exist or has no Skelcrew.
export async function remoteSprite(name: string, args: string[]): Promise<number> {
  checkName(name);
  // A sleeping Sprite can take a while to answer, which looks like a hang with nothing on
  // screen. Not in a pipe, where the output is the command's own.
  if (process.stdout.isTTY) console.log(`Connecting to sprite:${name}…`);
  // The command as you typed it, for the error that says to run it again once the laptop
  // is ready.
  const again = ["sc", "--remote", `sprite:${name}`, ...args].map(quoted).join(" ");
  const names = spriteNames(again);
  const from = args.length === 0 ? originHere() : null;
  const where = `sprite:${name}`;
  if (!names.includes(name)) throw new Error(notSetUp(where));
  const code = await runUpToDate(
    where,
    skelOnSprite(name, from ? ["--from", from] : args),
    spriteMachine(name),
  );
  if (code === 127) throw new Error(notSetUp(where));
  return code;
}
