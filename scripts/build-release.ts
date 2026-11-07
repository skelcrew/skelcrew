// The release build: makes skel for macOS and Linux, on arm64 and x64, from this one machine,
// with the release notes, into dist/. Run by the release workflow on a version tag, as
// bun scripts/build-release.ts 0.4.2. It publishes nothing. It makes no checksums, as the
// workflow signs the Mac binaries afterwards, and signing changes them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../src/say.ts";

// Each release file and the Bun target it is built for. On x64 the baseline build, which runs
// on every CPU: the plain one stops with "Illegal instruction" on a CPU or virtual machine
// without AVX2, and skel gains nothing from AVX2.
const targets = [
  ["skel-darwin-arm64", "bun-darwin-arm64"],
  ["skel-darwin-x64", "bun-darwin-x64-baseline"],
  ["skel-linux-arm64", "bun-linux-arm64"],
  ["skel-linux-x64", "bun-linux-x64-baseline"],
] as const;

const dist = "dist";
const main = join(import.meta.dir, "..", "src", "main.ts");

// Returns where releases live, from the install script's line that says so, so that moving them
// stays a change to that one line.
function releases(): string {
  const install = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
  const found = install.match(/SKEL_DOWNLOAD_BASE:-([^}]+)}/)?.[1];
  if (!found) throw new Error("install.sh doesn't say where releases live");
  return found;
}

// Builds one binary, stamped with its release and where releases live. By default a binary
// built by Bun reads any .env and bunfig.toml in the folder it runs in. skel runs in your
// projects, so a project's .env would land in skel's environment, and from there could reach
// the agents.
function compile(version: string, file: string, target: string): void {
  const argv = ["bun", "build", "--compile", `--target=${target}`];
  argv.push("--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig");
  argv.push("--define", `SKEL_BUILD=${JSON.stringify(version)}`);
  argv.push("--define", `SKEL_RELEASES=${JSON.stringify(releases())}`);
  argv.push(main, "--outfile", join(dist, file));
  const built = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (!built.success) throw new Error(`bun build failed for ${target}`);
}

// Returns the release notes: the subject of each commit since the last release. Each pull
// request lands as one commit, so these read as what changed. The first release has no last
// one, and all of history is no use to anyone.
function releaseNotes(): string {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  const last = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD^");
  if (!last.success) return "The first release of skel.\n";
  const since = `${last.stdout.toString().trim()}..HEAD`;
  return git("log", "--format=- %s", since).stdout.toString();
}

// Builds a whole release into a clean dist/, so nothing from an earlier build gets published.
function build(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`a release is three numbers, such as 0.4.2, not "${version}"`);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist);
  for (const [file, target] of targets) compile(version, file, target);
  writeFileSync(join(dist, "notes.md"), releaseNotes());
}

try {
  build(process.argv[2] ?? "");
} catch (error) {
  console.error(`skel: ${errorText(error)}`);
  process.exit(1);
}
