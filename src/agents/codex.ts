// How Codex runs inside the sandbox: as the lead or a builder, in a tmux session with a
// CODEX_HOME of its own, and as the reviewer, once per review. All of them share Skelcrew's own
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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { copySkills, type SkillsFrom } from "../skills.ts";
import { editing, type Progress, toolWords } from "./progress.ts";
import { resetTime } from "./reset.ts";
import {
  everyRepository,
  filterEnv,
  refuseCredentials,
  ro,
  rw,
  sandboxArgs,
  throwawayMounts,
} from "./sandbox.ts";

// Returns Skelcrew's own CODEX_HOME, where the first run's codex login goes and reviews run: a
// login of Skelcrew's own, apart from yours in ~/.codex, so a renewal on either side never breaks
// the other. A caller that was handed an environment passes its HOME, as for dataDir.
export const codexHome = (home = homedir()) => join(dataDir(home), "codex");

// Puts Skelcrew's Codex login in a folder of its own, holding only auth.json and auth.lock, and
// links them from `folder`, a CODEX_HOME: Skelcrew's own unless another is named. Returns the
// login folder, which every Codex sandbox gets writable. From 0.167 Codex renews its login by
// renaming a new auth.json over the old one, beside the file a link leads to. A file mounted
// on its own can't be renamed over, and by then the old refresh token is spent, which would
// leave Skelcrew's login stale. Its lock is shared the same way, so two renewals take turns.
function shareLogin(home: string, folder = codexHome(home)): string {
  const login = join(dataDir(home), "codex-login");
  // Both folders are yours alone, as they hold a login.
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  mkdirSync(login, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "auth.lock"]) {
    const at = join(folder, file);
    // A link already leading to the shared login is left as it is.
    const found = lstatSync(at, { throwIfNoEntry: false });
    if (found?.isSymbolicLink() && readlinkSync(at) === join(login, file)) continue;
    // The first run's codex login writes a plain auth.json in Skelcrew's own folder. Anywhere
    // else the agent can write what is there, so it is never taken for Skelcrew's login.
    if (found?.isFile() && folder === codexHome(home)) renameSync(at, join(login, file));
    else rmSync(at, { force: true });
    symlinkSync(join(login, file), at);
  }
  return login;
}

// The first line of a Codex conversation file: its ID, the folder it ran in, and what
// started it, such as the interactive CLI or a review.
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
// back, or null when it saved none. Codex picks the ID itself, so `_session`, the one Skelcrew
// keeps, can be another.
function savedConversation(name: string, folder: string, _session: string): string | null {
  return newestConversation(name, folder)?.id ?? null;
}

// Returns the file of the conversation a session saved in `folder`, as savedConversation finds
// it, or null when it saved none. The sidebar reads it for the builder's progress.
function conversationFile(name: string, folder: string, _session: string): string | null {
  return newestConversation(name, folder)?.file ?? null;
}

// Returns the newest conversation a session saved in `folder`, with its file and ID. Each
// session's CODEX_HOME holds its own conversation, but a review or a sub-agent started from it
// saves there too, so only one whose session_meta, the file's first line, says it came from the
// interactive CLI counts. The newest wins: its file names start with the time.
function newestConversation(name: string, folder: string): { file: string; id: string } | null {
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
  // Newest first, by file name alone, as the folders above it only repeat the date. The first
  // from the interactive CLI in this folder is the one; a line that isn't JSON is skipped.
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
      return { file, id: read.data.payload.id };
  }
  return null;
}

// A line of a conversation file with Codex's running count of the tokens the session used.
// Its input includes what came from the cache, which it also gives on its own.
const TokenCountLine = z.object({
  type: z.literal("event_msg"),
  payload: z.object({
    type: z.literal("token_count"),
    info: z.object({
      total_token_usage: z.object({
        input_tokens: z.number(),
        cached_input_tokens: z.number().optional(),
        output_tokens: z.number(),
      }),
    }),
  }),
});
// A line of a conversation file with a tool call: a function's arguments come as JSON text, a
// custom tool's input, such as apply_patch's patch, as plain text, and a local shell call's
// command as its words.
const CallLine = z.object({
  type: z.literal("response_item"),
  payload: z.object({
    type: z.enum(["function_call", "custom_tool_call", "local_shell_call"]),
    name: z.string().optional(),
    arguments: z.string().optional(),
    input: z.string().optional(),
    action: z.object({ command: z.array(z.string()) }).optional(),
  }),
});
// What update_plan is given: the builder's whole plan, each step with its status.
const Plan = z.object({ plan: z.array(z.object({ status: z.string() })) });
// What a tool is given: a shell tool's command as words, or as one line of text, by tool and
// release, or a patch as its input.
const Shell = z.looseObject({
  command: z.union([z.array(z.string()), z.string()]).optional(),
  cmd: z.string().optional(),
  input: z.string().optional(),
});

// Adds what `lines` of a builder's conversation file say to its progress so far: its tokens from
// Codex's newest running count, its latest step and its latest plan. Cached input is left out of
// the tokens, as each turn reads the whole conversation again from the cache. Codex counts no
// cache writes of its own: the input that didn't come from the cache stands for them.
function readProgress(lines: string[], before: Progress): Progress {
  let { step, tokens, plan } = before;
  for (const line of lines) {
    // Most lines are something else, and parsing each would be slow on a long conversation.
    if (!line.includes('"token_count"') && !line.includes("_call")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const counted = TokenCountLine.safeParse(parsed);
    if (counted.success) {
      const usage = counted.data.payload.info.total_token_usage;
      tokens = usage.input_tokens - (usage.cached_input_tokens ?? 0) + usage.output_tokens;
      continue;
    }
    const call = CallLine.safeParse(parsed);
    if (!call.success) continue;
    // update_plan sets the plan, and every other call is the step, or ends the one before when
    // it has nothing short to say.
    const { name = "", input, action } = call.data.payload;
    const given = parseArguments(call.data.payload.arguments);
    const planned = name === "update_plan" ? Plan.safeParse(given) : null;
    if (planned?.success) {
      const steps = planned.data.plan;
      plan = {
        done: steps.filter((item) => item.status === "completed").length,
        total: steps.length,
      };
    } else if (name !== "update_plan") step = callStep(name, given, input ?? "", action?.command);
  }
  return { step, tokens, plan, last: "" };
}

// Returns a function call's arguments, which Codex writes as JSON text, or nothing when they
// aren't JSON.
function parseArguments(text = ""): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// Returns the step a tool call says the builder is on, in a few words, or null when it has none:
// a patch as the first file it changes, and any other tool as its name in words. Codex gives a
// command no description, and the command itself, such as a cd and a heredoc, reads as noise in
// a row, so a command has no step.
function callStep(
  name: string,
  given: unknown,
  input: string,
  command: string[] | undefined,
): string | null {
  const shell = Shell.safeParse(given);
  const args = shell.success ? shell.data : {};
  if (command || args.command !== undefined || args.cmd !== undefined) return null;
  // A patch names each file it changes on a line of its own.
  const patch = name === "apply_patch" ? input || args.input || "" : "";
  const file = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(patch)?.[1];
  if (file) return editing(file);
  return toolWords(name);
}

// Returns a TOML value for a -c setting. JSON's strings are TOML's too.
const tomlString = (text: string) => JSON.stringify(text);

// The shell step a Codex builder or reviewer starts through, inside its sandbox, in the folder it
// works in: Codex loads by itself the skills it finds in .agents/skills/ there and follows links
// there, wherever they lead. Those are the default branch's or the builder's, not the ones you
// approved, which come from the session's own folder or are listed in the prompt. Run inside the
// sandbox, the step sees exactly what Codex will, at the moment it starts.
// It counts the SKILL.md files with one x each, then lists them a line each, and stops when the
// two disagree, as a line break in a path would split it. Each is turned off as found from the
// folder's top and as its real path, with \ and " escaped for TOML, by a -c setting put in after
// the number of Codex's arguments its first argument gives. find stays quiet on a broken link or
// a loop, which Codex can't load either. Only options every find has are used, -L and -name, as
// an option a Mac's find lacked would fail quietly and turn nothing off, and a missing find or
// realpath stops Codex for the same reason. The array may end with a comma, as TOML allows.
const skillsOffStep = String.raw`k=$1; shift
command -v find > /dev/null && command -v realpath > /dev/null || { echo "Skelcrew needs find and realpath to keep unapproved skills from Codex" >&2; exit 1; }
count=$(find -L .agents/skills -name SKILL.md -exec printf x \; 2>/dev/null; true)
list=$(find -L .agents/skills -name SKILL.md 2>/dev/null; true)
if [ -n "$list" ] && [ "$(printf '%s\n' "$list" | wc -l)" -ne "$(printf %s "$count" | wc -c)" ]; then
  echo "a path in .agents/skills/ holds a line break, so Skelcrew won't start Codex there" >&2; exit 1
fi
off=$(printf '%s\n' "$list" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  for p in "$PWD/$f" "$(realpath "$f" 2>/dev/null)"; do
    [ -n "$p" ] && printf '{path="%s",enabled=false},' "$(printf '%s' "$p" | sed 's/[\\"]/\\&/g')"
  done
done)
i=0
for a do
  shift
  [ "$i" -eq "$k" ] && set -- "$@" -c "skills.config=[$off]"
  set -- "$@" "$a"
  i=$((i + 1))
done
exec codex "$@"`;

// Returns the command that runs codex with `args` through skillsOffStep, its setting put in after
// the first `after` of them.
const withSkillsOff = (after: number, args: string[]): string[] => [
  "sh",
  "-c",
  skillsOffStep,
  "sh",
  String(after),
  ...args,
];

// Codex's hooks tell Skelcrew what each agent, the lead and builders alike, is doing: a message
// going in starts a turn, which ends with Stop, or with Interrupt when you press Esc. A builder
// on Codex asks a question by ending its turn without sc submit, since Codex has no tool for
// asking, and Stop tells Skelcrew the turn ended, as Claude Code's does. Its last message goes to
// the lead, who brings the question to you. Whatever is typed into the builder next starts a new
// turn. Esc flags nothing, as you are
// looking at the agent anyway. An error ends a turn with no hook, so Skelcrew reads that from
// the screen. The commands print nothing, and run with no trust asked for: Codex would
// otherwise wait for a person to trust each one.
const hookToml = (command: string) =>
  `[{hooks=[{type="command",command=${tomlString(command)},timeout=10}]}]`;
const agentHooks = [
  ["-c", `hooks.Stop=${hookToml("sc turn ended")}`],
  ["-c", `hooks.UserPromptSubmit=${hookToml("sc question answered")}`],
  ["-c", `hooks.Interrupt=${hookToml("sc turn interrupted")}`],
].flat();

// Throws when Codex doesn't offer the model, saying which it does. An unknown model only shows
// an error inside the session, which then waits at its prompt with no hook to tell Skelcrew. It
// asks Codex outside the sandbox, with Skelcrew's own CODEX_HOME, which reviews can't change. It
// can take seconds, and the daemon must keep answering builders' hooks meanwhile, so it never
// blocks.
async function checkModel(home: string, model: string, env: Record<string, string | undefined>) {
  const listing = Bun.spawn(["codex", "debug", "models"], {
    env: { ...env, CODEX_HOME: codexHome(home) },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  // Read both outputs while waiting, so a full pipe can't stall Codex.
  const [out, err] = await Promise.all([
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
    listing.exited,
  ]);
  // The answer is JSON listing each model by its slug, the name -m takes.
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
// works in its own `folder`. Each sees nothing else but `origin`, Skelcrew's clone of its
// repository, read-only, the login it shares with every Codex session, and for a lead
// `repositories`, the folder of every repository's clone, read-only.
//
// Settings go on the command line rather than in the session's config.toml: a repository's
// own .codex/config.toml wins over that file, and could turn the hooks off. Codex's own
// sandbox and approvals are off, since Skelcrew's sandbox draws the boundary. Codex picks its own
// session ID, so `sessionId` is not passed on. The repository's skills, from the .agents/
// `skills` names, go into the CODEX_HOME's skills/, where Codex finds them.
async function startCommand(given: {
  name: string;
  socket: string;
  model?: string | undefined;
  thread?: string;
  folder?: string;
  origin?: string;
  repositories?: string;
  prompt?: string;
  system?: string;
  resume?: string;
  sessionId?: string;
  skills?: SkillsFrom;
  env?: Record<string, string | undefined>;
}): Promise<{ argv: string[]; env: Record<string, string> }> {
  const { name, socket, model, thread, folder, origin, repositories, prompt, system, resume } =
    given;
  const { skills } = given;
  const env = given.env ?? process.env;
  // Refuse what would start the wrong agent or write outside Skelcrew's folders, and a model
  // Codex doesn't offer.
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  // The name becomes a folder, so it must not climb out of Skelcrew's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);
  if (model) await checkModel(home, model, env);

  // A folder of its own per session, never your ~/.codex: an agent could write instructions
  // that another session loads. It stays, so codex resume finds the conversation.
  const sessions = join(dataDir(home), "codex-sessions");
  const sessionHome = join(sessions, name);
  const instructions = join(sessionHome, "skelcrew.config.toml");
  // Skelcrew writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [sessions, sessionHome, instructions])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so Skelcrew won't write through it`);
  mkdirSync(sessionHome, { recursive: true, mode: 0o700 });
  // The instructions go in a profile of the session's own, as developer instructions, which
  // weigh more than an AGENTS.md. On the command line they would stop the session: tmux refuses
  // a start command past about 16 KB, and Linux an argument past 128 KB.
  if (system) writeFileSync(instructions, `developer_instructions = ${tomlString(system)}\n`);
  if (skills) copySkills(skills, join(sessionHome, "skills"), home);
  // Skelcrew's own folder first, so a login the first run just saved there moves to the shared
  // folder before this session links to it.
  shareLogin(home);
  const login = shareLogin(home, sessionHome);
  // The agent sees its own folder, its CODEX_HOME and the shared login, all writable, and
  // nothing else of yours.
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(sessionHome), ...rw(login)];
  // Read-only at the same path, as for Claude Code.
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }
  // Every repository's clone, read-only, for a lead, as for Claude Code.
  if (repositories) mounts.push(...everyRepository(repositories));

  // --no-daemon belongs to codex itself: without it Codex may start a background server that
  // outlives the session.
  const command = ["codex", ...(resume ? ["resume"] : []), "--no-daemon"];
  command.push("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust");
  // The folder trusted, or Codex asks first. No update check, which only fails in the
  // sandbox, and no paste burst, which could take a message typed in for keys.
  command.push("-c", `projects.${tomlString(cwd)}.trust_level="trusted"`);
  command.push("-c", "check_for_update_on_startup=false", "-c", "tui.disable_paste_burst=true");
  command.push("-c", "features.hooks=true", ...agentHooks);
  // Codex layers $CODEX_HOME/skelcrew.config.toml over its config when asked for that profile.
  // A repository's own .codex/config.toml could win over it, but Codex loads that only for a
  // folder trusted in a config file, not by the -c above.
  if (system) command.push("-p", "skelcrew");
  if (model) command.push("-m", model);
  if (resume) command.push(resume);
  // After --, so a message that starts with - is never taken for an option.
  else if (prompt) command.push("--", prompt);

  // Only the environment the agent needs, plus its own CODEX_HOME.
  const kept = filterEnv(env, codex.keys);
  kept.CODEX_HOME = sessionHome;
  const path = env.PATH ?? "";
  // Codex starts through the step that turns off the skills in its folder's .agents/skills/,
  // put in after resume and --no-daemon. Only a builder has a thread. The lead is what you type
  // into, so it keeps its priority.
  const argv = sandboxArgs({
    home,
    path,
    mounts,
    socket,
    cwd,
    command: withSkillsOff(resume ? 2 : 1, command.slice(1)),
    programs: ["codex"],
    normalPriority: !thread,
  });
  return { argv, env: kept };
}

// Returns Codex's review command, mounts and environment. The command reads the review's prompt
// on stdin and the answer's shape from the review's folder. Every review shares Skelcrew's Codex
// folder, which holds what Codex reads as instructions. So the reviewer sees a throwaway copy of
// it, and only its sessions and the login folder reach the real ones. Its skills/ stays empty,
// as a copy there would steer every later review, so the repository's skills go into the
// review's own folder and are returned for the prompt to list.
// The command starts Codex through skillsOffStep, once the review's view is the submitted
// commit, so the builder's skills there stay unloaded, though it added one at any moment
// before, and the checkout stays as committed. Any character TOML can't hold in a path makes
// Codex refuse the setting, which fails the review.
async function reviewCommand(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  signal: AbortSignal;
  skills?: SkillsFrom;
}) {
  const { home, folder, model, signal } = given;
  // Skelcrew's own CODEX_HOME, with its login shared out and a sessions folder to keep.
  const skelcrewCodexHome = codexHome(home);
  const login = shareLogin(home);
  const sessions = join(skelcrewCodexHome, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  // The reviewer gets a throwaway copy of it, with the real sessions and login mounted in.
  const copy = join(folder, "codex");
  const { mounts, at } = await throwawayMounts({
    source: skelcrewCodexHome,
    copy,
    signal,
    kept: ["sessions"],
  });
  mounts.push("--bind", sessions, sessions, "--bind", login, login);
  // A copy at another path can't have the real one mounted into it, so it links to it.
  if (at !== skelcrewCodexHome) symlinkSync(sessions, join(at, "sessions"));
  // --no-daemon belongs to codex itself, not to exec: without it Codex may start a
  // background server that outlives the review. The rest of exec's options follow the
  // setting that turns the branch's skills off.
  const options = ["--dangerously-bypass-approvals-and-sandbox"];
  // With none named, Codex runs on its own default.
  if (model) options.push("-m", model);
  options.push("--output-schema", join(folder, "schema.json"), "-o", join(folder, "answer.json"));
  options.push("-");
  const command = withSkillsOff(2, ["--no-daemon", "exec", ...options]);
  const skills = given.skills ? copySkills(given.skills, join(folder, "skills"), home) : [];
  return { command, mounts, env: { CODEX_HOME: at }, skills };
}

// Returns the reviewer's answer from the file Codex wrote it to, for the reviewer to check
// against the shape. Read only after Codex ends, so it can't change the file meanwhile.
function readAnswer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Returns the error a reviewer's codex exec ended on, or null when it printed none. Codex also
// prints what the commands it runs print, such as a test that logs "ERROR: rate limit", so only
// its own last line on stderr counts, when it holds "ERROR:". The echoed prompt doesn't end in
// a newline, so that "ERROR:" can follow the prompt's last sentence: what comes before it is
// never part of the error.
function reportedError(_out: string, err: string): string | null {
  const last = err.split("\n").findLast((line) => line.trim() !== "") ?? "";
  const marker = last.lastIndexOf("ERROR:");
  const plain = marker < 0 ? "" : last.slice(marker + "ERROR:".length).trim();
  return plain === "" ? null : plain;
}

// Returns whether Codex's error says its usage limit is reached, and when it resets, or null
// when it says something else. It says "You've hit your usage limit. ... try again at 1:59 PM.",
// with the day before the time when the reset isn't today. A rate limit with no time is a limit
// too: it passes on its own, so it is waited out.
function usageLimit(error: string, now: number): { reset: number | null } | null {
  if (!/usage limit|rate limit|too many requests/i.test(error)) return null;
  const again = /try again at (.*)/i.exec(error)?.[1];
  return { reset: again === undefined ? null : resetTime(again, now) };
}

// Returns the line where Codex's own input area starts on its screen, given as its lines with
// their colours, or null when it isn't found, such as after an update that redrew it. The area
// is a shaded box: a shaded blank line, its › prompt with what is typed under it, blank lines
// included, and a shaded blank line, then one or two indented footer lines in dim text, ending
// the screen.
// Earlier messages in the output are shaded and start with › too, but Codex's output after one
// starts with •. Anything else shows whole, as a wrong cut could hide the agent's output.
function inputStart(screen: string[]): number | null {
  const lines = screen.map((line) => Bun.stripANSI(line));
  const looks = styles(screen);
  const shaded = (at: number) => looks[at]?.shaded ?? false;
  const blank = (line: string | undefined) => line !== undefined && line.trim() === "";
  // A line of the box with nothing on it but its shade.
  const padding = (at: number) => blank(lines[at]) && shaded(at);
  const at = lines.findLastIndex((line) => line.startsWith("›"));
  if (at < 1 || !shaded(at) || !padding(at - 1)) return null;
  if (lines.slice(at + 1).some((line) => line.startsWith("•"))) return null;
  // The box goes on while its lines are shaded, through what is typed, blank lines in it
  // included, and ends with a shaded blank line.
  let end = at + 1;
  while (end < screen.length && shaded(end)) end++;
  if (end - 1 === at || !padding(end - 1)) return null;
  const footer = lines.flatMap((line, i) => (i >= end && !blank(line) ? [i] : []));
  const dim = footer.every((i) => lines[i]?.startsWith("  ") && looks[i]?.dim);
  return footer.length >= 1 && footer.length <= 2 && dim ? at - 1 : null;
}

// Returns how each line of a screen is styled: whether a background colour shows on it, as on
// Codex's input box, and whether all its text is dim, as its footer is. A style set on one line
// goes on over the lines after it until reset, as a terminal shows it, and tmux can capture a
// screen that way. Only what a line draws counts, spaces included, so a line that resets the
// background before drawing anything isn't shaded.
function styles(screen: string[]): { shaded: boolean; dim: boolean }[] {
  const esc = "\x1b";
  // The background and dimness set now, carried from line to line.
  let background = false;
  let dimNow = false;
  return screen.map((line) => {
    let shaded = false;
    let dim = true;
    for (const part of line.split(new RegExp(`(${esc}\\[[0-9;:]*m)`))) {
      const sgr = new RegExp(`^${esc}\\[([0-9;:]*)m$`).exec(part);
      if (!sgr) {
        // Text shown while dim is off makes the line not dim, spaces aside.
        if (part.trim() !== "" && !dimNow) dim = false;
        if (part !== "" && background) shaded = true;
        continue;
      }
      // A colour from a palette or in red, green and blue takes numbers of its own after 38, 48
      // or 58: with colons, such as 48:2::10:20:0, all in one parameter, and with semicolons,
      // such as 38;5;2, in the parameters after it, which are skipped. Neither is read as codes
      // of its own, so a 0 in a colour never resets.
      const parameters = (sgr[1] ?? "").split(";");
      for (let at = 0; at < parameters.length; at++) {
        const parameter = parameters[at] ?? "";
        const code = Number(parameter.split(":")[0] ?? "");
        if (code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107))
          background = true;
        if (code === 0 || code === 49) background = false;
        if (code === 2) dimNow = true;
        if (code === 0 || code === 22) dimNow = false;
        const extended = code === 38 || code === 48 || code === 58;
        if (extended && !parameter.includes(":")) at += parameters[at + 1] === "2" ? 4 : 2;
      }
    }
    return { shaded, dim };
  });
}

// Codex as Skelcrew knows it. While a turn runs it shows "esc to interrupt". Its empty input
// always shows "› Ask Codex to do anything", even mid-turn, so that whole line is its prompt:
// a line holding only › never shows. codex exec reads CODEX_API_KEY: given only
// OPENAI_API_KEY, it sent no key at all, so both get into the sandbox for those who use a key
// rather than a login. The first run looks for `program` and, when it is missing, prints the
// line that installs it.
export const codex = {
  name: "codex",
  title: "Codex",
  program: "codex",
  install: "npm install -g @openai/codex",
  marks: { busy: "esc to interrupt", prompt: "› Ask Codex to do anything" },
  keys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  start: startCommand,
  saved: savedConversation,
  conversation: conversationFile,
  progress: readProgress,
  inputStart,
  review: reviewCommand,
  answer: readAnswer,
  failure: reportedError,
  usageLimit,
} as const;
