// Installed plugins: reading a plugin's manifest, finding its folder, and running its commands.
// Skelcrew runs a plugin's call to ask a tracker or forge something, and its git_credentials to
// give git a forge's login.
import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { configDir } from "../paths.ts";
import { singleFile } from "../version.ts";

// A command is a list of words, never one line for a shell.
const Command = z.array(z.string().min(1)).min(1);
// A version as three numbers, such as 0.1.0. A manifest gives the plugin's own version this way,
// and the oldest Skelcrew it runs on. The plugin's git tag is its version with a v in front.
export const Version = z.string().regex(/^\d+\.\d+\.\d+$/, "must be a version such as 0.1.0");

// The commands a plugin must have for each job it says it does. Chat needs none yet. Its
// commands come with the first chat plugin.
const commandsForJob = {
  tracker: ["call"],
  forge: ["call", "git_credentials"],
  chat: [],
  machine: ["add", "exec", "push"],
} as const;

// What a plugin's skelcrew-plugin.yaml says. Its name becomes a folder and an environment value,
// so it is only lowercase letters, digits and dashes. It can't be none, because tracker: none in
// a repository's skelcrew.yaml means no tracker.
export const Manifest = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes")
      .refine((name) => name !== "none", "can't be none, which skelcrew.yaml uses for no tracker"),
    version: Version,
    skelcrew: Version,
    about: z.string().min(1),
    jobs: z.array(z.enum(["tracker", "forge", "chat", "machine"])).min(1),
    build: z.array(Command).optional(),
    setup: Command.optional(),
    call: Command.optional(),
    git_credentials: Command.optional(),
    add: Command.optional(),
    exec: Command.optional(),
    push: Command.optional(),
  })
  // A plugin that names a job must have each command that job needs.
  .superRefine((manifest, context) => {
    for (const job of manifest.jobs)
      for (const command of commandsForJob[job])
        if (manifest[command] === undefined)
          context.addIssue({
            code: "custom",
            path: [command],
            message: `a ${job} plugin needs ${command}`,
          });
  });
export type Manifest = z.infer<typeof Manifest>;

// Returns the manifest in a plugin's folder, or throws saying what is wrong with it. The
// folder is the plugin's, so a link, which could point Skelcrew at any file of yours, is refused.
export function readManifest(folder: string): Manifest {
  const file = join(folder, "skelcrew-plugin.yaml");
  // lstat, so a link is seen as one and refused, not followed.
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile())
    throw new Error(`${folder} has no skelcrew-plugin.yaml, so it isn't a plugin`);
  let parsed: unknown;
  try {
    parsed = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} isn't valid YAML: ${String(error)}`);
  }
  const manifest = Manifest.safeParse(parsed);
  if (!manifest.success) throw new Error(`${file} isn't valid: ${z.prettifyError(manifest.error)}`);
  return manifest.data;
}

// An installed plugin as the database records it: its name, its folder, and the GitHub repository
// it came from. The source is null for a plugin installed from a folder of yours, which stays
// where it is.
export const Plugin = z.object({
  name: z.string(),
  folder: z.string(),
  source: z.string().nullable(),
});
export type Plugin = z.infer<typeof Plugin>;

// Returns the installed plugins, by name.
export const installedPlugins = (db: Database): Plugin[] =>
  db
    .query("SELECT name, folder, source FROM plugins ORDER BY name")
    .all()
    .map((row) => Plugin.parse(row));

// Returns the installed plugin of that name, or throws when there is none.
export function findPlugin(db: Database, name: string): Plugin {
  const found = installedPlugins(db).find((plugin) => plugin.name === name);
  if (!found) throw new Error(`there is no plugin named ${name}: sc plugin ls lists them`);
  return found;
}

// Returns the folder where a plugin keeps its settings and tokens. It is made readable only
// by you, as it holds logins.
export function settingsDir(name: string): string {
  const folder = join(configDir(), "plugins", name);
  mkdirSync(join(configDir(), "plugins"), { recursive: true, mode: 0o700 });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  return folder;
}

// Returns the program and arguments that run one of a plugin's commands, and the environment
// values to add. The environment tells the plugin its name and its settings folder. A first word
// of bun becomes the Bun that runs Skelcrew, so a plugin written for Bun needs nothing else
// installed. A single-file Skelcrew is Bun too, and acts as Bun when BUN_BE_BUN is set.
export function commandFor(name: string, words: string[]) {
  const [first, ...rest] = words;
  // Only a first word of exactly bun is Skelcrew's own Bun. Any other program is found on
  // your PATH.
  const argv = first === "bun" ? [process.execPath, ...rest] : words;
  const env: Record<string, string> = {
    ...(first === "bun" && singleFile ? { BUN_BE_BUN: "1" } : {}),
    SKELCREW_PLUGIN: name,
    SKELCREW_PLUGIN_CONFIG: settingsDir(name),
  };
  return { argv, env };
}

// The error when a plugin's call exits with code 2, which means the plugin needs its setup
// again. That happens when its sign-in lapsed, or when GitHub's app isn't on the repository. The
// message names the command that fixes it. `plugin` lets sc run that setup itself when you are at
// a terminal.
export class SetupNeeded extends Error {
  constructor(
    readonly plugin: string,
    reason: string,
  ) {
    super(`${plugin} failed: ${reason}. Run sc plugin setup ${plugin} to set it up again.`);
  }
}

// Asks a plugin one question through its call command, and returns the answer checked against
// `Answer`. The call gets the question as one JSON line on stdin and prints one JSON answer. When
// the call fails, this throws the last line of its stderr. Exit code 2 throws SetupNeeded
// instead. A call that runs longer than `timeout` milliseconds is killed, so a hung plugin can't
// hold up the daemon.
export async function callPlugin<T>(
  db: Database,
  name: string,
  question: object,
  Answer: z.ZodType<T>,
  timeout = 60_000,
): Promise<T> {
  const plugin = findPlugin(db, name);
  // The manifest is read each time, so a plugin updated meanwhile is asked as it is now.
  const { call } = readManifest(plugin.folder);
  if (!call) throw new Error(`${name} has no call command, so Skelcrew can't ask it anything`);
  const { argv, env } = commandFor(name, call);
  // In a process group of its own, so a timeout ends whatever the call started too. Ending
  // only the call would leave a program it started holding its output open, and the wait
  // for that output would never end.
  const run = Bun.spawn(argv, {
    cwd: plugin.folder,
    env: { ...process.env, ...env },
    stdin: new Blob([`${JSON.stringify(question)}\n`]),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  // At the deadline the whole group is killed, and the race below ends as late.
  let timer: Timer | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => {
      try {
        process.kill(-run.pid, "SIGKILL");
      } catch {}
      done("late");
    }, timeout);
  });
  // Raced against the deadline as well: a program that left the group could still hold the
  // output open.
  const finished = await Promise.race([
    Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]),
    late,
  ]);
  clearTimeout(timer);
  if (finished === "late")
    throw new Error(`${name} didn't answer within ${timeout / 1000} seconds`);
  const [out, err, code] = finished;
  if (code !== 0) {
    const last = err.trim().split("\n").at(-1) || `its call exited with code ${code}`;
    // Code 2 is how a plugin says it needs its setup again, such as when its sign-in lapsed,
    // so the error says what fixes it.
    if (code === 2) throw new SetupNeeded(name, last);
    throw new Error(`${name} failed: ${last}`);
  }
  // Output that isn't JSON fails the check below, with the same error as a wrong answer.
  let answer: unknown;
  try {
    answer = JSON.parse(out);
  } catch {
    answer = undefined;
  }
  const checked = Answer.safeParse(answer);
  if (!checked.success) throw new Error(`${name} answered in a way Skelcrew doesn't understand`);
  return checked.data;
}

// Quotes a word for sh. git runs a credential helper through sh.
const quoteForSh = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;

// Returns the git options that make a forge's git_credentials command git's only credential
// helper, for one git command. The options are passed on each command and never saved. So no
// clone's .git/config names the helper, and agents read those files. The helper runs in the
// plugin's folder with the plugin's environment, like any of its commands.
export function gitCredentials(db: Database, name: string): string[] {
  const plugin = findPlugin(db, name);
  const { git_credentials } = readManifest(plugin.folder);
  if (!git_credentials)
    throw new Error(`${name} has no git_credentials, so it can't lend git a login`);
  const { argv, env } = commandFor(name, git_credentials);
  // One line for sh: go to the plugin's folder, set its environment, and run the command.
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${quoteForSh(value)}`);
  const helper = `cd ${quoteForSh(plugin.folder)} && ${assignments.join(" ")} exec ${argv.map(quoteForSh).join(" ")}`;
  // The empty helper first clears any you set, such as gh's, so git asks only this plugin.
  // git leaves out the repository's path unless told, and the forge's login can be for one
  // repository alone.
  return [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!${helper}`,
    "-c",
    "credential.useHttpPath=true",
  ];
}
