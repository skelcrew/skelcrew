// A session host for tests, run as a runtime plugin's session command. It keeps each session in
// a folder of its own under its settings folder: the session's labels, its process, what its
// agent printed, which is its screen, and a pipe its agent reads, which paste and keys write to.
// It notes each question it is asked in `asked`, and keeps a session's new title from rename
// with its labels, answering nothing. It notes each status it is given in `statuses`. Its
// own transport, when the test's manifest says it provides one, takes an agent as idle unless
// its screen shows Claude Code's busy mark, and types a message in one step, noting it in
// `delivered`. With a file hang-status, the first status it is given hangs, and with a file
// garble-<question> it answers that question with nothing, with down it fails every question
// alike, with fail-<question> it fails it
// once, with unknown-<question> it fails it every time as an older plugin that doesn't know it,
// with slow-<question> it takes two seconds over it, and with hold-<question> it holds it
// from a given time on. With a file lose-start, it starts the
// next session but fails before saying its ID. Given `files` as it starts a session, it does as
// a host that provides files: it makes the session a folder of dropped files, `files` in the
// session's folder, and swaps the placeholder for it wherever it appears in the command. Its one
// argument, its settings folder, is only there so a test's clean-up can find its calls with ps.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const dir = process.env.SKELCREW_PLUGIN_CONFIG ?? "";
// Each call notes its process ID in `running-calls` while it runs. A call outlives the daemon
// that made it, so a test's clean-up waits for those still running, as one may be starting a
// session.
const call = join(dir, "running-calls", String(process.pid));
mkdirSync(join(dir, "running-calls"), { recursive: true });
writeFileSync(call, "");
process.on("exit", () => rmSync(call, { force: true }));
const question = JSON.parse(await Bun.stdin.text());
appendFileSync(join(dir, "asked"), `${JSON.stringify(question)}\n`);
const sessions = join(dir, "sessions");
const folder = (id: string) => join(sessions, id);
const busy = "esc to interrupt";

// Whether the session's process group still runs and its command hasn't ended.
function running(id: string): boolean {
  if (existsSync(join(folder(id), "exit"))) return false;
  try {
    process.kill(-Number(readFileSync(join(folder(id), "pid"), "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}

// What the session shows: what its agent printed since it last cleared the screen, without
// escape codes, as a terminal would show it.
function screen(id: string): string {
  const printed = readFileSync(join(folder(id), "screen"), "utf8");
  const shown = printed.split("\x1b[2J").at(-1) ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape codes are what goes.
  return shown.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// Writes into the pipe the session's agent reads, only while it runs, as a pipe with nobody
// reading it would hold the write forever.
function type(id: string, text: string): void {
  if (!running(id)) throw new Error(`${id} isn't running`);
  appendFileSync(join(folder(id), "input"), text);
}

const answers: Record<string, () => unknown> = {
  // Runs the command with only the environment given, reading the pipe and printing to the
  // screen file, in a process group of its own that outlives this call. A shell holds the pipe
  // open for reading and writing, so each write reaches the agent and none ends its input.
  start: () => {
    const id = `fake-${question.name}`;
    rmSync(folder(id), { recursive: true, force: true });
    mkdirSync(folder(id), { recursive: true });
    writeFileSync(join(folder(id), "labels.json"), JSON.stringify(question.labels));
    writeFileSync(join(folder(id), "screen"), "");
    Bun.spawnSync(["mkfifo", join(folder(id), "input")]);
    const drops = join(folder(id), "files");
    if (question.files) mkdirSync(drops);
    const command = question.command.map((word: string) =>
      question.files ? word.replaceAll(question.files, drops) : word,
    );
    const env = Object.entries(question.env).map(([key, value]) => `${key}=${value}`);
    // The session's folder comes in as $0, then the agent's folder and the pipe, then the
    // environment and the command, which env -i runs with nothing else.
    const shell = `f="$0"; exec 3<>"$2"; cd "$1"; shift 2; env -i "$@" <&3 > "$f/screen" 2>&1; echo $? > "$f/exit"`;
    const run = Bun.spawn(
      [
        "sh",
        "-c",
        shell,
        folder(id),
        question.folder,
        join(folder(id), "input"),
        ...env,
        ...command,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    writeFileSync(join(folder(id), "pid"), String(run.pid));
    run.unref();
    // With a file lose-start, it starts the session but fails before answering, once.
    if (existsSync(join(dir, "lose-start"))) {
      rmSync(join(dir, "lose-start"));
      throw new Error("lost the answer");
    }
    return { id };
  },
  read: () => ({ screen: screen(question.id) }),
  paste: () => type(question.id, `\x1b[200~${question.text}\x1b[201~`),
  keys: () => type(question.id, question.key === "Enter" ? "\n" : "\x1b"),
  interrupt: () => type(question.id, "\x1b"),
  // Ends the session's process group and waits until it has gone. One that exited may wait to
  // be reaped, so only processes that haven't exited count.
  end: async () => {
    const pid = Number(readFileSync(join(folder(question.id), "pid"), "utf8"));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
    const left = () =>
      Bun.spawnSync(["ps", "-A", "-o", "pgid=", "-o", "stat="])
        .stdout.toString()
        .split("\n")
        .some((line) => {
          const [group, state] = line.trim().split(/\s+/);
          return Number(group) === pid && !state?.startsWith("Z");
        });
    while (left()) await Bun.sleep(50);
    rmSync(folder(question.id), { recursive: true, force: true });
  },
  list: () => ({
    sessions: (existsSync(sessions) ? readdirSync(sessions) : []).map((id) => ({
      id,
      running: running(id),
      labels: JSON.parse(readFileSync(join(folder(id), "labels.json"), "utf8")),
    })),
  }),
  // Stores the session's new title with its labels, and prints nothing at all, as Skelcrew
  // doesn't read the answer to a rename.
  rename: () => {
    const file = join(folder(question.id), "labels.json");
    const labels = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...labels, title: question.title }));
    process.exit(0);
  },
  idle: () => ({ idle: !screen(question.id).includes(busy) }),
  // Types the message in one step once the agent is idle, or fails past the timeout.
  deliver: async () => {
    const deadline = Date.now() + (question.timeout ?? 60_000);
    while (screen(question.id).includes(busy)) {
      if (Date.now() > deadline) throw new Error(`${question.id} stayed busy`);
      await Bun.sleep(50);
    }
    type(question.id, `\x1b[200~${question.text}\x1b[201~\n`);
    appendFileSync(join(dir, "delivered"), `${JSON.stringify(question)}\n`);
  },
  // With a file hang-status, the first status it is given hangs, as a broken host would.
  status: async () => {
    if (existsSync(join(dir, "hang-status"))) {
      rmSync(join(dir, "hang-status"));
      await Bun.sleep(60_000);
    }
    appendFileSync(
      join(dir, "statuses"),
      `${JSON.stringify({ id: question.id, status: question.status, reason: question.reason })}\n`,
    );
  },
};

// With a file garble-<question>, it does nothing and answers with nothing at all, as a broken
// host might.
if (existsSync(join(dir, `garble-${question.ask}`))) process.exit(0);
// With a file hold-<question> holding a number, it holds that question from its nth time on,
// counting each time it was asked, until the file goes. A test removes the file while other
// calls run, so one that finds it gone before reading it isn't held: reading it then would
// fail the call, and the test would see a host that couldn't answer.
const hold = join(dir, `hold-${question.ask}`);
let from = 0;
try {
  from = Number(readFileSync(hold, "utf8"));
} catch {}
if (from > 0) {
  const times = readFileSync(join(dir, "asked"), "utf8")
    .split("\n")
    .filter((line) => line && JSON.parse(line).ask === question.ask).length;
  if (times >= from) while (existsSync(hold)) await Bun.sleep(20);
}
// With a file slow-<question>, it takes two seconds over that question, as a slow host would.
if (existsSync(join(dir, `slow-${question.ask}`))) await Bun.sleep(2000);
// With a file down, it fails every question in the same words, as a host that is down would.
if (existsSync(join(dir, "down"))) {
  console.error("the host is down");
  process.exit(1);
}
// A question it doesn't know, or one with a file unknown-<question>, as an older plugin that
// doesn't know it, such as herdr's before it could rename, fails every time.
if (!answers[question.ask] || existsSync(join(dir, `unknown-${question.ask}`))) {
  console.error(`✖ Invalid value '${question.ask}'. Expected 'start' | 'list'; → at ask`);
  process.exit(1);
}
// With a file fail-<question>, it fails that question once, as a host down for a moment would.
if (existsSync(join(dir, `fail-${question.ask}`))) {
  rmSync(join(dir, `fail-${question.ask}`));
  console.error("the host is down for a moment");
  process.exit(1);
}
try {
  const answer = await answers[question.ask]?.();
  console.log(JSON.stringify(answer ?? null));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
