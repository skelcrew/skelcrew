// How Codex runs inside the sandbox. For now skel runs it only as the reviewer, once per
// review, with skel's own login, shared through its CODEX_HOME.
import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.ts";
import { throwaway } from "./sandbox.ts";

// Puts skel's Codex login in a folder of its own, holding only auth.json and auth.lock, and
// links them from skel's CODEX_HOME, moving a login found there in first. Returns the folder,
// which every Codex sandbox gets writable. From 0.167 Codex renews its login by renaming a
// new auth.json over the old one, beside the file a link leads to. A file mounted on its own
// can't be renamed over, and by then the old refresh token is spent, which would leave skel's
// login stale. Its lock is shared the same way, so two renewals take turns.
function shareLogin(home: string): string {
  const codexHome = join(dataDir(home), "codex");
  const login = join(dataDir(home), "codex-login");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(login, { recursive: true, mode: 0o700 });
  for (const file of ["auth.json", "auth.lock"]) {
    const at = join(codexHome, file);
    const found = lstatSync(at, { throwIfNoEntry: false });
    if (found?.isSymbolicLink()) continue;
    // The first run's codex login writes a plain auth.json here.
    if (found) renameSync(at, join(login, file));
    symlinkSync(join(login, file), at);
  }
  return login;
}

// Returns Codex's review command, mounts and environment, protecting instructions shared by
// reviews. The command reads the review's prompt on stdin and the answer's shape from the
// review's folder. skel's Codex folder holds what Codex reads as instructions, and every review
// shares it. So the reviewer sees it as a throwaway folder, and only its sessions and the
// login folder reach the real ones.
async function review(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  sprite: boolean;
  signal: AbortSignal;
}) {
  const { home, folder, model, sprite, signal } = given;
  const codexHome = join(dataDir(home), "codex");
  const login = shareLogin(home);
  const sessions = join(codexHome, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const copy = join(folder, "codex");
  const { mounts, at } = await throwaway({
    source: codexHome,
    copy,
    sprite,
    signal,
    kept: ["sessions"],
  });
  mounts.push("--bind", sessions, sessions, "--bind", login, login);
  // A copy at another path can't have the real one mounted into it, so it links to it.
  if (at !== codexHome) symlinkSync(sessions, join(at, "sessions"));
  // --no-daemon belongs to codex itself, not to exec: without it Codex may start a
  // background server that outlives the review.
  const command = ["codex", "--no-daemon", "exec", "--dangerously-bypass-approvals-and-sandbox"];
  // With none named, Codex runs on its own default.
  if (model) command.push("-m", model);
  command.push("--output-schema", join(folder, "schema.json"), "-o", join(folder, "answer.json"));
  command.push("-");
  return { command, mounts, env: { CODEX_HOME: at } };
}

// Returns the reviewer's answer from the file Codex wrote it to, for the reviewer to check
// against the shape. Read only after Codex ends, so it can't change the file meanwhile.
function answer(folder: string): unknown {
  const file = join(folder, "answer.json");
  if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error("it gave no answer");
  return JSON.parse(readFileSync(file, "utf8"));
}

// Codex as skel knows it. codex exec reads CODEX_API_KEY: given only OPENAI_API_KEY, it sent
// no key at all, so both get into the sandbox for those who use a key rather than a login.
export const codex = {
  name: "codex",
  title: "Codex",
  keys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  review,
  answer,
} as const;
