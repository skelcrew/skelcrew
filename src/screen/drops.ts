// Files dropped onto the screen. A terminal types a dropped file's path as a paste, and the agent
// can't open it: its sandbox hides your home and temporary folders, and over sc --remote the file
// is on your laptop. So a layer between your terminal and the screen copies each dropped file into
// the agent's own folder and passes the paste on with the copies' paths. Everything else passes
// through untouched.
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// The folder inside an agent's folder that holds its dropped files. It ignores itself in git, so
// a builder never commits a screenshot by accident. It goes with the agent's folder: a thread's
// clone at the thread's end, and for a lead with sc repo rm.
export const dropsFolder = ".skelcrew-drops";

// How a drop learns which agent's folder its files go to. Keys typed just before the drop, such as
// Alt-Down to another row, may still be on their way to the sidebar, so asking tmux at once could
// name the agent you just left. So the layer sends `dropSignal` on, in your typing's stream,
// right before the paste. It is a right click on the screen's top row at column 9999, past the
// edge of any real terminal, so no click of yours can be taken for it, and `dropSignalColumn` is
// that column as tmux counts it, from 0. The screen's tmux types `dropAsk` into the sidebar for it,
// after every key before it. The
// sidebar then sets `dropAnswerOption` on the screen's session to a count, which changes each
// time, and the folder of the agent your typing goes to, or nothing while it goes to the sidebar.
export const dropSignal = "\x1b[<2;9999;1M\x1b[<2;9999;1m";
export const dropSignalColumn = 9998;
export const dropAsk = "\x1b]skel-drop\x07";
export const dropAnswerOption = "@drop-answer";

// How long, in milliseconds, the screen's tmux waits for the rest of a sequence cut off after
// its Esc before taking its bytes as keys of their own, and so how long the layer keeps the
// start of a paste cut at the end of a read. Any later, tmux would no longer see a paste there.
export const escapeTime = 10;

// How long, in milliseconds, the layer keeps more than an Esc of a paste's start, cut at the end
// of a read, for the rest, before it lets it go on as it came.
const cutStartWait = 500;

// Returns the folder an answer of the sidebar names, or null for none.
export function answeredFolder(answer: string): string | null {
  const folder = answer.slice(answer.indexOf(" ") + 1);
  return folder.startsWith("/") ? folder : null;
}

// The largest file copied. A paste waits while its files are copied, and over sc --remote while
// they go up a link that may be slow, so a bigger file would hold up your typing for long. Agents
// take far smaller files as images anyway. A bigger file keeps its path. It is also the most the
// screen holds in memory at once, for all the drops on their way, and a file that would pass it
// keeps its path too.
export const largestDrop = 100 * 1024 * 1024;

// A paste longer than this is never only dropped files' paths, so it goes on without waiting
// for its end.
const longestPaths = 64 * 1024;

// What a terminal sends around a paste, once the program asked for bracketed pastes.
const pasteStart = Buffer.from("\x1b[200~");
const pasteEnd = Buffer.from("\x1b[201~");

// One part of a paste: a run of spaces as written, or a path, as written and as it reads.
type Part = { written: string; path?: string };

// Splits a paste into paths and the spaces between them, reading quotes and backslashes as a
// terminal writes them for a dropped file, such as `/Users/me/My\ File.png` or `'/tmp/a b.pdf'`.
// Returns null unless the paste holds only absolute paths, so any other text passes untouched.
// Given only the start of a paste, `whole` false, it returns null once that start shows the paste
// can't be only paths, and the parts read so far otherwise.
function pastedPaths(text: string, whole = true): Part[] | null {
  const parts: Part[] = [];
  let at = 0;
  while (at < text.length) {
    // Spaces and line breaks between paths stay exactly as they were.
    const spaces = text.slice(at).match(/^\s+/)?.[0];
    if (spaces) {
      parts.push({ written: spaces });
      at += spaces.length;
      continue;
    }
    // A path runs to the next space that isn't quoted or escaped.
    let path = "";
    let end = at;
    while (end < text.length && !/\s/.test(text[end] ?? "")) {
      const char = text[end] ?? "";
      if (char === "\\") {
        if (end + 1 >= text.length) return whole ? null : parts;
        path += text[end + 1];
        end += 2;
      } else if (char === "'") {
        const close = text.indexOf("'", end + 1);
        if (close < 0) return whole ? null : parts;
        path += text.slice(end + 1, close);
        end = close + 1;
      } else if (char === '"') {
        // In double quotes a backslash keeps the next \, ", $ or ` as it is, so an escaped
        // quote doesn't close them.
        let close = end + 1;
        while (close < text.length && text[close] !== '"') {
          const next = text[close + 1] ?? "";
          if (text[close] === "\\" && '\\"$`'.includes(next) && next !== "") {
            path += next;
            close += 2;
          } else {
            path += text[close];
            close++;
          }
        }
        if (close >= text.length) return whole ? null : parts;
        end = close + 1;
      } else {
        path += char;
        end++;
      }
    }
    if (!path.startsWith("/")) return null;
    parts.push({ written: text.slice(at, end), path });
    at = end;
  }
  return !whole || parts.some((part) => part.path !== undefined) ? parts : null;
}

// Writes `path` the way `written` was written: in the same quotes, or with spaces and the
// characters a shell reads escaped by backslashes, as terminals write a dropped file's path. An
// agent reads it back the way it read the original.
function writtenLike(written: string, path: string): string {
  if (written.startsWith("'")) return `'${path.replaceAll("'", `'\\''`)}'`;
  if (written.startsWith('"')) return `"${path.replace(/[\\"$`]/g, "\\$&")}"`;
  return path.replace(/[\s\\'"$`!&*()|;<>?[\]{}#~^]/g, "\\$&");
}

// A dropped file, read when it was dropped: its path as pasted and what it holds.
export type Dropped = { path: string; bytes: Uint8Array };

// Returns where a dropped file's copy goes in an agent's folder: a folder of its own, so two
// files of the same name never meet, keeping the file's name, which the agent sees.
export function dropPath(folder: string, file: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return join(folder, dropsFolder, unique, basename(file));
}

// Shell that puts a copy, read from its input, at `copy`, a path dropPath gave, and the words to
// run it with. The screen runs outside the agent's sandbox, and the agent can write its own
// folder, so a link it put there, even one swapped in while the copy is made, must never lead
// the screen to write elsewhere. So the shell changes into each folder on the way, checks it is
// where it should be with every link followed, and makes each file by its name from there: a
// shell stays in the folder it checked, whatever is renamed after. Nothing is written over. The
// drops folder's .gitignore keeps git from seeing the copies, so a builder doesn't commit them.
export function dropCommand(copy: string): string[] {
  const unique = dirname(copy);
  const script = [
    'mkdir -p -- "$1" && cd -P -- "$1" && top=$(pwd -P)',
    `mkdir -p ${dropsFolder} && cd -P ${dropsFolder} && [ "$(pwd -P)" = "$top/${dropsFolder}" ]`,
    "set -C",
    // A .gitignore already there must be a plain file that ignores everything, or the copy would
    // show to git, and a builder could commit it.
    "{ printf '*\\n' > .gitignore 2>/dev/null; true; }",
    '[ -f .gitignore ] && [ ! -L .gitignore ] && [ "$(cat .gitignore)" = "*" ]',
    `mkdir -- "$2" && cd -P -- "$2" && [ "$(pwd -P)" = "$top/${dropsFolder}/$2" ]`,
    'cat > "$3"',
  ].join(" && ");
  return ["sh", "-c", script, "sh", dirname(dirname(unique)), basename(unique), basename(copy)];
}

// Says whether the agent can read `file` by that path already: a path inside its folder, with no
// .. in it, that stays inside once every link on the way is followed. A link inside that points
// out, such as into your home folder, leads where the sandbox hides it, so its file is copied.
async function readableBy(folder: string, file: string): Promise<boolean> {
  if (!file.startsWith(`${folder}/`) || file.split("/").includes("..")) return false;
  try {
    return (await realpath(file)).startsWith(`${await realpath(folder)}/`);
  } catch {
    return false;
  }
}

// Copies dropped files into an agent's folder on this machine, and returns each copy's path, in
// order, or null for a file left as it was. A file the agent can read where it is is left.
// It runs without holding up the screen, so a big file or a slow disk never stops it.
export function copyDrops(folder: string, files: Dropped[]): Promise<(string | null)[]> {
  return Promise.all(
    files.map(async (file) => {
      if (await readableBy(folder, file.path)) return null;
      const copy = dropPath(folder, file.path);
      const copying = Bun.spawn(dropCommand(copy), {
        stdin: file.bytes,
        stdout: "ignore",
        stderr: "ignore",
      });
      return (await copying.exited) === 0 ? copy : null;
    }),
  );
}

// Where dropped files go: `where` asks the screen which agent's folder your typing goes to, and
// gives it back, or null for none. It calls `ask` to send dropSignal on once it is ready to see
// the sidebar's answer change. `put` puts the files, read as they were dropped, in that folder,
// and returns each one's new path, in order, or null for one left as it was.
export type Drop = {
  where: (ask: () => void) => Promise<string | null>;
  put: (folder: string, files: Dropped[]) => Promise<(string | null)[]>;
};

// A whole control sequence, such as an arrow key or a mouse event: Esc, [, its parameters and
// its final byte.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control sequence starts with Esc.
const wholeCsi = /^\x1b\[[0-?]*[ -/]*[@-~]/;

// Returns the escape sequence the bytes sent so far end inside, or "" when they end between
// sequences. `last` is what this returned for the bytes before `sent`. A lone Esc counts as
// unfinished, as more of a sequence may follow it.
export function unfinished(last: string, sent: string): string {
  const text = last + sent;
  const at = text.lastIndexOf("\x1b");
  if (at < 0) return "";
  const sequence = text.slice(at);
  const kind = sequence[1];
  if (kind === undefined) return sequence;
  if (kind === "[") return wholeCsi.test(sequence) ? "" : sequence;
  if (kind === "O") return sequence.length >= 3 ? "" : sequence;
  if ("]P_^X".includes(kind)) return sequence.includes("\x07") ? "" : sequence;
  return "";
}

// Returns a function that takes what your terminal sends, in the pieces it arrives in, and hands
// it to `send`, byte for byte, at once. A paste is held until its end. Text goes on as it came. A
// paste of paths goes on once its files are copied, with their copies' paths, and everything you
// send after it waits until then, then follows in order, so Enter pressed right after a drop sends
// the file's path, never the prompt without it. Only input after a drop waits: before one,
// nothing does, and your terminal's size is never input.
//
// What the filter adds to the stream itself, the drop's question and a paste that waited, goes in
// only between escape sequences, never inside one you are sending, such as a mouse event split
// across two reads, however long its rest takes. After a lone Esc it waits only a moment for
// the rest, as an Esc key has none.
export function pasteFilter(send: (bytes: Uint8Array) => void, drop: Drop) {
  // The paste read so far, without its start, or null outside one.
  let held: Buffer | null = null;
  // The escape sequence what went on last ends inside, or "".
  let openSequence = "";
  // The end of the last read, when it may be the start of a paste cut in two, kept until the next
  // read, and the timer that sends it on if that read is late.
  let cut: Buffer = Buffer.alloc(0);
  let cutLater: ReturnType<typeof setTimeout> | null = null;
  // What the filter has to add, waiting for the stream to be between sequences, and the timer
  // that adds it anyway when the sequence never ends.
  // Each comes with what to do once it went in.
  const adding: { bytes: Buffer; then: () => void }[] = [];
  let addLater: ReturnType<typeof setTimeout> | null = null;
  // Whether a paste that can't be only paths is going on as it comes, and the last bytes of it
  // sent, where its end may have begun.
  let streaming = false;
  let streamedLast: Buffer = Buffer.alloc(0);
  // Whether a drop's files are on their way, and what you sent meanwhile.
  let dropping = false;
  const waiting: Buffer[] = [];
  // How many bytes of dropped files are held in memory, read and not yet copied.
  let heldBytes = 0;
  // Reads a dropped file at once, as macOS deletes a screenshot's file within seconds of its
  // drop, and a drop onto a server's screen takes a while to learn where the file goes. Only a
  // regular file, or a link to one, that you can read and that isn't over largestDrop is read,
  // and only while all the files held stay within largestDrop too, so several big drops never
  // fill the screen's memory. Any other gives null and keeps its path. It reads without holding
  // up the screen, as a disk can be slow to answer.
  const readDropped = async (path: string): Promise<Dropped | null> => {
    let size = 0;
    try {
      const found = await stat(path);
      if (!found.isFile() || heldBytes + found.size > largestDrop) return null;
      size = found.size;
      heldBytes += size;
      const bytes = await Bun.file(path).bytes();
      if (bytes.length > size) throw new Error("the file grew as it was read");
      heldBytes -= size - bytes.length;
      return { path, bytes };
    } catch {
      heldBytes -= size;
      return null;
    }
  };
  // Lets go of a file once it is copied or no drop needs it.
  const letGo = (file: Dropped | null) => {
    if (file) heldBytes -= file.bytes.length;
  };

  // The files of drops that came while another was on its way, read as they came: by path, one
  // read for each paste that waits, in the order the pastes came.
  const readEarly = new Map<string, Promise<Dropped | null>[]>();
  // Returns how many whole pastes of paths that wait name each path.
  const pathsWaiting = () => {
    const text = Buffer.concat(waiting).toString();
    const named = new Map<string, number>();
    let at = text.indexOf("\x1b[200~");
    while (at >= 0) {
      const end = text.indexOf("\x1b[201~", at);
      if (end < 0) break;
      const parts = pastedPaths(text.slice(at + pasteStart.length, end)) ?? [];
      for (const path of new Set(parts.flatMap((part) => part.path ?? [])))
        named.set(path, (named.get(path) ?? 0) + 1);
      at = text.indexOf("\x1b[200~", end);
    }
    return named;
  };
  // Reads the files of the drops that wait, so a drop that comes while another is on its way is
  // read at once too, and each drop keeps what its files held then.
  const readWaiting = () => {
    for (const [path, count] of pathsWaiting()) {
      const reads = readEarly.get(path) ?? [];
      while (reads.length < count) reads.push(readDropped(path));
      readEarly.set(path, reads);
    }
  };

  // Sends what is waiting to be added, now that the stream is between sequences.
  const addWaiting = () => {
    if (addLater) clearTimeout(addLater);
    addLater = null;
    for (const { bytes, then } of adding.splice(0)) {
      send(bytes);
      then();
    }
  };
  // Adds bytes to the stream between sequences, now or once the sequence sent last ends, then
  // does `then`.
  const add = (bytes: Buffer, then = () => {}) => {
    if (openSequence === "") {
      send(bytes);
      then();
      return;
    }
    adding.push({ bytes, then });
    waitForSequence();
  };
  // Sets the timer that adds what waits anyway, in case the sequence sent last never ends. A
  // lone Esc may be the Esc key, which has nothing after it, so it waits only a moment, longer
  // than tmux waits for the rest. Any longer start is surely a sequence whose rest is on its
  // way, however slowly, so it waits a second.
  const waitForSequence = () => {
    if (addLater) clearTimeout(addLater);
    addLater = setTimeout(
      () => {
        openSequence = "";
        addWaiting();
      },
      openSequence === "\x1b" ? 50 : 1000,
    );
  };
  // Sends what you sent on at once.
  const pass = (bytes: Buffer) => {
    send(bytes);
    openSequence = unfinished(openSequence, bytes.toString("latin1"));
    if (openSequence === "") addWaiting();
    else if (adding.length > 0) waitForSequence();
  };

  // Returns the paste's text with each droppable path replaced by its copy's, or null when
  // nothing was copied, so the paste goes on as it came. Each file is read once, before asking
  // where it goes, and only when one can be copied is that asked.
  const rewritten = async (text: string): Promise<string | null> => {
    const parts = pastedPaths(text);
    if (!parts) return null;
    const paths = [
      ...new Set(parts.flatMap((part) => (part.path === undefined ? [] : [part.path]))),
    ];
    const reading = paths.map((path) => readEarly.get(path)?.shift() ?? readDropped(path));
    const files = (await Promise.all(reading)).filter((file) => file !== null);
    if (files.length === 0) return null;
    let copies: (string | null)[] = [];
    try {
      const folder = await drop.where(() => add(Buffer.from(dropSignal)));
      if (folder === null) return null;
      copies = await drop.put(folder, files);
    } finally {
      for (const file of files) letGo(file);
    }
    const copyOf = new Map(files.map((file, at) => [file.path, copies[at] ?? null]));
    if (![...copyOf.values()].some((copy) => copy !== null)) return null;
    return parts
      .map((part) => {
        const copy = part.path === undefined ? null : copyOf.get(part.path);
        return copy ? writtenLike(part.written, copy) : part.written;
      })
      .join("");
  };

  const take = (piece: Uint8Array): void => {
    if (dropping) {
      waiting.push(Buffer.from(piece));
      readWaiting();
      return;
    }
    if (cutLater) clearTimeout(cutLater);
    cutLater = null;
    let rest: Buffer = Buffer.concat([cut, piece]);
    cut = Buffer.alloc(0);
    while (rest.length > 0) {
      // A paste going on as it comes passes through to its end, then what follows is read again.
      if (streaming) {
        const seen = Buffer.concat([streamedLast, rest]);
        const end = seen.indexOf(pasteEnd);
        if (end < 0) {
          pass(rest);
          streamedLast = seen.subarray(Math.max(seen.length - pasteEnd.length + 1, 0));
          return;
        }
        const through = end + pasteEnd.length - streamedLast.length;
        pass(rest.subarray(0, through));
        rest = rest.subarray(through);
        streaming = false;
        continue;
      }
      // Outside a paste, everything goes on, up to the start of one.
      if (held === null) {
        const start = rest.indexOf(pasteStart);
        if (start >= 0) {
          pass(rest.subarray(0, start));
          held = Buffer.alloc(0);
          rest = rest.subarray(start + pasteStart.length);
          continue;
        }
        // A read that ends in what may be the start of a paste keeps it for the next read, so a
        // start is always seen whole, never half sent. A lone Esc goes on as it came after
        // escapeTime, as it is most often the Esc key, and tmux would take it as one by then. More
        // than an Esc can only be a sequence on its way, such as over a slow link, so it waits
        // longer for its rest. tmux never sees it cut, so it reads the paste whole.
        let ending = Math.min(rest.length, pasteStart.length - 1);
        while (ending > 0 && !rest.subarray(-ending).equals(pasteStart.subarray(0, ending)))
          ending--;
        pass(rest.subarray(0, rest.length - ending));
        if (ending === 0) return;
        cut = rest.subarray(rest.length - ending);
        cutLater = setTimeout(
          () => {
            pass(cut);
            cut = Buffer.alloc(0);
          },
          cut.length === 1 ? escapeTime : cutStartWait,
        );
        return;
      }
      // Inside one, it is held until its end.
      const sofar: Buffer = Buffer.concat([held, rest]);
      const end = sofar.indexOf(pasteEnd);
      if (end < 0) {
        held = sofar;
        // A paste whose start already shows it isn't only paths, or too long to be, goes on now,
        // after what was sent of its start, and the rest of it as it comes. Bytes at the end that
        // may be the start of its end are left out of the check, as they aren't the paste's.
        let ending = Math.min(sofar.length, pasteEnd.length - 1);
        while (ending > 0 && !sofar.subarray(-ending).equals(pasteEnd.subarray(0, ending)))
          ending--;
        const sofarText = sofar.subarray(0, sofar.length - ending).toString();
        if (sofar.length > longestPaths || pastedPaths(sofarText, false) === null) {
          pass(Buffer.concat([pasteStart, sofar]));
          held = null;
          streaming = true;
          streamedLast = sofar.subarray(Math.max(sofar.length - pasteEnd.length + 1, 0));
        }
        return;
      }
      held = null;
      rest = sofar.subarray(end + pasteEnd.length);
      const text = sofar.subarray(0, end).toString();
      const asCame = Buffer.concat([pasteStart, sofar.subarray(0, end), pasteEnd]);
      // Text goes on at once, as it came.
      if (pastedPaths(text) === null) {
        pass(asCame);
        continue;
      }
      // Paths wait for their files, and what came after the paste waits until it has gone in.
      dropping = true;
      waiting.push(rest);
      const release = () => {
        dropping = false;
        for (const next of waiting.splice(0)) take(next);
        const named = pathsWaiting();
        for (const [path, reads] of readEarly) {
          for (const unused of reads.splice(0, reads.length - (named.get(path) ?? 0)))
            unused.then(letGo);
          if (reads.length === 0) readEarly.delete(path);
        }
      };
      rewritten(text)
        .catch(() => null)
        .then((changed) =>
          add(changed === null ? asCame : Buffer.from(`\x1b[200~${changed}\x1b[201~`), release),
        );
      readWaiting();
      return;
    }
  };
  return take;
}

// Runs a command, such as the screen's tmux client or ssh, in a terminal of its own between it
// and yours, passing everything through both ways but rewriting dropped files' pastes with
// `drop`. Your terminal's size goes on as it changes. Returns the command's exit code. Without a
// terminal, it runs the command as it is.
export async function runWithDrops(
  argv: string[],
  drop: Drop,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return Bun.spawn(argv, { env, stdio: ["inherit", "inherit", "inherit"] }).exited;
  // Your terminal is set raw, with nothing done to what goes out either, so the command's own
  // terminal decides everything, as it would on yours. Its settings come back after.
  const stty = (...args: string[]) =>
    Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
  const saved = stty("-g").stdout.toString().trim();
  stty("raw", "-echo");
  const terminal = new Bun.Terminal({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    name: env.TERM ?? "xterm-256color",
    data: (_terminal, bytes) => {
      process.stdout.write(bytes);
    },
  });
  // A paste whose files were still being copied as the command ended has nowhere to go.
  const take = pasteFilter((bytes) => {
    if (!terminal.closed) terminal.write(bytes);
  }, drop);
  const typed = (bytes: Uint8Array) => take(bytes);
  const resized = () => terminal.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  process.stdin.on("data", typed);
  process.on("SIGWINCH", resized);
  try {
    const command = Bun.spawn(argv, { env, terminal });
    const code = await command.exited;
    // What the command wrote last, such as tmux's line on leaving, may still be on its way out.
    // The terminal says it ended only once it is closed, so a moment's wait lets that through.
    await Bun.sleep(50);
    return code;
  } finally {
    process.stdin.off("data", typed);
    process.stdin.pause();
    process.off("SIGWINCH", resized);
    terminal.close();
    if (saved) stty(saved);
  }
}
