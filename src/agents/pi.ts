// How Pi runs inside the sandbox: as the lead or a builder, in a tmux session with an agent folder
// of its own, and as the reviewer, once per review. Each gets its own copy of Skelcrew's Pi login,
// and loads Skelcrew's extension, which runs the hooks and draws the marks Skelcrew reads.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { copySkills, type SkillsFrom } from "../skills.ts";
import extension from "./pi-extension.ts" with { type: "text" };
import { editing, type Progress, toolWords } from "./progress.ts";
import { resetTime } from "./reset.ts";
import { everyRepository, filterEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

// The extension's own source, which Bun reads as text, to write where Pi loads it from. Bun can't
// also load it as a module, so what Skelcrew reads of it is repeated here, as its tests pin down:
// the marks it draws, the name of the reviewer's tool, and the words a usage limit's message
// starts with.
const extensionSource = String(extension);
const readyMark = "◇ Pi is ready for a message";
const busyMark = "◆ Pi is at work";
const verdictTool = "skelcrew_verdict";
const limitWords = "rate limited";

// Returns Skelcrew's own Pi agent folder, where your pi auth login saves Skelcrew's login, and
// where you put a models.json for every agent: apart from yours in ~/.pi, so neither side's
// renewal or logout touches the other. No sandbox ever sees it, so no agent can change what
// another reads. A caller that was handed an environment passes its HOME, as for dataDir.
export const piHome = (home = homedir()) => join(dataDir(home), "pi");

// Skelcrew's Pi login, as auth.json holds it: a sign-in or a key for each provider.
const Logins = z.record(z.string(), z.record(z.string(), z.unknown()));
// A sign-in, which Pi renews with its refresh token before its access token expires.
const SignIn = z.looseObject({ type: z.literal("oauth"), expires: z.number() });

// Returns Skelcrew's Pi login, or none when there is none or it can't be read. Only a file
// counts, never a link or a pipe.
function savedLogins(home: string): Record<string, Record<string, unknown>> {
  const file = join(piHome(home), "auth.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return {};
  try {
    return Logins.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

// Reports whether Pi's agents have a login: a provider saved in Skelcrew's Pi login, or a
// provider of your own in Skelcrew's models.json, such as a model you run yourself. A key in your
// shell doesn't count: the daemon's service gets only PATH, so its agents would never see it.
// No pi runs, as one would run a key that is a command.
export function piLoggedIn(home: string): boolean {
  if (Object.keys(savedLogins(home)).length > 0) return true;
  const models = join(piHome(home), "models.json");
  if (!lstatSync(models, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    const read = z.object({ providers: z.record(z.string(), z.unknown()) });
    return Object.keys(read.parse(JSON.parse(readFileSync(models, "utf8"))).providers).length > 0;
  } catch {
    return false;
  }
}

// Readies Skelcrew's own Pi folder for pi auth login, outside the sandbox, and returns it.
export function readyLogin(home = homedir()): string {
  mkdirSync(piHome(home), { recursive: true, mode: 0o700 });
  return piHome(home);
}

// How long a sign-in must still last as an agent starts, or Skelcrew renews it first.
const signInLasts = "24h";

// Renews each sign-in of Skelcrew's login that expires within a day, outside the sandbox, with
// pi on `path`, which saves the renewal in Skelcrew's login. A renewal that fails leaves the
// sign-in as it was, and the agent says it expired. What pi prints is never read, as it holds
// the token.
async function renewLogin(home: string, path: string): Promise<void> {
  const soon = Date.now() + 24 * 60 * 60 * 1000;
  for (const [provider, login] of Object.entries(savedLogins(home))) {
    const signIn = SignIn.safeParse(login);
    if (!signIn.success || signIn.data.expires > soon) continue;
    try {
      const command = ["pi", "auth", "print-bearer-token", "--provider", provider];
      const renewal = Bun.spawn([...command, "--min-expiry", signInLasts], {
        env: {
          HOME: home,
          PATH: path,
          PI_CODING_AGENT_DIR: piHome(home),
          PI_SKIP_VERSION_CHECK: "1",
        },
        cwd: piHome(home),
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 30_000,
      });
      await renewal.exited;
    } catch {}
  }
}

// Gives an agent folder its own copy of Skelcrew's login, written anew each start, so an agent
// that changed its copy never changes another's, nor keeps its change. A sign-in goes without
// its refresh token: a renewal rotates that token, which would end the sign-in for Skelcrew's
// login and every other copy. Skelcrew renews it instead, as the agent starts. Whatever the agent
// left there goes first, a link too, so the write never goes through one.
function copyLogin(home: string, agentFolder: string): void {
  const copy = join(agentFolder, "auth.json");
  rmSync(copy, { recursive: true, force: true });
  const logins = savedLogins(home);
  if (Object.keys(logins).length === 0) return;
  const copied = Object.fromEntries(
    Object.entries(logins).map(([provider, login]) => [
      provider,
      SignIn.safeParse(login).success ? { ...login, refresh: "" } : login,
    ]),
  );
  writeFileSync(copy, JSON.stringify(copied), { mode: 0o600, flag: "wx" });
}

// Removes the copy of Skelcrew's login that the session `name` got, once Skelcrew ends it, so no
// key stays behind in a folder kept for its conversation.
export function removeLoginCopy(name: string, home = homedir()): void {
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) return;
  rmSync(join(dataDir(home), "pi-sessions", name, "auth.json"), { recursive: true, force: true });
}

// Gives an agent folder Skelcrew's own models.json, where you add providers Pi doesn't have, such
// as a model you run yourself, or takes away a copy left from before. Written anew each start, so
// an agent's change to its copy never lasts. Whatever the agent left there goes first, a link
// too, so the write never goes through one.
function copyModels(home: string, agentFolder: string): void {
  const models = join(piHome(home), "models.json");
  const copy = join(agentFolder, "models.json");
  rmSync(copy, { force: true });
  if (lstatSync(models, { throwIfNoEntry: false })?.isFile())
    writeFileSync(copy, readFileSync(models), { mode: 0o600 });
}

// Returns the file a session saved its conversation in, or null when it saved none. Pi names it by
// the time it started and the session's ID, in the session's own sessions folder, and saves it
// only once a message went in. A link or a folder the agent left there is never taken for it.
function conversationFile(name: string, _folder: string, session: string): string | null {
  const folder = join(dataDir(), "pi-sessions", name, "sessions");
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return null;
  const file = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && entry.name.endsWith(`_${session}.jsonl`),
  );
  return file ? join(folder, file.name) : null;
}

// Returns the conversation a session saved, for --session-id to bring back, or null when it saved
// none. Skelcrew picks Pi's session ID, so the ID to bring back is `session` itself.
function savedConversation(name: string, folder: string, session: string): string | null {
  return conversationFile(name, folder, session) ? session : null;
}

// A line of a conversation file with a model's answer: its tokens and its parts, such as its text
// and tool calls. Pi writes each answer once.
const AnswerLine = z.object({
  type: z.literal("message"),
  message: z.object({
    role: z.literal("assistant"),
    usage: z.object({ input: z.number(), output: z.number(), cacheWrite: z.number() }).optional(),
    content: z.array(z.unknown()).optional(),
  }),
});
// A tool call within an answer, with what the tool was given.
const ToolCall = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
  arguments: z.looseObject({ path: z.string().optional() }),
});

// Adds what `lines` of a builder's conversation file say to its progress so far: its tokens and
// its latest step. Cache reads are left out of the tokens, as each answer reads the whole
// conversation again. A change to a file is the step, and so is any other tool but bash, by its
// name: Pi gives a command no description, and the command itself reads as noise in a row. Pi has
// no plan tool.
function readProgress(lines: string[], before: Progress): Progress {
  let { step, tokens } = before;
  for (const line of lines) {
    if (!line.includes('"assistant"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const answer = AnswerLine.safeParse(parsed);
    if (!answer.success) continue;
    const { usage, content = [] } = answer.data.message;
    if (usage) tokens = (tokens ?? 0) + usage.input + usage.cacheWrite + usage.output;
    for (const part of content) {
      const call = ToolCall.safeParse(part);
      if (!call.success) continue;
      const { name, arguments: given } = call.data;
      if (name === "bash") step = null;
      else if ((name === "edit" || name === "write") && given.path) step = editing(given.path);
      else step = toolWords(name);
    }
  }
  return { step, tokens, plan: null, last: "" };
}

// Prepares a session's own agent folder and returns its sandbox command and environment, for the
// lead or a builder. It starts afresh with the first message in `prompt` under `sessionId`, or
// brings back the conversation saved under `resume`. A builder, given its thread's clone, works
// there; a lead works in its own `folder`. Each sees nothing else but `origin`, Skelcrew's clone
// of its repository, read-only, and for a lead `repositories`,
// the folder of every repository's clone, read-only. `files` is the placeholder of its dropped
// files, on a host that hands it some.
//
// Pi loads only Skelcrew's extension, and nothing of the folder's own .pi or .agents/skills:
// those wait for a person to trust the folder, which nobody is there to do. The repository's
// skills you approved, from the .agents/ `skills` names, go into the agent folder's skills/.
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
  files?: string | undefined;
  env?: Record<string, string | undefined>;
}): Promise<{ argv: string[]; env: Record<string, string> }> {
  const { name, socket, model, thread, folder, origin, repositories, prompt, system } = given;
  const { resume, sessionId, skills, files } = given;
  const env = given.env ?? process.env;
  // Refuse what would start the wrong agent or write outside Skelcrew's folders.
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  const session = resume ?? sessionId;
  if (!session || !/^[a-zA-Z0-9][\w.-]*[a-zA-Z0-9]$/.test(session))
    throw new Error(`Pi needs a session ID of letters, digits, dots and dashes, not "${session}"`);
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  // The name becomes a folder, so it must not climb out of Skelcrew's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);

  // A folder of its own per session, never your ~/.pi: an agent could write settings or an
  // extension that another session loads. It stays, so the conversation can be brought back.
  const sessions = join(dataDir(home), "pi-sessions");
  const agentFolder = join(sessions, name);
  const instructions = join(agentFolder, "instructions.md");
  const loaded = join(agentFolder, "skelcrew.ts");
  // Skelcrew writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [sessions, agentFolder, instructions, loaded])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so Skelcrew won't write through it`);
  mkdirSync(agentFolder, { recursive: true, mode: 0o700 });
  // Written anew each start, so an agent that changed it never keeps its hooks off.
  writeFileSync(loaded, extensionSource);
  copyModels(home, agentFolder);
  // The instructions go in a file, not on the command line: tmux refuses a start command past
  // about 16 KB, and the lead's instructions came close.
  if (system) writeFileSync(instructions, system);
  if (skills) copySkills(skills, join(agentFolder, "skills"), home);
  await renewLogin(home, env.PATH ?? "");
  copyLogin(home, agentFolder);
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(agentFolder)];
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }
  if (repositories) mounts.push(...everyRepository(repositories));

  const command = ["pi", "--no-extensions", "--extension", loaded, "--no-approve"];
  command.push("--session-dir", join(agentFolder, "sessions"), "--session-id", session);
  if (system) command.push("--append-system-prompt", instructions);
  // provider/model, as Pi names it. With none named, Pi picks its own default for the first
  // provider it has a login for.
  if (model) command.push("--model", model);
  // After --, so a message that starts with - is never taken for an option.
  if (!resume && prompt) command.push("--", prompt);

  // Only the environment the agent needs, plus its own agent folder. Pi's update check only fails
  // in the sandbox, as its install folder is read-only there.
  const kept = filterEnv(env);
  kept.PI_CODING_AGENT_DIR = agentFolder;
  kept.PI_SKIP_VERSION_CHECK = "1";
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts,
    socket,
    cwd,
    command,
    normalPriority: !thread,
    files,
  });
  return { argv, env: kept };
}

// What the reviewer is told besides its role, so its answer reaches Skelcrew.
const verdictNote = `Give your verdict by calling the ${verdictTool} tool once, at the end. Skelcrew reads your verdict only from it.`;

// Returns Pi's review command, mounts and environment. The command reads the review's prompt on
// stdin, runs once in print mode and saves no conversation. Pi gets an agent folder in the
// review's own folder, which goes with it, with its own copy of the login and the repository's
// skills in its skills/, so none are left for the prompt to list. Skelcrew's extension gives the
// reviewer its verdict tool, which writes the answer, held to the shape in the review's folder.
async function reviewCommand(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  skills?: SkillsFrom;
}) {
  const { home, folder, model } = given;
  const agentFolder = join(folder, "pi");
  const loaded = join(agentFolder, "skelcrew.ts");
  mkdirSync(agentFolder, { recursive: true, mode: 0o700 });
  await renewLogin(home, process.env.PATH ?? "");
  copyLogin(home, agentFolder);
  writeFileSync(loaded, extensionSource);
  copyModels(home, agentFolder);
  if (given.skills) copySkills(given.skills, join(agentFolder, "skills"), home);
  const command = ["pi", "--no-extensions", "--extension", loaded, "--no-approve", "--no-session"];
  command.push("--print", "--append-system-prompt", verdictNote);
  if (model) command.push("--model", model);
  const env = {
    PI_CODING_AGENT_DIR: agentFolder,
    PI_SKIP_VERSION_CHECK: "1",
    SKELCREW_PI_REVIEW: folder,
    SKELCREW_PI_ERROR_MARK: errorMark(folder),
  };
  const mounts: string[] = [];
  return { command, mounts, env, skills: [] };
}

// Returns the reviewer's answer from the file its verdict tool wrote, for the reviewer to check
// against the shape. Read only after Pi ends, so it can't change the file meanwhile.
function readAnswer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// A secret of this run of Skelcrew's, which each review's mark is made from.
const markSecret = crypto.randomUUID();

// Returns the mark of the review in `folder`, which Skelcrew's extension puts in the line it prints
// with Pi's error. The extension takes it out of the environment as it loads, before any command
// runs, so a command's output can't print the line.
const errorMark = (folder: string) =>
  new Bun.CryptoHasher("sha256").update(`${markSecret}:${folder}`).digest("hex");

// Returns the error the reviewer's pi in `folder` ended on, or null when it printed none: the
// message of Skelcrew's own that the extension puts on stderr with the review's mark, never the
// words of Pi or its provider, which can hold a key. Pi can fail before its extension says it is
// at work, such as on a model it doesn't know. It prints why then, so a stderr with something on
// it, and no line saying Pi is at work, gets Skelcrew's own words for a failed start. Once Pi is at
// work, a command it runs can print anything, so only the marked line counts.
function reportedError(_out: string, err: string, folder: string): string | null {
  const lines = err.split("\n").map((line) => line.trim());
  const failed = `skelcrew: Pi failed ${errorMark(folder)}: `;
  const marked = lines
    .findLast((line) => line.startsWith(failed))
    ?.slice(failed.length)
    .trim();
  if (marked) return marked;
  if (lines.includes(`skelcrew: Pi at work ${errorMark(folder)}`)) return null;
  if (lines.every((line) => line === "")) return null;
  return "Pi failed to start, such as on a model it doesn't know: run pi by hand to see why";
}

// Returns whether the extension's message says a usage limit is reached, and when it resets, or
// null when it says something else. The message is Skelcrew's own, such as "rate limited (429),
// resets at 3:15 PM" or "rate limited by ChatGPT's usage limit, resets in ~42 min", read as it
// comes. A limit with no time passes on its own, so it is waited out.
function usageLimit(error: string, now: number): { reset: number | null } | null {
  if (!error.startsWith(limitWords)) return null;
  const minutes = /, resets in ~(\d+) min$/.exec(error)?.[1];
  if (minutes !== undefined) return { reset: now + Number(minutes) * 60_000 };
  const at = /, resets at (.+)$/.exec(error)?.[1];
  return { reset: at === undefined ? null : resetTime(at, now) };
}

// Returns the line where Pi's own lines start at the bottom of its screen, given as its lines with
// their colours, or null when its input area isn't found, such as after an update that redrew it.
// The input area is a rule, what is typed, a closing rule, and a footer of one to three lines,
// ending the screen. The rule on top shows Pi's own busy line while a turn runs. Above it is the
// line Skelcrew's extension draws: its ready mark goes with the input area, and its busy line
// stays, as it shows the agent at work. Anything else may be the agent's output, so it stays.
function inputStart(screen: string[]): number | null {
  const lines = screen.map((line) => Bun.stripANSI(line).trimEnd());
  const rule = (line: string | undefined) => line !== undefined && /^─{3,}$/.test(line);
  const top = (line: string | undefined) => line !== undefined && /^──.*─{3,}$/.test(line);
  const end = lines.findLastIndex((line) => line.trim() !== "");
  const bottom = lines.slice(0, end).findLastIndex(rule);
  if (bottom < 1 || end - bottom > 3) return null;
  const start = lines.slice(0, bottom).findLastIndex(top);
  if (start < 0) return null;
  return lines[start - 1]?.trim() === readyMark ? start - 1 : start;
}

// Pi as Skelcrew knows it, with the marks its extension draws: one line while a turn runs, which
// counts seconds, and another while Pi waits with nothing typed. A failed review says only the
// error reportedError finds, never a line that may be a command's. `keys` is empty: the daemon's
// service gets only PATH, so a provider's key in your shell would never reach an agent, and
// Pi's agents use Skelcrew's Pi login instead. The first run looks for `program` and, when it is
// missing, prints the line that installs it: the version Skelcrew was tested with, which needs
// Node 22.19 or newer.
export const pi = {
  name: "pi",
  title: "Pi",
  program: "pi",
  install: "npm install -g @earendil-works/pi-coding-agent@1.6.0",
  marks: { busy: busyMark, prompt: readyMark },
  keys: [],
  start: startCommand,
  saved: savedConversation,
  conversation: conversationFile,
  progress: readProgress,
  inputStart,
  review: reviewCommand,
  answer: readAnswer,
  failure: reportedError,
  guessesErrors: false,
  usageLimit,
} as const;
