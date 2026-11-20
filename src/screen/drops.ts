// Files dropped onto the screen. A terminal types a dropped file's path as a paste, and the agent
// can't open it: its sandbox hides your home and temporary folders, and over sc --remote the file
// is on your laptop. So a layer between your terminal and the screen copies each dropped file into
// the agent's own folder and passes the paste on with the copies' paths. Everything else passes
// through untouched.
import { accessSync, constants, copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The folder inside an agent's folder that holds its dropped files. It ignores itself in git, so
// a builder never commits a screenshot by accident. It goes with the agent's folder: a thread's
// clone at the thread's end, and for a lead with sc repo rm.
export const dropsFolder = ".skelcrew-drops";

// The screen session's option that holds the folder of the agent your typing goes to, or nothing
// while it goes to the sidebar. The sidebar keeps it. A file dropped onto the screen is copied
// there, and sc --remote reads it by the screen's name to send a file from your laptop there.
export const agentFolderOption = "@agent-folder";

// The largest file copied. A paste waits while its files are copied, and over sc --remote while
// they go up a link that may be slow, so a bigger file would hold up your typing for long. Agents
// take far smaller files as images anyway. A bigger file keeps its path.
export const largestDrop = 100 * 1024 * 1024;

// A paste longer than this is never only dropped files' paths, so it passes on without waiting
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
function pastedPaths(text: string): Part[] | null {
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
        if (end + 1 >= text.length) return null;
        path += text[end + 1];
        end += 2;
      } else if (char === "'" || char === '"') {
        const close = text.indexOf(char, end + 1);
        if (close < 0) return null;
        const inside = text.slice(end + 1, close);
        path += char === '"' ? inside.replace(/\\([\\"$`])/g, "$1") : inside;
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
  return parts.some((part) => part.path !== undefined) ? parts : null;
}

// Writes `path` the way `written` was written: in the same quotes, or with spaces and the
// characters a shell reads escaped by backslashes, as terminals write a dropped file's path. An
// agent reads it back the way it read the original.
function writtenLike(written: string, path: string): string {
  if (written.startsWith("'")) return `'${path.replaceAll("'", `'\\''`)}'`;
  if (written.startsWith('"')) return `"${path.replace(/[\\"$`]/g, "\\$&")}"`;
  return path.replace(/[\s\\'"$`!&*()|;<>?[\]{}#~^]/g, "\\$&");
}

// Says whether a dropped file can be copied: a regular file, or a link to one, that you can read
// and that isn't over largestDrop. A folder, a missing path or one you can't read keeps its path.
export function droppable(path: string): boolean {
  try {
    const found = statSync(path);
    if (!found.isFile() || found.size > largestDrop) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Returns where a dropped file's copy goes in an agent's folder: a folder of its own, so two
// files of the same name never meet, keeping the file's name, which the agent sees.
export function dropPath(folder: string, file: string): string {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return join(folder, dropsFolder, unique, basename(file));
}

// Copies dropped files into an agent's folder on this machine, and returns each copy's path, in
// order, or null for a file left as it was. A file already in the agent's folder is left, as the
// agent reads it there: sc --remote put it there already.
export function copyDrops(folder: string, files: string[]): (string | null)[] {
  return files.map((file) => {
    if (file.startsWith(`${folder}/`)) return null;
    try {
      const copy = dropPath(folder, file);
      mkdirSync(dirname(copy), { recursive: true });
      writeFileSync(join(folder, dropsFolder, ".gitignore"), "*\n");
      copyFileSync(file, copy, constants.COPYFILE_FICLONE);
      return copy;
    } catch {
      return null;
    }
  });
}

// Puts dropped files where the agent on screen can read them, and returns each one's new path,
// in order, or null for one left as it was.
export type Drop = (files: string[]) => Promise<(string | null)[]>;

// Returns the paste's text with each droppable path replaced by its copy's, or null when nothing
// was copied, so the paste passes on as it came.
async function rewritten(text: string, drop: Drop): Promise<string | null> {
  const parts = pastedPaths(text);
  if (!parts) return null;
  // Only the files that can be copied go to `drop`, each once, in the order pasted.
  const files = parts.flatMap((part) =>
    part.path !== undefined && droppable(part.path) ? [part.path] : [],
  );
  if (files.length === 0) return null;
  const copies = await drop(files);
  const copyOf = new Map(files.map((file, at) => [file, copies[at] ?? null]));
  if (![...copyOf.values()].some((copy) => copy !== null)) return null;
  return parts
    .map((part) => {
      const copy = part.path === undefined ? null : copyOf.get(part.path);
      return copy ? writtenLike(part.written, copy) : part.written;
    })
    .join("");
}

// Returns a function that takes what your terminal sends, in the pieces it arrives in, and hands
// it to `send`. Everything but a paste goes on at once, byte for byte. A paste is held until its
// end, and goes on as it came unless it is only paths of files `drop` copied. While those are
// copied, what you type after waits, so it reaches the agent after the paste. A paste whose start
// arrives split across two pieces passes untouched: holding a lone Esc back to see what follows
// would delay the Esc key.
export function pasteFilter(send: (bytes: Uint8Array) => void, drop: Drop) {
  // The paste read so far, without its start, or null outside one.
  let held: Buffer | null = null;
  // Whether a paste's files are being copied, and what arrived meanwhile.
  let copying = false;
  const waiting: Buffer[] = [];

  const take = (piece: Uint8Array): void => {
    if (copying) {
      waiting.push(Buffer.from(piece));
      return;
    }
    let rest: Buffer = Buffer.from(piece);
    while (rest.length > 0) {
      // Outside a paste, everything goes on, up to the start of one.
      if (held === null) {
        const start = rest.indexOf(pasteStart);
        if (start < 0) {
          send(rest);
          return;
        }
        if (start > 0) send(rest.subarray(0, start));
        held = Buffer.alloc(0);
        rest = rest.subarray(start + pasteStart.length);
        continue;
      }
      // Inside one, it is held until its end. One too long to be paths goes on as it is.
      const sofar: Buffer = Buffer.concat([held, rest]);
      const end = sofar.indexOf(pasteEnd);
      if (end < 0) {
        held = sofar;
        if (sofar.length > longestPaths) {
          send(Buffer.concat([pasteStart, sofar]));
          held = null;
        }
        return;
      }
      const text = sofar.subarray(0, end).toString();
      rest = sofar.subarray(end + pasteEnd.length);
      held = null;
      const asCame = Buffer.concat([pasteStart, sofar.subarray(0, end), pasteEnd]);
      // Text that isn't only paths goes on at once, without waiting on anything.
      if (pastedPaths(text) === null) {
        send(asCame);
        continue;
      }
      // Paths wait for their files, then whatever came meanwhile follows, in order.
      copying = true;
      const after = rest;
      rewritten(text, drop)
        .catch(() => null)
        .then((changed) => {
          send(changed === null ? asCame : Buffer.from(`\x1b[200~${changed}\x1b[201~`));
          copying = false;
          for (const next of [after, ...waiting.splice(0)]) take(next);
        });
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
