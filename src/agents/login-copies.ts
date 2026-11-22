// Each agent's own copy of a harness's login, kept outside the sandbox: a folder per start of a
// lead or builder session and per review, written whole, and removed once its agent ends.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.ts";

// The harnesses whose agents get a copy of Skelcrew's login.
export type CopiedHarness = "codex" | "pi";

// The folders of a harness's copies: one per start of a lead or builder session, named by the
// session's name, a + and an ID, and one per review.
const sessionCopies = (home: string, harness: CopiedHarness) =>
  join(dataDir(home), `${harness}-logins`);
const reviewCopies = (home: string, harness: CopiedHarness) =>
  join(dataDir(home), `${harness}-review-logins`);

// Returns a new folder for the copy of a lead's or builder's session, by its name. Each start
// gets its own, so the end of a session before never removes the copy of the one after.
export const sessionLogin = (home: string, harness: CopiedHarness, name: string) =>
  join(sessionCopies(home, harness), `${name}+${crypto.randomUUID()}`);

// Returns a new folder for a review's copy.
export const reviewLogin = (home: string, harness: CopiedHarness) =>
  join(reviewCopies(home, harness), crypto.randomUUID());

// Returns the name of the session a copy's folder is for.
const sessionOf = (folder: string) => folder.slice(0, folder.lastIndexOf("+"));

// Returns the names of the sessions whose copies are there.
export const sessionsWithCopies = (home: string, harness: CopiedHarness) =>
  existsSync(sessionCopies(home, harness))
    ? readdirSync(sessionCopies(home, harness)).map(sessionOf)
    : [];

// Writes `text` whole as the auth.json in `folder`, through a new file renamed over the old one,
// so the harness never reads half of it. An agent can write in its copy's folder, so the new
// file is made only where nothing is, which never follows a link, and the rename replaces
// whatever is at auth.json rather than writing into it.
export function writeLogin(folder: string, text: string): void {
  const aside = join(folder, `.auth-${crypto.randomUUID()}.json`);
  writeFileSync(aside, text, { flag: "wx", mode: 0o600 });
  renameSync(aside, join(folder, "auth.json"));
}

// Writes an agent's copy in `folder`, made if it isn't there. Anything left of it goes when a
// step fails.
export function writeCopy(folder: string, text: string): void {
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${folder} is a link, so Skelcrew won't write a login through it`);
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeLogin(folder, text);
  } catch (error) {
    dropLogin(folder);
    throw error;
  }
}

// Writes `text` into every copy of a harness's login, as Skelcrew renewed its own. A copy
// removed meanwhile, or one its agent left unwritable, is skipped.
export function rewriteCopies(home: string, harness: CopiedHarness, text: string): void {
  for (const copies of [sessionCopies(home, harness), reviewCopies(home, harness)]) {
    if (!existsSync(copies)) continue;
    for (const name of readdirSync(copies))
      try {
        writeLogin(join(copies, name), text);
      } catch {}
  }
}

// Removes an agent's copy, once its session or review ended.
export function dropLogin(folder: string): void {
  rmSync(folder, { recursive: true, force: true });
}

// Removes every copy of the session with this name, as one starts with it: only one session runs
// by a name, so any copy left is a session's before, which ended without removing it.
export function dropSessionLogins(home: string, harness: CopiedHarness, name: string): void {
  const copies = sessionCopies(home, harness);
  if (!existsSync(copies)) return;
  for (const folder of readdirSync(copies))
    if (sessionOf(folder) === name) dropLogin(join(copies, folder));
}

// Removes the copy of each session `runs` says doesn't run. A session still starting runs, and
// one `runs` can't answer for keeps its copy. Each is asked about apart, so one slow to answer
// holds up no other.
export async function sweepLogins(
  home: string,
  harness: CopiedHarness,
  runs: (name: string) => Promise<boolean>,
): Promise<void> {
  const copies = sessionCopies(home, harness);
  if (!existsSync(copies)) return;
  await Promise.all(
    readdirSync(copies).map(async (folder) => {
      const running = await runs(sessionOf(folder)).catch(() => true);
      if (!running) dropLogin(join(copies, folder));
    }),
  );
}

// Removes every review's copy. As the daemon starts, no review runs yet.
export function sweepReviewLogins(home: string, harness: CopiedHarness): void {
  rmSync(reviewCopies(home, harness), { recursive: true, force: true });
}

// Returns launch, which writes a session's copy of the login in `login` with `copy`, links `link`
// to its auth.json, and then starts the session with what it is given. The copies of a session
// by its name before go first. A start that fails removes the copy and the link.
export function launching(given: {
  home: string;
  harness: CopiedHarness;
  title: string;
  name: string;
  login: string;
  link: string;
  copy: (folder: string) => Promise<boolean>;
}) {
  const { home, harness, title, name, login, link, copy } = given;
  return async <T>(start: () => Promise<T>): Promise<T> => {
    try {
      dropSessionLogins(home, harness, name);
      if (!(await copy(login)))
        throw new Error(`Skelcrew's ${title} login went while the session started`);
      rmSync(link, { force: true });
      symlinkSync(join(login, "auth.json"), link);
      return await start();
    } catch (error) {
      dropLogin(login);
      rmSync(link, { force: true });
      throw error;
    }
  };
}

// Returns `argv` run so that `folder` is removed once it ends, outside the sandbox, whether it
// exits or its session is ended. It runs in the background, on the terminal's input, so a
// signal that ends the session ends it at once, rather than once the agent exits, which it may
// never do. A kill that leaves no time for it leaves the folder to the daemon's sweep.
export const removingOnEnd = (folder: string, argv: string[]): string[] => [
  "/bin/sh",
  "-c",
  `trap 'rm -rf "$0"' EXIT; exec 3<&0; "$@" <&3 3<&- & agent=$!; exec 3<&-
for s in HUP INT TERM; do trap "kill -TERM $agent 2> /dev/null; exit 1" $s; done
wait $agent`,
  folder,
  ...argv,
];
