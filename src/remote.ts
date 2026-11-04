// skel --remote: runs a skel command on your server over ssh -t, from your laptop, and
// offers to copy skel there when it is missing. Your laptop can be a Mac, so this file
// loads nothing of the skel that runs on the server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { originHere } from "./origin.ts";

// A command over ssh gets a bare PATH: no login shell reads ~/.profile, and Ubuntu's
// ~/.bashrc stops early when nobody types into it. So ~/.local/bin, where skel copies
// itself and where Claude Code installs, is added here. env, since every shell runs it the
// same way.
const onServer = 'env PATH="$HOME/.local/bin:$PATH" skel';

// Returns a word the server's shell reads back exactly as given. ssh joins its words with
// spaces into one line for that shell, so a space, quote or $ would split or expand it.
const quoted = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

// Runs a program with your terminal, so ssh can ask for a password and attach, and returns
// its exit code.
const run = (argv: string[]) =>
  Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"] }).exited;

// Runs a skel command on the host and returns its exit code. Plain skel passes the
// repository you are in on the laptop, so the lead knows it too. When the host has no
// skel, offers to copy it there, then runs the command.
export async function remote(host: string, args: string[]): Promise<number> {
  const from = args.length === 0 ? originHere() : null;
  const line = [onServer, ...(from ? ["--from", from] : args).map(quoted)].join(" ");
  const code = await run(["ssh", "-t", host, line]);
  // The server's shell exits 127 when it finds no skel to run. skel itself never does: it
  // exits 1 on any error.
  if (code !== 127) return code;
  console.log(`skel isn't installed on ${host}.`);
  const answer = prompt("Copy it to ~/.local/bin/skel there? [y/N]");
  if (!["y", "yes"].includes(answer?.trim().toLowerCase() ?? "")) {
    console.log(`skel isn't on ${host}, so the command didn't run.`);
    return 1;
  }
  await copySkel(host);
  return run(["ssh", "-t", host, line]);
}

// Builds skel as one file for the server, which is Linux on x64 whatever the laptop runs,
// and copies it to the host's ~/.local/bin. Built from this checkout each time, so the
// server gets the skel you run here.
async function copySkel(host: string): Promise<void> {
  // A single-file skel runs its modules from a folder only it sees, with no sources to
  // build from.
  if (import.meta.dir.startsWith("/$bunfs"))
    throw new Error("this skel is a single file and can't build one: run skel from a checkout");
  const folder = mkdtempSync(join(tmpdir(), "skel-"));
  try {
    const file = join(folder, "skel");
    console.log("Building skel for Linux.");
    const main = join(import.meta.dir, "main.ts");
    const target = "--target=bun-linux-x64";
    if ((await run(["bun", "build", "--compile", target, main, "--outfile", file])) !== 0)
      throw new Error("bun build failed, so skel wasn't copied");
    // scp writes through a link, so a link left there, such as one to a checkout's launcher
    // that can't find bun over ssh, would have the checkout's own file overwritten. Removing
    // it first leaves the file it points to alone.
    if ((await run(["ssh", host, "mkdir -p .local/bin && rm -f .local/bin/skel"])) !== 0)
      throw new Error(`couldn't make ~/.local/bin on ${host}, so skel wasn't copied`);
    if ((await run(["scp", file, `${host}:.local/bin/skel`])) !== 0)
      throw new Error(`scp couldn't copy skel to ${host}`);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
