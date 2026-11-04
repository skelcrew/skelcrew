// skel's command line: reads the command and hands it to the file that does it.
import { attachToLead, fileIssue, serve, startOn } from "./daemon.ts";
import { bringInFrom, listRepos, removeRepo, trustRepo } from "./repo.ts";
import { firstRun } from "./setup.ts";

const usage = `Usage:
  skel [--from <owner/repo>]
  skel serve
  skel repo ls
  skel repo rm <name>
  skel trust <name>
  skel issue <repo> "<title>" "<body>"
  skel start <repo>#<issue> [--from <branch>]`;

// Runs the requested CLI command, or prints usage and exits when its arguments are invalid.
// With no command, sets up skel and attaches you to the lead.
async function run(args: string[]): Promise<void> {
  const [command, sub, ...rest] = args;
  if (args.length === 0 || (command === "--from" && sub && rest.length === 0)) {
    firstRun();
    await bringInFrom(sub);
    await attachToLead("skel");
    return;
  }
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
  if (command === "trust" && sub && rest.length === 0) {
    await trustRepo(sub);
    return;
  }
  if (command === "issue" && sub && rest[0] && rest[1] !== undefined && rest.length === 2) {
    console.log(await fileIssue(sub, rest[0], rest[1]));
    return;
  }
  const thread = sub?.match(/^(.+)#(\d+)$/);
  const from = rest[0] === "--from" && rest[1] && rest.length === 2 ? rest[1] : undefined;
  if (command === "start" && thread?.[1] && (rest.length === 0 || from)) {
    console.log(`Started ${await startOn(thread[1], Number(thread[2]), from)}.`);
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
