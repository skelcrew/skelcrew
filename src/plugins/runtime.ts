// Runtime plugins as session hosts. A plugin that provides sessions runs agents' sessions in
// place of tmux, and may also carry text into them and show their status. Skelcrew asks it
// through its session command, as it asks a tracker through call: one JSON question on stdin,
// one JSON answer on stdout.
import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { errorText } from "../say.ts";
import { commandFor, installedPlugins, type Manifest, quoteForSh, readManifest } from "./plugin.ts";

// A runtime plugin that hosts sessions: its name, its version, its folder, its session and attach
// commands, and whether it also provides the transport and the status. The sessions module uses Skelcrew's
// built-in for any it doesn't.
export type PluginHost = {
  plugin: string;
  version: string;
  folder: string;
  session: string[];
  attach: string[];
  transport: boolean;
  status: boolean;
};

// Where a session runs: on Skelcrew's tmux server, named by its socket, or on a plugin's host.
export type Host = string | PluginHost;

// Returns the host of that name: tmux, on the agents' tmux server `sessions`, or an installed
// runtime plugin that provides sessions. Null when no such plugin is installed, such as one you
// removed while a thread still ran on it.
export const hostNamed = (db: Database, sessions: string, name: string): Host | null =>
  name === "tmux" ? sessions : pluginHost(db, name);

// Returns the installed runtime plugin of that name as a host, or null when none that provides
// sessions is installed. A plugin whose manifest can't be read, such as one whose folder went,
// counts as none, and is logged once: this is asked on every change to a thread and as the
// daemon starts, which one broken plugin must never stop. Its threads then need you, as for a
// plugin removed, and every other thread carries on.
export function pluginHost(db: Database, name: string): PluginHost | null {
  const plugin = installedPlugins(db).find((installed) => installed.name === name);
  if (!plugin) return null;
  let manifest: Manifest;
  try {
    manifest = readManifest(plugin.folder);
  } catch (error) {
    const said = `the runtime plugin ${name} can't be used: ${errorText(error)}`;
    if (!unreadable.has(said)) console.log(said);
    unreadable.add(said);
    return null;
  }
  const { session, attach } = manifest;
  if (!manifest.provides.includes("sessions") || !session || !attach) return null;
  return {
    plugin: name,
    version: manifest.version,
    folder: plugin.folder,
    session,
    attach,
    transport: manifest.provides.includes("transport"),
    status: manifest.provides.includes("status"),
  };
}

// What was logged of plugins whose manifest can't be read, so each is said once.
const unreadable = new Set<string>();

// Returns the program, environment and folder that run the host's session command, with the
// plugin's environment added to Skelcrew's own.
function sessionCommand(host: PluginHost) {
  const { argv, env } = commandFor(host.plugin, host.session);
  return { argv, env: { ...process.env, ...env }, cwd: host.folder };
}

// Returns a host's answer checked against `Answer`, or throws saying what went wrong: the last
// line it wrote to stderr when it failed, or that its answer isn't understood. With `unread`,
// a host that exited cleanly is done whatever it printed, and the answer is null.
function checkAnswer<T>(
  host: PluginHost,
  question: { ask: string; [key: string]: unknown },
  done: { out: string; err: string; code: number | null },
  Answer: z.ZodType<T>,
  unread: boolean,
): T {
  if (done.code !== 0) {
    const last = done.err.trim().split("\n").at(-1) || `it exited with code ${done.code}`;
    throw new Error(`${host.plugin} couldn't ${question.ask}: ${last}`);
  }
  if (unread) return Answer.parse(null);
  // Output that isn't JSON, empty output included, is refused like a wrong answer: a host that
  // printed nothing may not have done what it was asked, such as type a message in.
  const misunderstood = new Error(
    `${host.plugin} answered ${question.ask} in a way Skelcrew doesn't understand`,
  );
  let answer: unknown;
  try {
    answer = JSON.parse(done.out);
  } catch {
    throw misunderstood;
  }
  const checked = Answer.safeParse(answer);
  if (!checked.success) throw misunderstood;
  return checked.data;
}

// Asks the host one question about its sessions and returns its answer, checked against
// `Answer`, without holding up the daemon meanwhile: a slow or hung host delays only what waits
// on it. Past `timeout` milliseconds, 30 seconds unless given, the command is killed and this
// throws, so a hung plugin can't hold back what waits after it. Once `signal` aborts, it is
// killed too, so it types nothing more, and this throws. It runs in a process group of its own,
// which is killed whole: a program it started could otherwise hold its output open, and the
// wait for that output would never end. With `unread`, for a question whose answer the protocol
// says isn't read, such as rename, a clean exit is enough, so a host that prints nothing is
// done.
export async function askHost<T>(
  host: PluginHost,
  question: { ask: string; [key: string]: unknown },
  Answer: z.ZodType<T>,
  limits: {
    signal?: AbortSignal | undefined;
    timeout?: number | undefined;
    unread?: boolean;
  } = {},
): Promise<T> {
  const { signal, timeout = 30_000, unread = false } = limits;
  const run = Bun.spawn(sessionCommand(host).argv, {
    ...sessionCommand(host),
    stdin: new Blob([`${JSON.stringify(question)}\n`]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const kill = () => {
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch {}
  };
  let late = false;
  const timer = Number.isFinite(timeout)
    ? setTimeout(() => {
        late = true;
        kill();
      }, timeout)
    : undefined;
  signal?.addEventListener("abort", kill);
  try {
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    // A command that finished just before it would have been killed still counts.
    if (signal?.aborted && code !== 0)
      throw new Error(`${host.plugin} was stopped from ${question.ask}`);
    if (late && code !== 0)
      throw new Error(
        `${host.plugin} didn't answer ${question.ask} within ${timeout} milliseconds`,
      );
    return checkAnswer(host, question, { out, err, code }, Answer, unread);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

// Attaches your terminal full screen to a session on the host, by running the plugin's attach
// command in it with the session's ID after its own words, and returns once you detach.
export function attachOnHost(host: PluginHost, id: string): void {
  const { argv, env } = commandFor(host.plugin, host.attach);
  Bun.spawnSync([...argv, id], {
    cwd: host.folder,
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
}

// Returns a line for sh that runs the plugin's attach command on a session, in the plugin's folder
// with its environment, as attachOnHost does, for the screen to run in its right pane.
export function attachOnHostLine(host: PluginHost, id: string): string {
  const { argv, env } = commandFor(host.plugin, host.attach);
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${quoteForSh(value)}`);
  const words = [...argv, id].map(quoteForSh).join(" ");
  return `cd ${quoteForSh(host.folder)} && env ${assignments.join(" ")} ${words}`;
}
