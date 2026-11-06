// The release build, run with a stand-in for bun that writes a small file in place of each
// binary, and the workflow that runs it on a version tag.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const root = join(import.meta.dir, "..");
const script = join(root, "scripts", "build-release.ts");
const assets = ["skel-darwin-arm64", "skel-darwin-x64", "skel-linux-arm64", "skel-linux-x64"];

let home = "";

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skel-release-test-")));
  mkdirSync(join(home, "fakes"));
  writeFileSync(
    join(home, "fakes", "bun"),
    `#!/bin/sh
echo "$*" >> "${home}/calls"
test -f "${home}/bun-fails" && exit 1
while test $# -gt 1; do
  test "$1" = --outfile && echo "built $*" > "$2"
  shift
done
exit 0
`,
    { mode: 0o755 },
  );
  git("init", "--quiet", "--initial-branch=main");
  commit("Start");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Runs git in the repository a release is built from.
function git(...args: string[]): void {
  const argv = ["git", "-C", home, "-c", "user.name=t", "-c", "user.email=t@t", ...args];
  const done = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (!done.success) throw new Error(done.stderr.toString());
}

const commit = (subject: string) => git("commit", "--quiet", "--allow-empty", "-m", subject);

// Runs the release build for a version, and returns what it said.
function build(version: string) {
  const done = Bun.spawnSync([process.execPath, script, version], {
    cwd: home,
    env: { PATH: `${join(home, "fakes")}:/usr/bin:/bin`, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: done.exitCode, err: done.stderr.toString() };
}

const dist = (name: string) => readFileSync(join(home, "dist", name), "utf8");

test("builds all four binaries, stamped with the release", () => {
  const done = build("0.4.2");
  expect(done.err).toBe("");
  expect(done.code).toBe(0);
  const calls = readFileSync(join(home, "calls"), "utf8");
  for (const target of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]) {
    expect(calls).toMatch(new RegExp(`--target=bun-${target}\\S* `));
    expect(existsSync(join(home, "dist", `skel-${target}`))).toBe(true);
  }
  expect(calls.match(/--define SKEL_BUILD="0\.4\.2"/g)).toHaveLength(4);
  expect(calls.match(/ \S+\/src\/main\.ts /g)).toHaveLength(4);
});

test("lists each binary's checksum the way sha256sum and the install script read it", () => {
  build("0.4.2");
  const sums = assets.map((name) => {
    const hash = new Bun.CryptoHasher("sha256").update(dist(name)).digest("hex");
    return `${hash}  ${name}\n`;
  });
  expect(dist("SHA256SUMS")).toBe(sums.join(""));
});

test("a stray .env or bunfig.toml beside a user's project can't reach the binaries", () => {
  build("0.4.2");
  const calls = readFileSync(join(home, "calls"), "utf8");
  expect(calls.match(/--no-compile-autoload-dotenv/g)).toHaveLength(4);
  expect(calls.match(/--no-compile-autoload-bunfig/g)).toHaveLength(4);
});

test("the release notes list what changed since the last release", () => {
  git("tag", "v0.4.1");
  commit("Add the old thing");
  git("tag", "v0.4.2");
  commit("Fix the login redirect (#80)");
  commit("Say which release you have (#81)");
  git("tag", "v0.4.3");
  build("0.4.3");
  expect(dist("notes.md")).toBe(
    "- Say which release you have (#81)\n- Fix the login redirect (#80)\n",
  );
});

test("the first release says so, instead of listing all of history", () => {
  commit("Something early");
  build("0.1.0");
  expect(dist("notes.md")).toBe("The first release of skel.\n");
});

test("anything but a plain release number is refused, as skel couldn't tell it from a commit", () => {
  for (const version of ["", "v0.4.2", "0.4", "0.4.2-beta", "39939b0"]) {
    const done = build(version);
    expect(done.code).not.toBe(0);
    expect(done.err).toContain("0.4.2");
  }
  expect(existsSync(join(home, "calls"))).toBe(false);
});

test("a binary that fails to build fails the release, leaving nothing to publish", () => {
  writeFileSync(join(home, "bun-fails"), "");
  const done = build("0.4.2");
  expect(done.code).not.toBe(0);
  expect(done.err).toContain("darwin-arm64");
  expect(existsSync(join(home, "dist", "SHA256SUMS"))).toBe(false);
});

test("a build leaves no binaries of an earlier one behind", () => {
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist", "skel-old"), "");
  build("0.4.2");
  expect(readdirSync(join(home, "dist")).sort()).toEqual(
    [...assets, "SHA256SUMS", "notes.md"].sort(),
  );
});

const Workflow = z.object({
  on: z.object({ push: z.object({ tags: z.array(z.string()) }) }),
  env: z.object({ RELEASES_REPO: z.string() }),
  jobs: z.object({
    release: z.object({
      steps: z.array(z.object({ run: z.string().optional() })),
    }),
  }),
});

test("the workflow runs on a version tag, checks, builds, then publishes all the files", () => {
  const text = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const workflow = Workflow.parse(parse(text));
  expect(workflow.on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
  const runs = workflow.jobs.release.steps.flatMap((step) => (step.run ? [step.run] : []));
  const at = (words: string) => runs.findIndex((run) => run.includes(words));
  expect(at("bun run check")).toBeGreaterThan(-1);
  expect(at("scripts/build-release.ts")).toBeGreaterThan(at("bun run check"));
  expect(at("gh release create")).toBeGreaterThan(at("scripts/build-release.ts"));
  const publish = runs[at("gh release create")];
  expect(publish).toContain('--repo "$RELEASES_REPO"');
  expect(publish).toContain("--notes-file dist/notes.md");
  expect(publish).toContain("dist/skel-*");
  expect(publish).toContain("dist/SHA256SUMS");
  for (const run of runs) expect(Bun.spawnSync(["sh", "-n", "-c", run]).success).toBe(true);
});
