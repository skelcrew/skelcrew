// Updates: a release of Skelcrew installs the latest release over itself in the background, notes
// it in the database, and the list says so until Skelcrew runs on it. A build from a checkout never
// does: git pull updates it.
import type { Database } from "bun:sqlite";
import { chmodSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { quietly } from "../run.ts";
import { errorText } from "../say.ts";
import { isRelease, release, releases, singleFile } from "../version.ts";

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
  // Each line is a checksum, two spaces and a file's name, as sha256sum writes it.
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
export async function installLatest(
  file: string,
  base: string,
  db: Database,
): Promise<string | null> {
  const at = `${base}/latest/download`;
  const want = await releaseSum(at, asset);
  // Comparing sums costs only the small checksums file.
  if ((await fileSum(file)) === want) return null;
  const bytes = await downloadRelease(at, asset, want);
  // Staged in the same folder, as a rename can't cross disks.
  const staged = join(dirname(file), `.sc-update-${process.pid}`);
  try {
    await Bun.write(staged, bytes);
    chmodSync(staged, 0o755);
    // Starting it proves it runs on this machine, and its version line gives the release
    // for the note.
    const started = await quietly([staged, "--version"]);
    const version = started.out.match(/^skelcrew (\d+\.\d+\.\d+)$/m)?.[1];
    if (!started.ok || !version)
      throw new Error(
        `the latest release won't start here, so it wasn't installed: ${started.said}`,
      );
    renameSync(staged, file);
    // Noted only once it is in place, so the list never offers a restart into a release that
    // isn't there.
    db.run("DELETE FROM installed");
    db.run("INSERT INTO installed (release) VALUES (?)", [version]);
    return version;
  } finally {
    // Only a staged file that never went in is still there.
    rmSync(staged, { force: true });
  }
}

// Keeps a release of Skelcrew at the latest release, for the daemon: looks now, then every hour,
// and logs what it did. A new release most days makes an hour soon enough, and a look costs
// one small download. The note of an earlier install goes, as this daemon runs on whatever is
// installed now. A build from a checkout, or a Skelcrew that isn't one file, is left alone.
export function keepUpToDate(db: Database): void {
  db.run("DELETE FROM installed");
  if (!release || !singleFile) return;
  // A failed look is only logged, as the next one an hour later tries again.
  const look = () =>
    installLatest(process.execPath, releases, db).then(
      (installed) => {
        if (installed) console.log(`installed Skelcrew ${installed}. It runs from the next sc.`);
      },
      (error) => console.log(`couldn't update Skelcrew: ${errorText(error)}`),
    );
  look();
  setInterval(look, 60 * 60 * 1000);
}

// Returns the notice of a release installed in the background, for the list and the sidebar, or
// nothing when Skelcrew already runs on it. Read from the database each time they look, as the
// daemon can install one at any moment.
export function updateNotice(db: Database): string {
  const row = db.query("SELECT release FROM installed").get();
  const text = z.object({ release: z.string() }).nullable().catch(null).parse(row)?.release ?? "";
  // A note that isn't a release number shows nothing.
  const installed = z.string().refine(isRelease).safeParse(text);
  if (!installed.success || installed.data === release) return "";
  return `Skelcrew ${installed.data} installed · restart to use it`;
}
