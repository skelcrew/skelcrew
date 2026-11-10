// How Codex runs inside the sandbox: as the lead or a builder, in a tmux session with a
// CODEX_HOME of its own, and as the reviewer, once per review. All of them share skel's own
// login.
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { keptEnv, refuseCredentials, ro, rw, sandboxArgs, throwaway } from "./sandbox.ts";

// Returns skel's own CODEX_HOME, where the first run's codex login goes and reviews run: a
// login of skel's own, apart from yours in ~/.codex, so a renewal on either side never breaks
// the other. A caller that was handed an environment passes its HOME, as for dataDir.
export const codexHome = (home = homedir()) => join(dataDir(home), "codex");

// Puts skel's Codex login in a folder of its own, holding only auth.json and auth.lock, and
// links them from `folder`, a CODEX_HOME: skel's own unless another is named. Returns the
// login folder, which every Codex sandbox gets writable. From 0.167 Codex renews its login by
// renaming a new auth.json over the old one, beside the file a link leads to. A file mounted
// on its own can't be renamed over, and by then the old refresh token is spent, which would
// leave skel's login stale. Its lock is shared the same way, so two renewals take turns.
function shareLogin(home: string, folder = codexHome(home)): string {
  const login = join(dataDir(home), "codex-login");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  mkdirSync(login, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "auth.lock"]) {
    const at = join(folder, file);
    const found = lstatSync(at, { throwIfNoEntry: false });
    if (found?.isSymbolicLink() && readlinkSync(at) === join(login, file)) continue;
    // The first run's codex login writes a plain auth.json in skel's own folder. Anywhere
    // else the agent can write what is there, so it is never taken for skel's login.
    if (found?.isFile() && folder === codexHome(home)) renameSync(at, join(login, file));
    else rmSync(at, { force: true });
    symlinkSync(join(login, file), at);
  }
  return login;
}

const SessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.looseObject({
    id: z.string().regex(/^[0-9a-f-]{36}$/),
    cwd: z.string(),
    source: z.unknown(),
  }),
});

// Returns the first line of a file, up to 1 MB, or nothing when it isn't a plain file. The
// agent can write in the folder, so a link or a pipe is never read: opening a pipe would wait
// forever.
function firstLine(file: string): string {
  if (!lstatSync(file).isFile()) return "";
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
  } finally {
    closeSync(fd);
  }
}

// Returns the ID of the conversation a session saved in `folder`, for codex resume to bring
// back, or null when it saved none. Codex picks the ID itself, so `_session`, the one skel
// keeps, can be another. Each session's CODEX_HOME holds its own conversation, but a review or
// a sub-agent started from it saves there too, so only one whose session_meta, the file's
// first line, says it came from the interactive CLI counts. The newest wins: its file names
// start with the time.
function savedConversation(name: string, folder: string, _session: string): string | null {
  const sessions = join(dataDir(), "codex-sessions", name, "sessions");
  const files: string[] = [];
  // Every rollout file under sessions/YYYY/MM/DD/, never following a link.
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }))
      if (entry.isDirectory()) walk(join(at, entry.name));
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name))
        files.push(join(at, entry.name));
  };
  if (lstatSync(sessions, { throwIfNoEntry: false })?.isDirectory()) walk(sessions);
  files.sort((a, b) => (a.split("/").at(-1) ?? "").localeCompare(b.split("/").at(-1) ?? ""));
  for (const file of files.reverse()) {
    let meta: unknown;
    try {
      meta = JSON.parse(firstLine(file));
    } catch {
      continue;
    }
    const read = SessionMeta.safeParse(meta);
    if (read.success && read.data.payload.source === "cli" && read.data.payload.cwd === folder)
      return read.data.payload.id;
  }
  return null;
}

// Returns a TOML value for a -c setting. JSON's strings are TOML's too.
const toml = (text: string) => JSON.stringify(text);

// A builder on Codex asks you a question by ending its turn without skel submit, since Codex
// has no tool for asking, and its Stop hook tells skel the turn ended. Whatever is typed into
// the builder next ends the question, as on Claude Code. The commands print nothing, and run
// with no trust asked for: Codex would otherwise wait for a person to trust each one.
const hookOf = (command: string) =>
  `[{hooks=[{type="command",command=${toml(command)},timeout=10}]}]`;
const builderHooks = [
  ["-c", `hooks.Stop=${hookOf("skel turn ended")}`],
  ["-c", `hooks.UserPromptSubmit=${hookOf("skel question answered")}`],
].flat();

// Throws when Codex doesn't offer the model, saying which it does. An unknown model only shows
// an error inside the session, which then waits at its prompt with no hook to tell skel. Asked
// with skel's own CODEX_HOME, which reviews can't change, outside the sandbox. It can take
// seconds, and the daemon must keep answering builders' hooks meanwhile, so it never blocks.
async function checkModel(home: string, model: string, env: Record<string, string | undefined>) {
  const asked = Bun.spawn(["codex", "debug", "models"], {
    env: { ...env, CODEX_HOME: codexHome(home) },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  const [out, err] = await Promise.all([
    new Response(asked.stdout).text(),
    new Response(asked.stderr).text(),
    asked.exited,
  ]);
  const Models = z.object({ models: z.array(z.looseObject({ slug: z.string() })) });
  let models: string[];
  try {
    models = Models.parse(JSON.parse(out)).models.map((m) => m.slug);
  } catch {
    throw new Error(`codex debug models didn't list Codex's models: ${err.trim()}`);
  }
  if (!models.includes(model))
    throw new Error(`Codex doesn't offer the model ${model}. It offers ${models.join(", ")}`);
}

// Prepares a session's own CODEX_HOME and returns its sandbox command and environment, for the
// lead or a builder. It starts afresh with the first message in `prompt`, or brings back a
// saved conversation with `resume`. A builder, given its thread's clone, works there; a lead
// works in its own `folder`. Each sees nothing else but `origin`, skel's clone of its
// repository, read-only, and the login it shares with every Codex session.
//
// Settings go on the command line rather than in the session's config.toml: a repository's
// own .codex/config.toml wins over that file, and could turn the hooks off. Codex's own
// sandbox and approvals are off, since skel's sandbox draws the boundary. Codex picks its own
// session ID, so `sessionId` is not passed on.
async function startCommand(given: {
  name: string;
  socket: string;
  model?: string | undefined;
  thread?: string;
  folder?: string;
  origin?: string;
  prompt?: string;
  system?: string;
  resume?: string;
  sessionId?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ argv: string[]; env: Record<string, string> }> {
  const { name, socket, model, thread, folder, origin, prompt, system, resume } = given;
  const env = given.env ?? process.env;
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so skel can't find its own folders");
  // The name becomes a folder, so it must not climb out of skel's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);
  if (model) await checkModel(home, model, env);

  // A folder of its own per session, never your ~/.codex: an agent could write instructions
  // that another session loads. It stays, so codex resume finds the conversation.
  const sessions = join(dataDir(home), "codex-sessions");
  const own = join(sessions, name);
  // skel writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [sessions, own])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so skel won't write through it`);
  mkdirSync(own, { recursive: true, mode: 0o700 });
  // skel's own folder first, so a login the first run just saved there moves to the shared
  // folder before this session links to it.
  shareLogin(home);
  const login = shareLogin(home, own);
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`skel has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(own), ...rw(login)];
  // Read-only at the same path, as for Claude Code.
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }

  // --no-daemon belongs to codex itself: without it Codex may start a background server that
  // outlives the session.
  const command = ["codex", ...(resume ? ["resume"] : []), "--no-daemon"];
  command.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
  // The folder trusted, or Codex asks first. No update check, which only fails in the
  // sandbox, and no paste burst, which could take a message typed in for keys.
  command.push("-c", `projects.${toml(cwd)}.trust_level="trusted"`);
  command.push("-c", "check_for_update_on_startup=false", "-c", "tui.disable_paste_burst=true");
  command.push("-c", "features.hooks=true");
  if (thread) command.push(...builderHooks);
  if (system) command.push("-c", `developer_instructions=${toml(system)}`);
  if (model) command.push("-m", model);
  if (resume) command.push(resume);
  // After --, so a message that starts with - is never taken for an option.
  else if (prompt) command.push("--", prompt);

  const kept = keptEnv(env, codex.keys);
  kept.CODEX_HOME = own;
  const argv = sandboxArgs({ home, path: env.PATH ?? "", mounts, socket, cwd, command });
  return { argv, env: kept };
}

// Returns Codex's review command, mounts and environment, protecting instructions shared by
// reviews. The command reads the review's prompt on stdin and the answer's shape from the
// review's folder. skel's Codex folder holds what Codex reads as instructions, and every review
// shares it. So the reviewer sees it as a throwaway folder, and only its sessions and the
// login folder reach the real ones.
async function review(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  sprite: boolean;
  signal: AbortSignal;
}) {
  const { home, folder, model, sprite, signal } = given;
  const shared = codexHome(home);
  const login = shareLogin(home);
  const sessions = join(shared, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const copy = join(folder, "codex");
  const { mounts, at } = await throwaway({
    source: shared,
    copy,
    sprite,
    signal,
    kept: ["sessions"],
  });
  mounts.push("--bind", sessions, sessions, "--bind", login, login);
  // A copy at another path can't have the real one mounted into it, so it links to it.
  if (at !== shared) symlinkSync(sessions, join(at, "sessions"));
  // --no-daemon belongs to codex itself, not to exec: without it Codex may start a
  // background server that outlives the review.
  const command = ["codex", "--no-daemon", "exec", "--dangerously-bypass-approvals-and-sandbox"];
  // With none named, Codex runs on its own default.
  if (model) command.push("-m", model);
  command.push("--output-schema", join(folder, "schema.json"), "-o", join(folder, "answer.json"));
  command.push("-");
  return { command, mounts, env: { CODEX_HOME: at } };
}

// Returns the reviewer's answer from the file Codex wrote it to, for the reviewer to check
// against the shape. Read only after Codex ends, so it can't change the file meanwhile.
function answer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Codex as skel knows it. While a turn runs it shows "esc to interrupt". Its empty input
// always shows "› Ask Codex to do anything", even mid-turn, so that whole line is its prompt:
// a line holding only › never shows. codex exec reads CODEX_API_KEY: given only
// OPENAI_API_KEY, it sent no key at all, so both get into the sandbox for those who use a key
// rather than a login.
export const codex = {
  name: "codex",
  title: "Codex",
  marks: { busy: "esc to interrupt", prompt: "› Ask Codex to do anything" },
  keys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  start: startCommand,
  saved: savedConversation,
  review,
  answer,
} as const;
