// Updates: a release of Skelcrew installs the latest release over itself in the background, and the
// sidebar says so until Skelcrew runs on it. A build from a checkout never does: git pull updates
// it.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dataDir } from "../paths.ts";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { isRelease, release, releases, singleFile } from "../version.ts";

// Where the daemon notes the release it installed, for the sidebar's notice. It holds the
// release followed by a line end.
const installedFile = () => join(dataDir(), "installed");

// The release file for this machine, named as the install script names it. A Mac running sc
// through Rosetta asks for the x64 file again, which is the one it already runs.
const asset = `skelcrew-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;

// Downloads an address, or throws naming it.
async function download(address: string): Promise<Response> {
  const response = await fetch(address);
  if (!response.ok) throw new Error(`couldn't download ${address} (${response.status})`);
  return response;
}

// Returns the SHA-256 of a file, read in pieces, as Skelcrew is about 100 MB and the daemon has
// no reason to hold it all.
async function fileSum(file: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const piece of Bun.file(file).stream()) hasher.update(piece);
  return hasher.digest("hex");
}

// Returns the SHA-256 the release at `at`, the folder its files are in, such as
// .../download/v0.4.2, lists for its file `name`. Read just before the download, so a new
// release can't slip between.
export async function releaseSum(at: string, name: string): Promise<string> {
  const sums = await (await download(`${at}/SHA256SUMS`)).text();
  const want = sums
    .split("\n")
    .find((line) => line.endsWith(`  ${name}`))
    ?.split("  ")[0];
  if (!want) throw new Error(`the release has no checksum for ${name}`);
  return want;
}

// Downloads the file `name` of the release at `at` and checks it against `want`, its
// checksum, as the install script does, so a broken or changed download is never used.
export async function downloadRelease(at: string, name: string, want: string) {
  const bytes = await (await download(`${at}/${name}`)).arrayBuffer();
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== want)
    throw new Error(`the download of ${name} failed its checksum, so it wasn't used`);
  return bytes;
}

// Installs the latest release over the Skelcrew at `file`, from the releases at `base`, laid out
// as the install script expects, and returns the release it installed. Returns null when that
// file already is the latest. Like the install script, it starts the download once before it
// goes in, so a broken download never replaces a Skelcrew that works. It is staged beside `file`
// and renamed over it: macOS kills a program whose file was written over in place, and the
// running daemon keeps the old file until it restarts.
export async function installLatest(file: string, base: string): Promise<string | null> {
  const at = `${base}/latest/download`;
  const want = await releaseSum(at, asset);
  // Comparing sums costs only the small checksums file.
  if ((await fileSum(file)) === want) return null;
  const bytes = await downloadRelease(at, asset, want);
  const staged = join(dirname(file), `.sc-update-${process.pid}`);
  try {
    await Bun.write(staged, bytes);
    chmodSync(staged, 0o755);
    const started = await quietly([staged, "--version"]);
    const version = started.out.match(/^skelcrew (\d+\.\d+\.\d+)$/m)?.[1];
    if (!started.ok || !version)
      throw new Error(
        `the latest release won't start here, so it wasn't installed: ${started.said}`,
      );
    renameSync(staged, file);
    mkdirSync(dataDir(), { recursive: true });
    await Bun.write(installedFile(), `${version}\n`);
    return version;
  } finally {
    rmSync(staged, { force: true });
  }
}

// Keeps a release of Skelcrew at the latest release, for the daemon: looks now, then every hour,
// and logs what it did. A new release most days makes an hour soon enough, and a look costs
// one small download. The note of an earlier install goes, as this daemon runs on whatever is
// installed now. A build from a checkout, or a Skelcrew that isn't one file, is left alone.
export function keepUpToDate(): void {
  rmSync(installedFile(), { force: true });
  if (!release || !singleFile) return;
  const look = () =>
    installLatest(process.execPath, releases).then(
      (installed) => {
        if (installed) console.log(`installed Skelcrew ${installed}. It runs from the next sc.`);
      },
      (error) => console.log(`couldn't update Skelcrew: ${errorText(error)}`),
    );
  look();
  setInterval(look, 60 * 60 * 1000);
}

// Returns the sidebar's notice of a release installed in the background, or nothing when Skelcrew
// already runs on it. Read each time the sidebar looks, as the daemon can install one at any
// moment.
export function updateNotice(): string {
  let text = "";
  try {
    text = readFileSync(installedFile(), "utf8").trim();
  } catch {}
  const installed = z.string().refine(isRelease).safeParse(text);
  if (!installed.success || installed.data === release) return "";
  return `Skelcrew ${installed.data} installed · restart to use it`;
}
