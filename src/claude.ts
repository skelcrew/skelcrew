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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { claudeTokenFile, dataDir } from "./paths.ts";
import { keptEnv, refuseCredentials, ro, rw, sandboxArgs } from "./sandbox.ts";

const { O_NONBLOCK, O_NOFOLLOW, O_RDONLY } = constants;

const ClaudeJson = z.looseObject({
  projects: z.record(z.string(), z.looseObject({})).optional(),
});

// Bypass mode shows a warning first, which nobody is there to accept. Claude Code's own
// sandbox fails inside skel's, so it stays off even if your settings turn it on.
const base = { skipDangerousModePermissionPrompt: true, sandbox: { enabled: false } };
export const settings = JSON.stringify(base);

// A builder's AskUserQuestion waits on a screen nobody watches, so Claude Code's hooks tell
// skel when the builder asks, and the thread needs you until the question is over. Answering
// runs PostToolUse, but setting it aside with Esc or "Chat about this" runs no hook at all, so
// whatever is typed into the builder next also ends it. The commands answer at once, and
// print nothing, since UserPromptSubmit adds what a hook prints to the message.
const asked = { type: "command", command: "skel question asked", timeout: 10 };
const answered = { ...asked, command: "skel question answered" };
const builderSettings = JSON.stringify({
  ...base,
  hooks: {
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: [asked] }],
    PostToolUse: [{ matcher: "AskUserQuestion", hooks: [answered] }],
    UserPromptSubmit: [{ hooks: [answered] }],
  },
});

// The lead hears where you attached from with your next message, through Claude Code's hook
// for it, which adds what it prints to the message without showing it. Typed in, the note
// would be a turn of its own, and the lead's answer to it the first thing you see.
const leadSettings = JSON.stringify({
  ...base,
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "skel attached", timeout: 10 }] }],
  },
});

const Token = z.string().trim().min(1);

// Reports whether a session saved a conversation, so skel knows whether --resume can bring
// it back. Claude Code saves a conversation only once it has a message, so a session nobody talked to
// has nothing to resume, and its id can't start a new one either. It saves it in the
// session's own config folder, under a folder named after the folder it runs in, with every
// character but letters and digits made a dash. Names over 200 characters get a hash
// instead, which skel's folders never come near.
export function hasTranscript(name: string, folder: string, session: string): boolean {
  const project = folder.replace(/[^a-zA-Z0-9]/g, "-");
  return existsSync(join(dataDir(), "claude", name, "projects", project, `${session}.jsonl`));
}

// Prepares an agent's own config folder and trusted Claude Code settings, then returns its
// sandbox command and environment. A builder, given its thread's clone, works there and sees
// nothing else but its origin, read-only; the lead works in its own folder and sees skel's
// clone of every repository. Each session keeps its own transcripts and logs in with skel's
// agent token, while your other credentials stay hidden.
export function agentCommand(given: {
  name: string;
  socket: string;
  model: string;
  thread?: string;
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
    model,
    thread,
    origin,
    prompt,
    system,
    resume,
    sessionId,
    env = process.env,
  } = given;
  if (sessionId && resume) throw new Error("a session can't be both new and resumed");
  if (sessionId && !z.uuid().safeParse(sessionId).success)
    throw new Error(`Claude Code needs a UUID as a session ID, not "${sessionId}"`);
  const home = env.HOME;
  if (!home) throw new Error("HOME isn't set, so skel can't find its own folders");
  // The name becomes a folder, so it must not climb out of skel's.
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) throw new Error(`"${name}" can't name a session`);

  // A token from claude setup-token never renews. A shared login would: renewing makes the
  // old refresh token stop working, so your own login or the agent's would go stale.
  const tokenFile = claudeTokenFile(home);
  if (!existsSync(tokenFile))
    throw new Error("Claude Code's login token for agents isn't saved yet: run skel to set it up");
  const token = Token.parse(readFileSync(tokenFile, "utf8"));

  // A folder of its own per session, never your ~/.claude: an agent could write memory or
  // settings that another session loads as instructions. It stays, so --resume finds the
  // transcripts.
  const configs = join(dataDir(home), "claude");
  const config = join(configs, name);
  // skel writes here with your rights, and the agent can change what is in its folder. A
  // link it left would send that write to any file of yours.
  for (const p of [configs, config, join(config, ".claude.json")])
    if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`${p} is a link, so skel won't write through it`);
  mkdirSync(config, { recursive: true });
  const cwd = thread ?? join(dataDir(home), "lead");
  const mounts = [...rw(cwd), ...rw(config)];
  // A thread's clone has skel's clone of the repository as origin. Read-only at the same path,
  // it lets the builder fetch the base branch and merge it to fix a conflict, with no token.
  if (thread && origin) {
    refuseCredentials(origin);
    mounts.push(...ro(origin));
  }
  if (!thread) {
    // The whole folder of clones is mounted, made first if need be, so a repository brought
    // in while the lead runs shows up in its sandbox too.
    const repos = join(dataDir(home), "repos");
    mkdirSync(repos, { recursive: true });
    for (const owner of readdirSync(repos))
      for (const repo of readdirSync(join(repos, owner)))
        refuseCredentials(join(repos, owner, repo));
    mkdirSync(cwd, { recursive: true });
    mounts.push(...ro(repos));
  }

  // Claude Code asks whether to trust the folder even in bypass mode, and on its first
  // launch asks for a theme and more, and would wait there with nobody to answer.
  const file = join(config, ".claude.json");
  let json: z.infer<typeof ClaudeJson> = {};
  if (existsSync(file)) {
    // Non-blocking, since the agent could leave a pipe there, and opening one waits
    // forever.
    const fd = openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error(`${file} isn't a plain file, so skel won't use it`);
      json = ClaudeJson.parse(JSON.parse(readFileSync(fd, "utf8")));
    } finally {
      closeSync(fd);
    }
  }
  const projects = json.projects ?? {};
  projects[cwd] = { ...projects[cwd], hasTrustDialogAccepted: true };
  // Written beside it and renamed over it, so even a link made since the check is replaced,
  // never followed. "wx" refuses a link already at the new name.
  const fresh = join(config, `.claude.json.${process.pid}`);
  rmSync(fresh, { force: true });
  const done = { ...json, hasCompletedOnboarding: true, projects };
  writeFileSync(fresh, JSON.stringify(done), { mode: 0o600, flag: "wx" });
  renameSync(fresh, file);

  const command = ["claude", "--model", model, "--permission-mode", "bypassPermissions"];
  command.push("--settings", thread ? builderSettings : leadSettings);
  if (resume) command.push("--resume", resume);
  if (sessionId) command.push("--session-id", sessionId);
  if (system) command.push("--append-system-prompt", system);
  if (prompt) command.push(prompt);

  const kept = keptEnv(env);
  kept.CLAUDE_CONFIG_DIR = config;
  kept.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Its greyed-out suggestions propose steps, such as pushing, that belong to skel.
  kept.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = "false";
  // Its install folder is read-only in the sandbox, so an update only fails, with a red line
  // in every session. You update claude outside skel, and agents start on that version.
  kept.DISABLE_AUTOUPDATER = "1";
  const argv = sandboxArgs({
    home,
    path: env.PATH ?? "",
    mounts,
    socket,
    cwd,
    command,
  });
  return { argv, env: kept };
}
