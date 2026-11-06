// Everything skel knows about Sprites, Fly.io's Linux machines. From your laptop, skel remote
// add sprite:<name> creates one, and skel --remote sprite:<name> runs skel there. On a Sprite,
// skel finds out it is on one, shapes the sandbox for it, and runs the daemon as a Sprite service.
import { z } from "zod";
import { originHere } from "./origin.ts";
import { addMachine, type Machine, notSetUp, quoted, run, upToDate } from "./remote.ts";
import { skelLine, windowTitle } from "./say.ts";

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
  throw new Error(
    `the tmux service for agents didn't start: /.sprite/logs/services/${name}.log shows why`,
  );
}

// The port the Sprite's URL sends requests to, where the daemon listens for GitHub's
// webhooks. A request to the URL wakes a Sprite that sleeps.
export const urlPort = 8080;

const Info = z.object({ sprite_url: z.string().url() });

// Returns the Sprite's URL, for GitHub's webhooks to wake it with, as sprite-env, the
// Sprite's own tool, says it.
export function spriteUrl(): string {
  const info = Bun.spawnSync(["sprite-env", "info"], { stdout: "pipe", stderr: "pipe" });
  if (!info.success)
    throw new Error(`sprite-env couldn't say the Sprite's URL: ${info.stderr.toString().trim()}`);
  try {
    return Info.parse(JSON.parse(info.stdout.toString())).sprite_url;
  } catch {
    throw new Error("sprite-env described the Sprite in a way this skel doesn't understand");
  }
}

// How long a hold keeps the Sprite awake after its last renewal, in seconds. A few minutes,
// so a daemon that dies lets the Sprite sleep soon after, and a renewal that comes late or
// fails once never lets it sleep mid-work.
const holdFor = 300;

// Asks the Sprite's control socket to hold the Sprite awake for some seconds, or to let go
// of the hold. A hold is a task, as the Sprite calls it, named skel unless named otherwise.
// Throws when the socket doesn't answer or answers with an error.
async function holdTask(
  socket: string,
  method: "PUT" | "DELETE",
  { task = "skel", expire = holdFor } = {},
): Promise<void> {
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

// Holds the Sprite awake for some seconds after a webhook delivery. A Sprite goes back to
// sleep as soon as the delivery is answered, before the poll it asked for has run, and
// before keepAwake's next check sees any work the poll started. The hold has a name of its
// own, so keepAwake never lets go of it, and it simply expires.
export const holdAwhile = (seconds: number, socket = controlSocket) =>
  holdTask(socket, "PUT", { task: "skel-webhook", expire: seconds });

const Service = z.object({ cmd: z.string() });

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
      "install sprite, Fly.io's command for Sprites,",
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

// Installs bubblewrap on the Sprite and readies its node, which skel's sandbox needs.
async function prepare(name: string): Promise<void> {
  // --no-stdin, since sprite can't reconnect a command whose input it forwards.
  const on = (command: string[]) => ["sprite", "exec", "-s", name, "--no-stdin", "--", ...command];
  // apt over sprite exec has no terminal for its dialogs, and says so in lines that look
  // like errors though the install works. So its output shows only when it fails. sudo
  // drops the environment, hence env after it.
  const apt = ["sudo", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq"];
  const install = Bun.spawn(on([...apt, "bubblewrap"]), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(install.stdout).text(),
    new Response(install.stderr).text(),
    install.exited,
  ]);
  if (code !== 0)
    throw new Error(`couldn't install bubblewrap on sprite:${name}:\n${`${out}${err}`.trim()}`);
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
// delivery signed with skel's secret, and then only polls GitHub.
// It is quiet, as sprite says "Updated" with the Sprite's name.
async function makeUrlPublic(name: string): Promise<void> {
  const update = ["sprite", "config", "update", "--url-auth", "public", "-s", name];
  const made = Bun.spawn(update, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [said, code] = await Promise.all([new Response(made.stderr).text(), made.exited]);
  if (code !== 0)
    throw new Error(
      `sprite couldn't make sprite:${name}'s URL public, so GitHub's webhooks can't wake it: ${said.trim()}`,
    );
}

// How updating and setting up reach a Sprite: sprite exec for shell lines, sprite file push
// for skel, and the daemon's Sprite service. --no-stdin, since sprite can't reconnect a
// command whose input it forwards.
function onTheSprite(name: string): Machine {
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
    copy: async (file) => {
      // The copy goes to a file beside skel and is renamed over it once complete, so a
      // transfer that breaks off leaves the skel that works. sprite file push writes
      // through a link, as scp does, so whatever is at the new file's name is removed first.
      // A rename replaces a link at skel itself without touching the file it points to.
      if ((await run(shell("mkdir -p .local/bin && rm -f .local/bin/skel.new"))) !== 0)
        throw new Error(`couldn't make ~/.local/bin on sprite:${name}, so skel wasn't copied`);
      if ((await run(["sprite", "file", "push", "-s", name, file, ".local/bin/skel.new"])) !== 0)
        throw new Error(`sprite couldn't copy skel to sprite:${name}`);
      if ((await run(shell("mv -f .local/bin/skel.new .local/bin/skel"))) !== 0)
        throw new Error(`couldn't put the new skel in place on sprite:${name}`);
    },
    // A Sprite service keeps the command it was made with, even after skel moves.
    daemonSkel: async () => {
      const get = Bun.spawn(shell("sprite-env services get skel"), {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const [out, code] = await Promise.all([new Response(get.stdout).text(), get.exited]);
      if (code !== 0) return null;
      try {
        return Service.parse(JSON.parse(out)).cmd;
      } catch {
        throw new Error(
          `sprite-env on sprite:${name} described skel's service in a way this skel doesn't understand`,
        );
      }
    },
    restart: "sprite-env services restart skel",
    // A Sprite an older skel set up still asks for a login at its URL. Made public only once
    // the new daemon runs and holds the URL's port: until then, whatever else listens there
    // would be on the internet.
    updated: () => makeUrlPublic(name),
  };
}

// Stops at a name that can't be a Sprite's. A name starting with a dash would reach sprite
// as one of its options.
function checkName(name: string): void {
  if (!/^\w[\w-]*$/.test(name)) throw new Error(`"${name}" can't name a Sprite`);
}

// Returns how to run skel on the Sprite with these words. It takes the environment to add to
// what it always passes, and gives back the exit code.
function skelOnSprite(name: string, words: string[]) {
  // sprite exec passes each word as given, with no shell between. It reports a program it
  // can't find as exit 1, like any failure, so a shell runs skel: it exits 127 when there is
  // none, which skel itself never does. sprite puts this whole line in your terminal's title
  // as it connects, and the screen can be seconds away while a daemon wakes, so the shell
  // replaces the title first. Only the laptop can tell when output goes to a pipe, as --tty
  // gives the Sprite a terminal either way. checkName keeps quotes and % out of the name.
  const where = `sprite:${name}`;
  const title = process.stdout.isTTY ? `printf '\\033]2;${windowTitle(where)}\\007'; ` : "";
  const line = ["sh", "-c", `${title}exec skel "$@"`, "skel", ...words];
  const named = `SKEL_REMOTE_NAME=${where}`;
  return (env: string[]) =>
    run(["sprite", "exec", "-s", name, "--tty", "--", "env", named, ...env, ...line]);
}

// Sets up a Sprite for --remote and returns the exit code, for skel remote add. The Sprite is
// named as you typed it, sprite:demo, since "the Sprite demo" reads as a demo of Sprites. The
// URL is made public on every run, so a run that failed there is finished by the next.
export async function addSprite(name: string): Promise<number> {
  checkName(name);
  const where = `sprite:${name}`;
  const names = spriteNames(`skel remote add ${where}`);
  console.log(
    skelLine(
      `setting up ${where}: installing bubblewrap, making its URL public for GitHub's webhooks, copying skel there and running the first run.`,
    ),
  );
  if (!names.includes(name)) {
    // A mistyped name would otherwise make a second Sprite you pay for.
    if (!yes(skelLine(`No Sprite named ${name}. Create it? [y/N]`))) {
      console.log(skelLine("no Sprite was created."));
      return 1;
    }
    if ((await run(["sprite", "create", "--skip-console", name])) !== 0)
      throw new Error(`sprite couldn't create ${where}`);
  }
  await prepare(name);
  await makeUrlPublic(name);
  return addMachine(where, skelOnSprite(name, ["first-run"]), onTheSprite(name));
}

// Runs a skel command on the Sprite and returns its exit code. Plain skel passes the
// repository you are in on the laptop, so the lead knows it too. Stops at a Sprite that doesn't
// exist or has no skel.
export async function remoteSprite(name: string, args: string[]): Promise<number> {
  checkName(name);
  // A sleeping Sprite can take a while to answer, which looks like a hang with nothing on
  // screen. Not in a pipe, where the output is the command's own.
  if (process.stdout.isTTY) console.log(skelLine(`connecting to sprite:${name}…`));
  const again = ["skel", "--remote", `sprite:${name}`, ...args].map(quoted).join(" ");
  const names = spriteNames(again);
  const from = args.length === 0 ? originHere() : null;
  const where = `sprite:${name}`;
  if (!names.includes(name)) throw new Error(notSetUp(where));
  const code = await upToDate(
    where,
    skelOnSprite(name, from ? ["--from", from] : args),
    onTheSprite(name),
  );
  if (code === 127) throw new Error(notSetUp(where));
  return code;
}
