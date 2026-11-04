// skel's command line: reads the command and hands it to the file that does it.
import { attachToLead, serve } from "./daemon.ts";
import { listRepos, removeRepo } from "./repo.ts";
import { firstRun } from "./setup.ts";

const usage = `Usage:
  skel
  skel serve
  skel repo ls
  skel repo rm <name>`;

async function run(args: string[]): Promise<void> {
  if (args.length === 0) {
    firstRun();
    await attachToLead("skel");
    return;
  }
  const [command, sub, ...rest] = args;
  if (command === "serve" && args.length === 1) {
    await serve("skel");
    return;
  }
  if (command === "repo" && sub === "ls" && rest.length === 0) {
    listRepos();
    return;
  }
  if (command === "repo" && sub === "rm" && rest[0] && rest.length === 1) {
    removeRepo(rest[0]);
    return;
  }
  console.error(usage);
  process.exit(1);
}

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
