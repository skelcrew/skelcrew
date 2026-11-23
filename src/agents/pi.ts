// How Pi runs inside the sandbox: as the lead or a builder, in a tmux session with an agent
// folder of its own, and as the reviewer, once per review in print mode. Each gets its own copy
// of Skelcrew's login, and Skelcrew's extension, which tells Skelcrew what the agent is doing.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { copySkills, type SkillsFrom } from "../skills.ts";
import { dropLogin, launching, removingOnEnd, reviewLogin, sessionLogin } from "./login-copies.ts";
import extensionSource from "./pi-extension.ts" with { type: "text" };
import { copyPiLogin, hasPiLogin, renewPiLogin } from "./pi-login.ts";
import { editing, type Progress, toolWords } from "./progress.ts";
import { resetTime } from "./reset.ts";
import { everyRepository, filterEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

// The extension's source, which each session and review loads from a file of its own. Bun reads
// a file either as text or as a module, so its marks are repeated here, and a test pins them.
const extension = String(extensionSource);
const marks = { busy: "Skelcrew: working", prompt: "Skelcrew: ready" };
const startedWord = "started";

// What the reviewer is told of how to answer: Pi has no setting that holds an answer to a shape,
// so the extension's tool takes it, and Pi checks it against the shape.
const answerWith =
  "Give your answer with the skelcrew_answer tool, once, as your last step. Skelcrew reads only that.";

// Why a Pi agent can't start: no provider's key reaches it, so it runs only on Skelcrew's login.
const noLogin = "Skelcrew has no Pi login for agents yet: run sc to sign in to Pi";

// The folder of each session's own: Pi's agent folder, with its conversations in sessions/.
const sessionHome = (name: string, home = homedir()) => join(dataDir(home), "pi-sessions", name);

// Returns the file Pi saved a session's conversation in, or null while it saved none. Pi names it
// by the time and the ID, and saves it only once a message went in.
function conversationFile(name: string, _folder: string, session: string): string | null {
  const sessions = join(sessionHome(name), "sessions");
  if (!lstatSync(sessions, { throwIfNoEntry: false })?.isDirectory()) return null;
  const file = readdirSync(sessions).find((entry) => entry.endsWith(`_${session}.jsonl`));
  return file === undefined ? null : join(sessions, file);
}

// Returns the conversation a session saved, for --session-id to bring back, or null when it
// saved none. Skelcrew picks Pi's session ID, so it is `session` itself.
const savedConversation = (name: string, folder: string, session: string) =>
  conversationFile(name, folder, session) === null ? null : session;

// A line of a conversation file with a model's answer: its tokens and its parts, such as its
// text and tool calls.
const AnswerLine = z.object({
  type: z.literal("message"),
  message: z.object({
    role: z.literal("assistant"),
    usage: z
      .object({ input: z.number(), output: z.number(), cacheWrite: z.number().optional() })
      .optional(),
    content: z.array(z.unknown()),
  }),
});
const ToolCall = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
  arguments: z.looseObject({ path: z.unknown().optional() }),
});

// Adds what `lines` of a builder's conversation file say to its progress so far: its tokens and
// its latest step. Cache reads are left out of the tokens, as each answer reads the whole
// conversation again, and cache writes are counted, as for Claude Code. A command has no step,
// as for Codex: the command itself reads as noise in a row. Pi keeps no plan.
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
    const usage = answer.data.message.usage;
    if (usage) tokens = (tokens ?? 0) + usage.input + usage.output + (usage.cacheWrite ?? 0);
    for (const part of answer.data.message.content) {
      const call = ToolCall.safeParse(part);
      if (!call.success) continue;
      const { name, arguments: given } = call.data;
      if (name === "bash") step = null;
      else if ((name === "edit" || name === "write") && typeof given.path === "string")
        step = editing(given.path);
      else step = toolWords(name);
    }
  }
  return { step, tokens, plan: null, last: "" };
}

// Returns the line where Pi's own lines start at the bottom of its screen, or null when they
// aren't found, such as after an update that redrew them: the extension's line, then a rule,
// what is typed, a rule, and at most three lines of Pi's footer, ending the screen. Pi draws its
// busy spinner into the first rule.
function inputStart(screen: string[]): number | null {
  const lines = screen.map((line) => Bun.stripANSI(line).trimEnd());
  const own = (line: string) =>
    line === marks.prompt || line === "Skelcrew: typed" || /^Skelcrew: working \d+s$/.test(line);
  const rule = (line: string | undefined) => /^─{2}.*─{3,}$/.test(line ?? "");
  const at = lines.findLastIndex(own);
  if (at < 0 || !rule(lines[at + 1])) return null;
  let end = at + 2;
  while (end < lines.length && !rule(lines[end])) end++;
  if (end >= lines.length) return null;
  const footer = lines.slice(end + 1).filter((line) => line !== "");
  return footer.length <= 3 && !footer.some((line) => rule(line) || own(line)) ? at : null;
}

// Writes Skelcrew's extension, and the instructions when given, into a session's own folder, and
// returns the extension's file. Skelcrew writes here with your rights, and the agent can change
// what is in its folder. A link it left would send that write to any file of yours.
function writeOwnFiles(folder: string, system?: string): string {
  const file = join(folder, "skelcrew.ts");
  const instructions = join(folder, "instructions.md");
  for (const p of [folder, file, instructions])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so Skelcrew won't write through it`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(file, extension);
  if (system !== undefined) writeFileSync(instructions, system);
  return file;
}

// Prepares a session's own agent folder and returns its sandbox command and environment, and
// launch, which writes its copy of the login, then starts the session with what it is given,
// for the lead or a builder. --session-id both starts a conversation and brings one back, with
// the first message in `prompt` for a new one. A builder, given its thread's clone, works there;
// a lead works in its own `folder`. Each sees nothing else but `origin`, Skelcrew's clone of its
// repository, read-only, its own copy of the login, and for a lead `repositories`, the folder of
// every repository's clone, read-only. `files` is the placeholder of its dropped files, on a
// host that hands it some. --no-approve keeps the folder's own .pi/ and .agents/skills/ out, as
// Pi would otherwise ask whether to trust them, with nobody there to answer. The repository's
// skills you approved go into the agent folder's skills/, where Pi finds them.
function startCommand(given: {
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
}) {
  const { name, socket, model, thread, folder, origin, repositories, prompt, system } = given;
  const { resume, sessionId, skills, files } = given;
  const env = given.env ?? process.env;
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);
  const session = resume ?? sessionId;
  if (session === undefined) throw new Error(`Skelcrew has no session ID for ${name}`);

  const agentFolder = sessionHome(name, home);
  const extensionFile = writeOwnFiles(agentFolder, system);
  if (skills) copySkills(skills, join(agentFolder, "skills"), home);
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(agentFolder)];
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }
  if (repositories) mounts.push(...everyRepository(repositories));

  const command = ["pi", "--no-approve", "-e", extensionFile];
  command.push("--session-dir", join(agentFolder, "sessions"), "--session-id", session);
  if (model) command.push("--model", model);
  if (system !== undefined)
    command.push("--append-system-prompt", join(agentFolder, "instructions.md"));
  if (prompt) command.push("--", prompt);

  // Only the environment a shell needs, and no provider's key: the daemon's service gets only
  // PATH, so the login is what agents run on.
  const kept = filterEnv(env);
  kept.PI_CODING_AGENT_DIR = agentFolder;
  kept.PI_SKIP_VERSION_CHECK = "1";
  const link = join(agentFolder, "auth.json");
  rmSync(link, { recursive: true, force: true });
  if (!hasPiLogin(home)) throw new Error(noLogin);
  const login = sessionLogin(home, "pi", name);
  mounts.push(...rw(login));
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts,
    socket,
    cwd,
    command,
    programs: [...pi.programs],
    normalPriority: !thread,
    files,
  });
  const launch = launching({
    home,
    harness: "pi",
    title: "Pi",
    name,
    login,
    link,
    copy: (into) => copyPiLogin(home, into),
  });
  return { argv: removingOnEnd(login, argv), env: kept, launch };
}

// The mark each review's extension prints its start and its error after, by the review's folder.
const reviewMarks = new Map<string, string>();

// Returns Pi's review command, mounts and environment, and the review's copy of the login, to
// remove once the review ends. Pi runs once in print mode, reading the prompt on stdin, with an
// agent folder of the review's own in the review's folder, where the repository's skills go and
// where Pi finds them. Its extension takes the answer with a tool whose parameters are the shape.
async function reviewCommand(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  skills?: SkillsFrom;
}) {
  const { home, folder, model, skills } = given;
  for (const old of reviewMarks.keys()) if (!existsSync(old)) reviewMarks.delete(old);
  const mark = `skelcrew-${crypto.randomUUID()}`;
  reviewMarks.set(folder, mark);
  const agentFolder = join(folder, "pi");
  const extensionFile = writeOwnFiles(agentFolder);
  if (skills) copySkills(skills, join(agentFolder, "skills"), home);
  const command = ["pi", "-p", "--no-approve", "--no-session", "-e", extensionFile];
  if (model) command.push("--model", model);
  command.push("--append-system-prompt", answerWith);
  const env = {
    PI_CODING_AGENT_DIR: agentFolder,
    PI_SKIP_VERSION_CHECK: "1",
    SKELCREW_PI_MARK: mark,
    SKELCREW_PI_REVIEW: folder,
  };
  const login = reviewLogin(home, "pi");
  const mounts: string[] = [];
  try {
    if (!(await copyPiLogin(home, login))) throw new Error(noLogin);
    symlinkSync(join(login, "auth.json"), join(agentFolder, "auth.json"));
    mounts.push(...rw(login));
  } catch (error) {
    dropLogin(login);
    throw error;
  }
  return { command, mounts, env, skills: [], login };
}

// Returns the reviewer's answer from the file the extension's tool wrote it to, for the reviewer
// to check against the shape. Read only after Pi ends, so it can't change the file meanwhile.
function readAnswer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Returns the error a reviewer's pi ended on, from the extension's line after the review's mark,
// or null when it printed none. A command in the review can print a line like Pi's own error,
// but never the mark. Pi can fail before the extension says it started, such as on a model it
// doesn't know, and then the review failed to start. Pi's own words never count: a provider's
// error text can echo a key.
function reportedError(_out: string, err: string, folder: string): string | null {
  const mark = reviewMarks.get(folder);
  if (mark === undefined) return null;
  const said = err
    .split("\n")
    .filter((line) => line.startsWith(`${mark} `))
    .map((line) => line.slice(mark.length + 1).trim());
  if (!said.includes(startedWord)) return "Pi stopped before the review started";
  return said.findLast((words) => words !== startedWord) ?? null;
}

// Returns whether the extension's words say a usage limit is reached, and when it resets, or
// null when they say something else.
function usageLimit(error: string, now: number): { reset: number | null } | null {
  if (!error.startsWith("usage limit reached")) return null;
  const resets = /resets at (.*)/.exec(error)?.[1];
  return { reset: resets === undefined ? null : resetTime(resets, now) };
}

// Pi as Skelcrew knows it, through the line its extension draws above Pi's input: a busy line
// counting seconds while Pi works, and a ready line once it is idle with nothing typed. Pi gets
// no provider's key variable: the daemon's service never has one, so agents run on the login sc
// install saves, and none starts without it. What Pi prints can hold a provider's error text,
// which can echo a key, so a review's failure is read only from the extension's words. The first
// run looks for `program` and, when it is missing, prints the line that installs it. Pi needs
// Node 22.19 or newer, which the sandbox shows it with `programs`, wherever it is installed.
export const pi = {
  name: "pi",
  title: "Pi",
  program: "pi",
  programs: ["pi", "node"],
  install: "npm install -g @earendil-works/pi-coding-agent@1.6.0",
  marks,
  keys: [],
  start: startCommand,
  saved: savedConversation,
  conversation: conversationFile,
  progress: readProgress,
  inputStart,
  review: reviewCommand,
  answer: readAnswer,
  failure: reportedError,
  usageLimit,
  renewLogin: renewPiLogin,
  outputMayHoldKeys: true,
} as const;
