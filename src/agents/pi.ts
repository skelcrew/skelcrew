// How Pi runs inside the sandbox: as the lead or a builder, in a tmux session with an agent folder
// of its own, and as the reviewer, once per review. All of them share Skelcrew's own Pi login, and
// load Skelcrew's extension, which runs the hooks and draws the marks Skelcrew reads.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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
import extension from "./pi-extension.ts" with { type: "text" };
import { editing, type Progress, toolWords } from "./progress.ts";
import { resetTime } from "./reset.ts";
import { everyRepository, filterEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

// The extension's own source, which Bun reads as text, to write where Pi loads it from. Bun can't
// also load it as a module, so what Skelcrew reads of it is repeated here, as its tests pin down:
// the marks it draws, the name of the reviewer's tool, and what counts as a usage limit.
const extensionSource = String(extension);
const readyMark = "◇ Pi is ready for a message";
const busyMark = "◆ Pi is at work";
const verdictTool = "skelcrew_verdict";
const isUsageLimit = (error: string) =>
  /^429(\D|$)/.test(error.trim()) || /exceeded[^.]*quota/i.test(error);

// Returns Skelcrew's own Pi agent folder, where the first run's pi auth login saves the login, and
// where you put a models.json for every agent: apart from yours in ~/.pi, so neither side's
// renewal or logout touches the other. No agent ever sees it. A caller that was handed an
// environment passes its HOME, as for dataDir.
export const piHome = (home = homedir()) => join(dataDir(home), "pi");

// The folder that holds Skelcrew's Pi login, auth.json alone, which every Pi sandbox gets writable.
const loginFolder = (home: string) => join(dataDir(home), "pi-login");

// Links auth.json in `folder`, an agent folder, to Skelcrew's shared login: Skelcrew's own folder
// unless another is named. Returns the login folder. Pi writes auth.json in place, through the
// link, and locks it with a folder beside the file the link leads to, so sessions renew it in
// turn, and no session keeps a copy of your key.
function shareLogin(home: string, folder = piHome(home)): string {
  const login = loginFolder(home);
  const shared = join(login, "auth.json");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  mkdirSync(login, { recursive: true, mode: 0o700 });
  // An agent can write in the login folder. A link it left there would send pi auth login's
  // write, run with your rights, to any file of yours.
  if (lstatSync(shared, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(shared);
  const at = join(folder, "auth.json");
  const found = lstatSync(at, { throwIfNoEntry: false });
  if (found?.isSymbolicLink() && readlinkSync(at) === shared) return login;
  // The first run's login writes a plain auth.json in Skelcrew's own folder. Anywhere else the
  // agent can write what is there, so it is never taken for Skelcrew's login.
  if (found?.isFile() && folder === piHome(home)) renameSync(at, shared);
  else rmSync(at, { recursive: true, force: true });
  symlinkSync(shared, at);
  return login;
}

// Reports whether Pi's agents have a login: a provider saved in Skelcrew's Pi login, or one of
// the API keys Pi reads in `env`. Only the file is read, never a link or a pipe an agent left,
// and no pi runs: an agent could put a command in auth.json for Pi to run as a key.
export function piLoggedIn(home: string, env: Record<string, string | undefined>): boolean {
  if (pi.keys.some((key) => env[key])) return true;
  for (const file of [join(loginFolder(home), "auth.json"), join(piHome(home), "auth.json")]) {
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    try {
      const saved = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, "utf8")));
      if (Object.keys(saved).length > 0) return true;
    } catch {}
  }
  return false;
}

// Readies Skelcrew's own Pi folder for pi auth login, outside the sandbox, so the login lands in
// the shared login folder. Returns the folder.
export function readyLogin(home = homedir()): string {
  shareLogin(home);
  return piHome(home);
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
// of its repository, read-only, the login every Pi session shares, and for a lead `repositories`,
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
  // Skelcrew's own folder first, so a login the first run just saved there moves to the shared
  // folder before this session links to it.
  shareLogin(home);
  const login = shareLogin(home, agentFolder);
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(agentFolder), ...rw(login)];
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
  const kept = filterEnv(env, pi.keys);
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
// review's own folder, which goes with it, linked to the shared login, with the repository's
// skills in its skills/, so none are left for the prompt to list. Skelcrew's extension gives the
// reviewer its verdict tool, which writes the answer, held to the shape in the review's folder.
function reviewCommand(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  skills?: SkillsFrom;
}) {
  const { home, folder, model } = given;
  const agentFolder = join(folder, "pi");
  const loaded = join(agentFolder, "skelcrew.ts");
  shareLogin(home);
  const login = shareLogin(home, agentFolder);
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
  };
  return { command, mounts: rw(login), env, skills: [] };
}

// Returns the reviewer's answer from the file its verdict tool wrote, for the reviewer to check
// against the shape. Read only after Pi ends, so it can't change the file meanwhile.
function readAnswer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// The start of the line Skelcrew's extension prints on stderr when a review's turn ends on an
// error, with Pi's error after it.
const failedLine = "skelcrew: Pi failed: ";

// Returns the error a reviewer's pi ended on, or null when it printed none. Pi prints other lines
// on stderr too, such as warnings, so only the line Skelcrew's extension printed counts.
function reportedError(_out: string, err: string): string | null {
  const line = err.split("\n").findLast((text) => text.startsWith(failedLine));
  const said = line?.slice(failedLine.length).trim() ?? "";
  return said === "" ? null : said;
}

// Returns whether Pi's error says a usage limit is reached, and when it resets, or null when it
// says something else. Only a 429 Pi puts first, or a quota exceeded, is a limit. The reset comes only from
// "resets at" or "try again at", as other words with "reset" in them name no time. A limit with
// no time passes on its own, so it is waited out.
function usageLimit(error: string, now: number): { reset: number | null } | null {
  if (!isUsageLimit(error)) return null;
  const at = /(?:resets at|try again at) (.*)/i.exec(error)?.[1];
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
// error the extension printed, as any other line Pi printed may be a command's. `keys` are the API key variables
// of the providers Pi reads from the environment, let into the sandbox for those who use a key
// rather than a login. Copilot's is a GitHub token, which no agent may see, so it stays out. The
// first run looks for `program` and, when it is missing, prints the line that installs it: the
// version Skelcrew was tested with, which needs Node 22.19 or newer.
export const pi = {
  name: "pi",
  title: "Pi",
  program: "pi",
  install: "npm install -g @earendil-works/pi-coding-agent@1.6.0",
  marks: { busy: busyMark, prompt: readyMark },
  keys: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANT_LING_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_CLOUD_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "OPENCODE_API_KEY",
    "RADIUS_API_KEY",
    "HF_TOKEN",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "BASETEN_API_KEY",
    "KIMI_API_KEY",
    "META_API_KEY",
    "MINIMAX_API_KEY",
    "MINIMAX_CN_API_KEY",
    "MOONSHOT_API_KEY",
    "XIAOMI_API_KEY",
  ],
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
