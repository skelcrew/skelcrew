// The release build, run with a stand-in for bun that writes a small file in place of each
// binary, and the workflow that runs it on a version tag, with its signing and checksum steps
// run for real against stand-ins.
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
const assets = [
  "skelcrew-darwin-arm64",
  "skelcrew-darwin-x64",
  "skelcrew-linux-arm64",
  "skelcrew-linux-x64",
];

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
    expect(existsSync(join(home, "dist", `skelcrew-${target}`))).toBe(true);
  }
  expect(calls.match(/--define SKELCREW_BUILD="0\.4\.2"/g)).toHaveLength(4);
  expect(calls.match(/ \S+\/src\/main\.ts /g)).toHaveLength(4);
});

test("each binary knows where releases live, from the one line in the install script", () => {
  build("0.4.2");
  const install = readFileSync(join(root, "install.sh"), "utf8");
  const releases = install.match(/SKELCREW_DOWNLOAD_BASE:-([^}]+)}/)?.[1];
  const calls = readFileSync(join(home, "calls"), "utf8");
  expect(calls.split(`--define SKELCREW_RELEASES="${releases}"`)).toHaveLength(5);
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
  expect(existsSync(join(home, "dist", "notes.md"))).toBe(false);
});

test("a build leaves nothing of an earlier one behind, and no checksums to go stale", () => {
  mkdirSync(join(home, "dist"));
  writeFileSync(join(home, "dist", "skel-old"), "");
  writeFileSync(join(home, "dist", "SHA256SUMS"), "");
  build("0.4.2");
  expect(readdirSync(join(home, "dist")).sort()).toEqual([...assets, "notes.md"].sort());
});

const Step = z.object({
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.looseObject({ name: z.string().optional(), path: z.string().optional() }).optional(),
});
const Steps = z.array(Step);
type Steps = z.infer<typeof Steps>;

const Workflow = z.object({
  on: z.object({ push: z.object({ tags: z.array(z.string()) }) }),
  env: z.object({ RELEASES_REPO: z.string() }),
  jobs: z.object({
    build: z.object({ steps: Steps }),
    sign: z.object({
      needs: z.string(),
      "runs-on": z.string(),
      strategy: z.object({
        matrix: z.object({
          include: z.array(z.object({ binary: z.string(), runner: z.string() })),
        }),
      }),
      steps: Steps,
    }),
    publish: z.object({ needs: z.string(), steps: Steps }),
  }),
});

const workflowText = () => readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
const workflow = () => Workflow.parse(parse(workflowText()));
const runs = (steps: Steps) => steps.flatMap((step) => (step.run ? [step.run] : []));
const uploads = (steps: Steps) => steps.filter((step) => step.uses?.includes("upload-artifact"));

// Returns the one step that runs a command, to run it here the way a runner would.
function stepRunning(steps: Steps, words: string): string {
  const found = runs(steps).filter((run) => run.includes(words));
  expect(found).toHaveLength(1);
  return found[0] ?? "";
}

// Runs a workflow step the way GitHub does, in the test's folder, with only the fakes on hand.
function runStep(step: string) {
  const done = Bun.spawnSync(["bash", "-e", "-c", step], {
    cwd: home,
    env: {
      PATH: `${join(home, "fakes")}:/usr/bin:/bin`,
      BINARY: "skelcrew-darwin-arm64",
      GITHUB_REF_NAME: "v0.4.2",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return done.exitCode;
}

// Runs the signing step on a stand-in Mac binary that reports `version`, with a stand-in
// codesign running `script`. The binary starts without its executable mode, as a binary passed
// between jobs does. Returns the step's exit code and what codesign was asked to do.
function sign(script: string, version = "skelcrew 0.4.2") {
  writeFileSync(
    join(home, "fakes", "codesign"),
    `#!/bin/sh\necho "$*" >> "${home}/signing"\n${script}\nexit 0\n`,
    { mode: 0o755 },
  );
  mkdirSync(join(home, "dist"));
  writeFileSync(
    join(home, "dist", "skelcrew-darwin-arm64"),
    `#!/bin/sh\necho "$*" >> "${home}/started"\necho "${version}"\n`,
    { mode: 0o644 },
  );
  const code = runStep(stepRunning(workflow().jobs.sign.steps, "codesign"));
  const signing = existsSync(join(home, "signing"))
    ? readFileSync(join(home, "signing"), "utf8").trim().split("\n")
    : [];
  return { code, signing, started: existsSync(join(home, "started")) };
}

test("the workflow runs on a version tag, checks, builds, signs, then publishes all the files", () => {
  const { on, jobs } = workflow();
  expect(on.push.tags).toEqual(["v[0-9]+.[0-9]+.[0-9]+"]);
  const built = runs(jobs.build.steps);
  const at = (words: string) => built.findIndex((run) => run.includes(words));
  expect(at("bun run check")).toBeGreaterThan(-1);
  expect(at("scripts/build-release.ts")).toBeGreaterThan(at("bun run check"));
  expect(jobs.sign.needs).toBe("build");
  expect(jobs.publish.needs).toBe("sign");
  const published = runs(jobs.publish.steps);
  const publish = stepRunning(jobs.publish.steps, "gh release create");
  expect(published.indexOf(publish)).toBeGreaterThan(
    published.indexOf(stepRunning(jobs.publish.steps, "sha256sum")),
  );
  expect(publish).toContain('--repo "$RELEASES_REPO"');
  expect(publish).toContain("--notes-file dist/notes.md");
  expect(publish).toContain("dist/skelcrew-*");
  expect(publish).toContain("dist/SHA256SUMS");
  const all = [...built, ...runs(jobs.sign.steps), ...published];
  for (const run of all) expect(Bun.spawnSync(["sh", "-n", "-c", run]).success).toBe(true);
});

test("each Mac binary is signed on a Mac with its own CPU, so it can be started there", () => {
  const { sign } = workflow().jobs;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub's syntax, not JavaScript's.
  expect(sign["runs-on"]).toBe("${{ matrix.runner }}");
  expect(sign.strategy.matrix.include).toEqual([
    { binary: "skelcrew-darwin-arm64", runner: "macos-26" },
    { binary: "skelcrew-darwin-x64", runner: "macos-26-intel" },
  ]);
});

test("signing replaces the signature, checks it, then starts the binary", () => {
  const done = sign("");
  expect(done.code).toBe(0);
  expect(done.signing).toEqual([
    "--force --sign - dist/skelcrew-darwin-arm64",
    "--verify --strict --verbose=2 dist/skelcrew-darwin-arm64",
  ]);
  expect(done.started).toBe(true);
});

test("a binary that can't be signed stops the release", () => {
  const done = sign('test "$1" = --force && exit 1');
  expect(done.code).not.toBe(0);
  expect(done.signing).toHaveLength(1);
});

test("a signature that fails its check stops the release", () => {
  const done = sign('test "$1" = --verify && exit 1');
  expect(done.code).not.toBe(0);
  expect(done.started).toBe(false);
});

test("a signed binary that isn't this release stops the release", () => {
  expect(sign("", "skelcrew 0.4.1").code).not.toBe(0);
});

test("the release can only be given Mac binaries that went through signing", () => {
  const { build, sign, publish } = workflow().jobs;
  const download = publish.steps.find((step) => step.uses?.includes("download-artifact"));
  expect(download?.with?.pattern).toBe("publish-*");
  for (const upload of uploads(build.steps)) {
    const forRelease = upload.with?.name?.startsWith("publish-");
    expect(forRelease).toBe(!upload.with?.path?.includes("darwin"));
  }
  expect(uploads(sign.steps)[0]?.with?.name).toStartWith("publish-");
});

test("a binary missing when it is passed on fails the job, where GitHub would only warn", () => {
  const { build, sign } = workflow().jobs;
  const all = [...uploads(build.steps), ...uploads(sign.steps)];
  expect(all).toHaveLength(3);
  for (const upload of all) expect(upload.with?.["if-no-files-found"]).toBe("error");
});

test("lists each binary's checksum the way sha256sum and the install script read it", () => {
  mkdirSync(join(home, "dist"));
  for (const name of assets) writeFileSync(join(home, "dist", name), `signed ${name}`);
  const sums = assets.map((name) => {
    const hash = new Bun.CryptoHasher("sha256").update(dist(name)).digest("hex");
    return `${hash}  ${name}\n`;
  });
  expect(runStep(stepRunning(workflow().jobs.publish.steps, "sha256sum"))).toBe(0);
  expect(dist("SHA256SUMS")).toBe(sums.join(""));
});

test("a binary missing from the release fails the checksums", () => {
  mkdirSync(join(home, "dist"));
  for (const name of assets.slice(1)) writeFileSync(join(home, "dist", name), "signed");
  expect(runStep(stepRunning(workflow().jobs.publish.steps, "sha256sum"))).not.toBe(0);
});

test("the workflow and the install script are the only places that say where releases live", () => {
  const { RELEASES_REPO } = workflow().env;
  expect(workflowText().split(RELEASES_REPO)).toHaveLength(2);
  const install = readFileSync(join(root, "install.sh"), "utf8");
  expect(install.match(/https:\/\//g)).toHaveLength(1);
});
