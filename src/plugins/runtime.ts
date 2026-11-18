// Runtime plugins as session hosts. A plugin that provides sessions runs agents' sessions in
// place of tmux, and may also carry text into them and show their status. Skelcrew asks it
// through its session command, as it asks a tracker through call: one JSON question on stdin,
// one JSON answer on stdout.
import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { commandFor, installedPlugins, readManifest } from "./plugin.ts";

// A runtime plugin that hosts sessions: its name, its folder, its session and attach commands,
// and whether it also provides the transport and the status. The sessions module uses Skelcrew's
// built-in for any it doesn't.
export type PluginHost = {
  plugin: string;
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
export function hostNamed(db: Database, sessions: string, name: string): Host | null {
  if (name === "tmux") return sessions;
  const plugin = installedPlugins(db).find((installed) => installed.name === name);
  if (!plugin) return null;
  const manifest = readManifest(plugin.folder);
  const { session, attach } = manifest;
  if (!manifest.provides.includes("sessions") || !session || !attach) return null;
  return {
    plugin: name,
    folder: plugin.folder,
    session,
    attach,
    transport: manifest.provides.includes("transport"),
    status: manifest.provides.includes("status"),
  };
}

// Returns the program, environment and folder that run the host's session command, with the
// plugin's environment added to Skelcrew's own.
function sessionCommand(host: PluginHost) {
  const { argv, env } = commandFor(host.plugin, host.session);
  return { argv, env: { ...process.env, ...env }, cwd: host.folder };
}

// Returns a host's answer checked against `Answer`, or throws saying what went wrong: the last
// line it wrote to stderr when it failed, or that its answer isn't understood.
function checkAnswer<T>(
  host: PluginHost,
  question: { ask: string; [key: string]: unknown },
  done: { out: string; err: string; code: number | null },
  Answer: z.ZodType<T>,
): T {
  if (done.code === null) throw new Error(`${host.plugin} didn't answer ${question.ask} in time`);
  if (done.code !== 0) {
    const last = done.err.trim().split("\n").at(-1) || `it exited with code ${done.code}`;
    throw new Error(`${host.plugin} couldn't ${question.ask}: ${last}`);
  }
  // Output that isn't JSON fails the check below, with the same error as a wrong answer.
  let answer: unknown;
  try {
    answer = JSON.parse(done.out);
  } catch {
    answer = undefined;
  }
  const checked = Answer.safeParse(answer);
  if (!checked.success)
    throw new Error(`${host.plugin} answered ${question.ask} in a way Skelcrew doesn't understand`);
  return checked.data;
}

// Asks the host one question about its sessions and returns its answer, checked against
// `Answer`. It waits for the answer, as each tmux command does, so the flow reads the same on
// every host. A host that hasn't answered within 30 seconds is killed, so a hung plugin can't
// hold up the daemon for long.
export function askHost<T>(
  host: PluginHost,
  question: { ask: string; [key: string]: unknown },
  Answer: z.ZodType<T>,
): T {
  const run = Bun.spawnSync(sessionCommand(host).argv, {
    ...sessionCommand(host),
    stdin: new Blob([`${JSON.stringify(question)}\n`]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const done = { out: run.stdout.toString(), err: run.stderr.toString(), code: run.exitCode };
  return checkAnswer(host, question, done, Answer);
}

// Asks the host a question whose answer can take a while, such as delivering a message once its
// agent is idle, without holding up the daemon meanwhile. Returns null when `signal` aborts
// first: the command is killed then, so it types nothing more.
export async function askHostLater<T>(
  host: PluginHost,
  question: { ask: string; [key: string]: unknown },
  Answer: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  const run = Bun.spawn(sessionCommand(host).argv, {
    ...sessionCommand(host),
    stdin: new Blob([`${JSON.stringify(question)}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const kill = () => run.kill("SIGKILL");
  signal?.addEventListener("abort", kill);
  try {
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    if (signal?.aborted) return null;
    return checkAnswer(host, question, { out, err, code }, Answer);
  } finally {
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
