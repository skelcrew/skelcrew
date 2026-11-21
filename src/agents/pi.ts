// How Pi runs inside the sandbox: as the lead or a builder, in a tmux session with an agent
// folder of its own, and as the reviewer, once per review, each on any provider's model.
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { copySkills, type SkillsFrom } from "../skills.ts";
import { editing, type Progress, stepText, toolWords } from "./progress.ts";
import { resetTime } from "./reset.ts";
import { everyRepository, filterEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

export const piHome = (home = homedir()) => join(dataDir(home), "pi");

const limitWords = /\b429\b|rate.?limit|usage limit|quota|too many requests/i;

const hooksExtension = `import { spawn } from "node:child_process";
import { CustomEditor } from "@earendil-works/pi-coding-agent";

const limit = new RegExp(${JSON.stringify(limitWords.source)}, "i");

const hook = (event, input, cwd) =>
  new Promise((resolve) => {
    const child = spawn("sc", ["hook", event], { cwd, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => child.kill(), 10000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.on("error", done);
    child.on("close", done);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(input));
  });

const said = (message) =>
  (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\\n")
    .trim();

class PromptEditor extends CustomEditor {
  setPaddingX() {
    super.setPaddingX(2);
  }
  render(width) {
    super.setPaddingX(2);
    const lines = super.render(width);
    if (lines.length > 2) lines[1] = "› " + lines[1].slice(2);
    return lines;
  }
}

export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWorkingMessage("esc to interrupt");
    ctx.ui.setEditorComponent((tui, theme, keys) => new PromptEditor(tui, theme, keys, { paddingX: 2 }));
  });
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") await hook("prompt", { prompt: event.text }, ctx.cwd);
    return { action: "continue" };
  });
  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) return hook("turn-interrupted", {}, ctx.cwd);
    const last = ctx.sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.message;
    if (last?.stopReason !== "error")
      return hook("turn-ended", { last_assistant_message: said(last) }, ctx.cwd);
    const details = last.errorMessage ?? "";
    const kind = limit.test(details) ? { error: "rate_limit" } : {};
    return hook("turn-failed", { ...kind, error_details: details, last_assistant_message: said(last) }, ctx.cwd);
  });
}
`;

const answerExtension = (
  schema: string,
  answer: string,
) => `import { writeFileSync } from "node:fs";

export default function (pi) {
  pi.registerTool({
    name: "answer_review",
    label: "Answer the review",
    description: "Give the review's answer. Call it once, as your last step.",
    promptSnippet: "Give the review's answer, as your last step",
    parameters: ${schema},
    async execute(_id, params) {
      writeFileSync(${JSON.stringify(answer)}, JSON.stringify(params), { flag: "wx" });
      return { content: [{ type: "text", text: "Answer saved." }], details: {}, terminate: true };
    },
  });
}
`;

const answerTold =
  "When your review is done, give your answer with the answer_review tool, once, as your last step.";

const settings = JSON.stringify({ quietStartup: true });

function refuseLinks(paths: string[]): void {
  for (const p of paths)
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so Skelcrew won't write through it`);
}

function makeAgentFolder(home: string, agent: string, extension: string): string {
  mkdirSync(agent, { recursive: true, mode: 0o700 });
  const write = (file: string, text: string | null) => {
    rmSync(join(agent, file), { force: true });
    if (text !== null) writeFileSync(join(agent, file), text, { mode: 0o600, flag: "wx" });
  };
  for (const file of ["auth.json", "models.json"]) {
    const yours = join(piHome(home), file);
    write(
      file,
      lstatSync(yours, { throwIfNoEntry: false })?.isFile() ? readFileSync(yours, "utf8") : null,
    );
  }
  write("settings.json", settings);
  write("skelcrew.js", extension);
  return join(agent, "skelcrew.js");
}

const lockedDown = ["-ne", "-ns", "-np", "--no-themes", "-na"];

const piEnv = (agent: string) => ({
  PI_CODING_AGENT_DIR: agent,
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
});

const sessionsOf = (name: string, home = homedir()) =>
  join(dataDir(home), "pi-sessions", name, "sessions");

function conversationFile(name: string, _folder: string, session: string): string | null {
  const folder = sessionsOf(name);
  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return null;
  const file = readdirSync(folder).find((entry) => entry.endsWith(`_${session}.jsonl`));
  return file === undefined ? null : join(folder, file);
}

const savedConversation = (name: string, folder: string, session: string): string | null =>
  conversationFile(name, folder, session) === null ? null : session;

const AnswerLine = z.object({
  type: z.literal("message"),
  message: z.object({
    role: z.literal("assistant"),
    usage: z
      .object({ input: z.number(), output: z.number(), cacheWrite: z.number().optional() })
      .optional(),
    content: z.array(z.unknown()).optional(),
  }),
});
const ToolCall = z.object({
  type: z.literal("toolCall"),
  name: z.string(),
  arguments: z.looseObject({}),
});

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
    if (usage) tokens = (tokens ?? 0) + usage.input + (usage.cacheWrite ?? 0) + usage.output;
    for (const part of content) {
      const call = ToolCall.safeParse(part);
      if (call.success) step = toolStep(call.data.name, call.data.arguments);
    }
  }
  return { ...before, step, tokens };
}

function toolStep(tool: string, given: Record<string, unknown>): string | null {
  const path = typeof given.path === "string" ? given.path : "";
  if (tool === "bash") return null;
  if ((tool === "edit" || tool === "write") && path) return editing(path);
  if (tool === "read" && path) return stepText(`Reading ${basename(path)}`);
  return toolWords(tool);
}

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
}): { argv: string[]; env: Record<string, string> } {
  const { name, socket, model, thread, folder, origin, repositories, prompt, system } = given;
  const { resume, sessionId, skills, files, env = process.env } = given;
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  const session = resume ?? sessionId;
  if (!session || !/^[a-zA-Z0-9]([\w.-]*[a-zA-Z0-9])?$/.test(session))
    throw new Error(`Pi needs a session ID of letters, digits, dots, dashes and underscores`);
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);

  const all = join(dataDir(home), "pi-sessions");
  const own = join(all, name);
  const agent = join(own, "agent");
  const conversations = sessionsOf(name, home);
  const instructions = join(own, "instructions.md");
  const skillsFolder = join(own, "skills");
  refuseLinks([all, own, agent, conversations, instructions, skillsFolder]);
  mkdirSync(conversations, { recursive: true, mode: 0o700 });
  const extension = makeAgentFolder(home, agent, hooksExtension);
  if (system) writeFileSync(instructions, system);
  if (skills) copySkills(skills, skillsFolder, home);

  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(own)];
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }
  if (repositories) mounts.push(...everyRepository(repositories));

  const command = ["pi", ...lockedDown, "-e", extension];
  if (skills) command.push("--skill", skillsFolder);
  command.push("--session-dir", conversations, "--session-id", session);
  if (model) command.push("--model", model);
  if (system) command.push("--append-system-prompt", instructions);
  if (prompt && !resume) command.push("--", prompt);

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
  return { argv, env: { ...filterEnv(env, pi.keys), ...piEnv(agent) } };
}

function reviewCommand(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  schema: string;
  skills?: SkillsFrom;
}) {
  const { home, folder, model, schema, skills } = given;
  const agent = join(folder, "pi");
  const extension = makeAgentFolder(
    home,
    agent,
    answerExtension(schema, join(folder, "answer.json")),
  );
  const command = ["pi", "-p", "--no-session", ...lockedDown, "-e", extension];
  if (skills) {
    copySkills(skills, join(folder, "skills"), home);
    command.push("--skill", join(folder, "skills"));
  }
  if (model) command.push("--model", model);
  command.push("--append-system-prompt", answerTold);
  return { command, mounts: [], env: piEnv(agent), skills: [] };
}

function readAnswer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

function reportedError(_out: string, err: string): string | null {
  const lines = err.split("\n").filter((line) => line.trim() !== "" && !/^Warning:/.test(line));
  return lines.join("\n").trim() || null;
}

function usageLimit(error: string, now: number): { reset: number | null } | null {
  if (!limitWords.test(error)) return null;
  const at = /(?:try again at|resets? (?:at )?)(.*)/i.exec(error)?.[1];
  return { reset: at === undefined ? null : resetTime(at, now) };
}

function inputStart(screen: string[]): number | null {
  const lines = screen.map((line) => Bun.stripANSI(line));
  const rule = (line: string) => /^─{3,}/.test(line.trim());
  const at = lines.findLastIndex((line) => line.startsWith("› ") || line === "›");
  if (at < 1 || !rule(lines[at - 1] ?? "")) return null;
  let end = at + 1;
  while (lines[end]?.startsWith("  ") && !rule(lines[end] ?? "")) end++;
  if (!rule(lines[end] ?? "")) return null;
  const footer = lines.slice(end + 1).filter((line) => line.trim() !== "");
  if (footer.length > 2 || footer.some(rule)) return null;
  return at - 1;
}

export const pi = {
  name: "pi",
  title: "Pi",
  program: "pi",
  install: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  marks: { busy: "esc to interrupt", prompt: "›" },
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
} as const;
