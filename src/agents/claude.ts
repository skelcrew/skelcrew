// How Claude Code starts inside the sandbox: its settings, its config folder, its login and
// the command that runs it for the lead or a builder.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { claudeTokenFile, dataDir } from "../paths.ts";
import { keptEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

const { O_NONBLOCK, O_NOFOLLOW, O_RDONLY } = constants;

// The part of a session's .claude.json Skelcrew changes. The rest is kept as it was.
const ClaudeJson = z.looseObject({
  projects: z.record(z.string(), z.looseObject({})).optional(),
});

// Bypass mode shows a warning first, which nobody is there to accept. Claude Code's own
// sandbox fails inside Skelcrew's, so it stays off even if your settings turn it on.
const base = { skipDangerousModePermissionPrompt: true, sandbox: { enabled: false } };
const settings = JSON.stringify(base);

// A builder's AskUserQuestion waits on a screen nobody watches, so Claude Code's hooks tell
// Skelcrew when the builder asks, and the thread needs you until the question is over. Answering
// runs PostToolUse, but setting it aside with Esc or "Chat about this" runs no hook at all, so
// whatever is typed into the builder next also ends it. The commands answer at once, and
// print nothing, since UserPromptSubmit adds what a hook prints to the message.
const asked = { type: "command", command: "sc question asked", timeout: 10 };
const answered = { ...asked, command: "sc question answered" };
const builderSettings = JSON.stringify({
  ...base,
  hooks: {
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: [asked] }],
    PostToolUse: [{ matcher: "AskUserQuestion", hooks: [answered] }],
    UserPromptSubmit: [{ hooks: [answered] }],
  },
});

// A saved login token: any text but blank, without the newline a paste leaves.
const Token = z.string().trim().min(1);

// The model an agent runs on when your config names none.
const defaultModel = "opus";

// Returns the Claude Code login token Skelcrew saved for agents, which the lead, builders and
// reviewers all log in with. Throws if setup hasn't saved one. A token from claude setup-token
// never renews. A shared login would: renewing makes the old refresh token stop working, so
// your own login or the agent's would go stale.
function claudeToken(home: string): string {
  const tokenFile = claudeTokenFile(home);
  if (!existsSync(tokenFile))
    throw new Error("Claude Code's login token for agents isn't saved yet: run sc to set it up");
  return Token.parse(readFileSync(tokenFile, "utf8"));
}

// Returns the conversation a session saved, for --resume to bring back, or null when it saved
// none. Skelcrew picks Claude Code's session ID, so that is `session` itself. Claude Code saves a
// conversation only once it has a message, so a session nobody talked to has nothing to
// resume, and its id can't start a new one either. It saves it in the session's own config
// folder, under a folder named after the folder it runs in, with every character but letters
// and digits made a dash. Names over 200 characters get a hash instead, which Skelcrew's folders
// never come near.
function savedConversation(name: string, folder: string, session: string): string | null {
  const project = folder.replace(/[^a-zA-Z0-9]/g, "-");
  const file = join(dataDir(), "claude", name, "projects", project, `${session}.jsonl`);
  return existsSync(file) ? session : null;
}

// Marks a folder trusted and the first launch done in a session's .claude.json, keeping all
// else in the file. Claude Code asks whether to trust the folder even in bypass mode, and on
// its first launch asks for a theme and more, and would wait there with nobody to answer.
function trustFolder(config: string, cwd: string): void {
  // Read what is there now, if anything, refusing anything but a plain file of sane size.
  const file = join(config, ".claude.json");
  let json: z.infer<typeof ClaudeJson> = {};
  if (existsSync(file)) {
    // Non-blocking, since the agent could leave a pipe there, and opening one waits
    // forever.
    const fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error(`${file} isn't a plain file, so Skelcrew won't use it`);
      json = ClaudeJson.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  // Trust the agent's folder, keeping whatever else Claude Code saved for it.
  const projects = json.projects ?? {};
  projects[cwd] = { ...projects[cwd], hasTrustDialogAccepted: true };
  // Written beside it and renamed over it, so even a link made since the check is replaced,
  // never followed. "wx" refuses a link already at the new name.
  const fresh = join(config, `.claude.json.${process.pid}`);
  rmSync(fresh, { force: true });
  const done = { ...json, hasCompletedOnboarding: true, projects };
  writeFileSync(fresh, JSON.stringify(done), { mode: 0o600, flag: "wx" });
  renameSync(fresh, file);
}

// Prepares an agent's own config folder and trusted Claude Code settings, then returns its
// sandbox command and environment. It starts afresh with `sessionId` and the first message
// in `prompt`, or brings back a saved conversation with `resume`. A builder, given its thread's
// clone, works there; a lead works in its own `folder`. Each sees nothing else but `origin`,
// Skelcrew's clone of its repository, read-only. Each session keeps its own transcripts and logs
// in with Skelcrew's agent token, while your other credentials stay hidden.
function startCommand(given: {
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
}): { argv: string[]; env: Record<string, string> } {
  const {
    name,
    socket,
    model = defaultModel,
    thread,
    folder,
    origin,
    prompt,
    system,
    resume,
    sessionId,
    env = process.env,
  } = given;
  // Refuse what would start the wrong agent or write outside Skelcrew's folders.
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  if (sessionId && !z.uuid().safeParse(sessionId).success)
    throw new Error(`Claude Code needs a UUID as a session ID, not "${sessionId}"`);
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so Skelcrew can't find its own folders");
  // The name becomes a folder, so it must not climb out of Skelcrew's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);

  const token = claudeToken(home);

  // A folder of its own per session, never your ~/.claude: an agent could write memory or
  // settings that another session loads as instructions. It stays, so --resume finds the
  // transcripts.
  const configs = join(dataDir(home), "claude");
  const config = join(configs, name);
  // Skelcrew writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [configs, config, join(config, ".claude.json")])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so Skelcrew won't write through it`);
  // The agent sees its own folder and its config folder, both writable, and nothing else of
  // yours.
  mkdirSync(config, { recursive: true });
  const cwd = thread ?? folder;
  if (!cwd) throw new Error(`Skelcrew has no folder for ${name} to work in`);
  mkdirSync(cwd, { recursive: true });
  const mounts = [...rw(cwd), ...rw(config)];
  // Read-only at the same path. A lead reads its repository there. A thread's clone has it as
  // origin, so the builder can fetch the base branch and merge it to fix a conflict, with no
  // token.
  if (origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }

  trustFolder(config, cwd);

  // Bypass mode, since nobody is there to approve each tool. Only a builder gets the hooks
  // that tell Skelcrew it asked you a question.
  const command = ["claude", "--model", model, "--permission-mode", "bypassPermissions"];
  command.push("--settings", thread ? builderSettings : settings);
  if (resume) command.push("--resume", resume);
  if (sessionId) command.push("--session-id", sessionId);
  if (system) command.push("--append-system-prompt", system);
  if (prompt) command.push(prompt);

  // Only the environment the agent needs, plus its own config folder and login.
  const kept = keptEnv(env, claude.keys);
  kept.CLAUDE_CONFIG_DIR = config;
  kept.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Its greyed-out suggestions propose steps, such as pushing, that belong to Skelcrew.
  kept.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
  // Cross-session messaging off, since agents never talk to other Claude Code sessions. On a
  // Mac its socket under the agent's long temporary folder runs past the 103 bytes a socket
  // path may have. Claude Code then falls back to /tmp, which the sandbox hides, and shows a
  // yellow warning at the top of the session.
  kept.CLAUDE_CODE_HARBOR_KITE = "false";
  // Its install folder is read-only in the sandbox, so an update only fails, with a red line
  // in every session. You update claude outside Skelcrew, and agents start on that version.
  kept.DISABLE_AUTOUPDATER = "1";
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts,
    socket,
    cwd,
    command,
    // Only a builder has a thread. The lead is what you type into, so it keeps its priority.
    normalPriority: !thread,
  });
  return { argv, env: kept };
}

// Returns Claude Code's review command and a config folder of the review's own, so a review
// leaves no transcript behind. The command reads the review's prompt on stdin and holds the
// answer to `schema`.
function review(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  schema: string;
}) {
  const { home, folder, model = defaultModel, schema } = given;
  const token = claudeToken(home);
  // One turn in print mode, answering as JSON held to the schema, saving no conversation.
  const command = ["claude", "-p", "--model", model, "--output-format", "json"];
  command.push("--json-schema", schema, "--no-session-persistence");
  command.push("--permission-mode", "bypassPermissions", "--settings", settings);
  const env = { CLAUDE_CONFIG_DIR: join(folder, "claude"), CLAUDE_CODE_OAUTH_TOKEN: token };
  return { command, mounts: [], env };
}

// Returns the reviewer's answer from what Claude Code printed, for the reviewer to check
// against the shape.
const answer = (_folder: string, out: string): unknown =>
  z.looseObject({ structured_output: z.unknown() }).parse(JSON.parse(out)).structured_output;

// Claude Code as Skelcrew knows it. While a turn runs it shows "esc to interrupt". It is ready for
// a message once that is gone and a line holding only its ❯ prompt shows. The key is for those
// who use one rather than a login. The first run looks for `program` and, when it is
// missing, prints the line that installs it.
export const claude = {
  name: "claude",
  title: "Claude Code",
  program: "claude",
  install: "curl -fsSL https://claude.ai/install.sh | bash",
  marks: { busy: "esc to interrupt", prompt: "❯" },
  keys: ["ANTHROPIC_API_KEY"],
  start: startCommand,
  saved: savedConversation,
  review,
  answer,
} as const;
