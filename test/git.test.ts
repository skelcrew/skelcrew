// Skelcrew's own clones of a repository never start git's background maintenance, nor write a
// commit graph after a fetch. Either could leave a lock file that a clone from Skelcrew's clone
// trips over while it copies the clone's files.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepository, fetchInto, updateClone } from "../src/flow/git.ts";
import { git, read } from "./harness.ts";

let folder = "";
let savedGlobal: string | undefined;
// A repository with no forge, so git runs with no login and the database is never asked.
const repository = () => ({
  name: "app",
  owner: "simon",
  repo: "app",
  forge: null,
  remote: join(folder, "app"),
});
// The commands git ran and the programs they started, from git's trace.
const ran = () =>
  read(join(folder, "trace"))
    .split("\n")
    .filter((line) => / (cmd_name|child_start\[\d+\]) /.test(line))
    .join("\n");
// Whether git wrote a commit graph in the clone, as a fetch does when your settings ask for one.
const graphed = (clone: string) =>
  existsSync(join(clone, ".git", "objects", "info", "commit-graphs"));

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "skelcrew-git-test-"));
  git(folder, "init", "-q", "app");
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "one");
  // git writes its trace where a global setting says, and the code under test hands its git
  // this process's environment. Your own settings may ask each fetch for a commit graph.
  writeFileSync(
    join(folder, "gitconfig"),
    `[trace2]\n\tnormalTarget = ${join(folder, "trace")}\n[fetch]\n\twriteCommitGraph = true\n`,
  );
  savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = join(folder, "gitconfig");
});

afterEach(() => {
  if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
  rmSync(folder, { recursive: true, force: true });
});

test("cloning and fetching into Skelcrew's clone start no background maintenance", async () => {
  const db = new Database(":memory:");
  const clone = join(folder, "clone");
  await cloneRepository(db, repository(), clone);
  // Each fetch brings something new, as git starts maintenance only after fetching.
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "two");
  await updateClone(db, repository(), clone);
  git(join(folder, "app"), "checkout", "-q", "-b", "topic");
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "three");
  await fetchInto(db, repository(), clone, "topic");
  expect(ran()).toContain("cmd_name fetch");
  expect(ran()).not.toContain("maintenance");
  expect(graphed(clone)).toBe(false);
});

test("git run by anyone else in Skelcrew's clone starts no background maintenance either", async () => {
  const db = new Database(":memory:");
  const clone = join(folder, "clone");
  await cloneRepository(db, repository(), clone);
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "two");
  // Such as a lead looking for what changed. Bun hands a program the environment this process
  // started with unless told otherwise.
  Bun.spawnSync(["git", "-C", clone, "fetch", "-q", "origin"], { env: process.env });
  expect(ran()).toContain("cmd_name fetch");
  expect(ran()).not.toContain("maintenance");
  expect(graphed(clone)).toBe(false);
});

test("a clone Skelcrew made before keeps maintenance off too, once Skelcrew updates it", async () => {
  const db = new Database(":memory:");
  const clone = join(folder, "clone");
  git(folder, "clone", "-q", join(folder, "app"), clone);
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "two");
  await updateClone(db, repository(), clone);
  git(join(folder, "app"), "commit", "-q", "--allow-empty", "-m", "three");
  Bun.spawnSync(["git", "-C", clone, "fetch", "-q", "origin"], { env: process.env });
  expect(ran()).toContain("cmd_name fetch");
  expect(ran()).not.toContain("maintenance");
  expect(graphed(clone)).toBe(false);
});
