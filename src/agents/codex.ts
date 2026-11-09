// How Codex runs inside the sandbox. For now skel runs it only as the reviewer, once per
// review, with skel's own login in its CODEX_HOME.
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.ts";
import { throwaway } from "./sandbox.ts";

// Returns Codex's review command, mounts and environment, protecting instructions shared by
// reviews. The command reads the review's prompt on stdin and the answer's shape from the
// review's folder. skel's Codex folder holds what Codex reads as instructions, and every review
// shares it. So the reviewer sees it as a throwaway folder, and only its login and sessions
// reach the real one. Codex saves its login by rewriting auth.json in place, not by renaming
// a new file over it, so the file itself can be mounted and a renewal still reaches skel's.
async function review(given: {
  home: string;
  folder: string;
  model?: string | undefined;
  sprite: boolean;
  signal: AbortSignal;
}) {
  const { home, folder, model, sprite, signal } = given;
  const codexHome = join(dataDir(home), "codex");
  const sessions = join(codexHome, "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const copy = join(folder, "codex");
  const { mounts, at } = await throwaway({
    source: codexHome,
    copy,
    sprite,
    signal,
    kept: ["sessions", "auth.json"],
  });
  mounts.push("--bind", sessions, sessions);
  const auth = join(codexHome, "auth.json");
  if (existsSync(auth)) mounts.push("--bind", auth, auth);
  // A copy at another path can't have the real ones mounted into it, so it links to them.
  if (at !== codexHome) {
    symlinkSync(sessions, join(at, "sessions"));
    if (existsSync(auth)) symlinkSync(auth, join(at, "auth.json"));
  }
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
