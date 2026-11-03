// skel's command line: reads the command and hands it to the file that does it.
import { initRepo, listRepos, removeRepo } from "./repo.ts";
import { firstRun } from "./setup.ts";

const usage = `Usage:
  skel
  skel init [<path>] [--name <name>]
  skel repo ls
  skel repo rm <name>`;

function run(args: string[]): void {
  if (args.length === 0) {
    firstRun();
    return;
  }
  const [command, sub, ...rest] = args;
  if (command === "init") {
    const given = args.slice(1);
    const at = given.indexOf("--name");
    const name = at === -1 ? undefined : given[at + 1];
    const paths = at === -1 ? given : given.filter((_, i) => i !== at && i !== at + 1);
    if (paths.length <= 1 && (at === -1 || name)) {
      initRepo(paths[0] ?? ".", name);
      return;
    }
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
  run(process.argv.slice(2));
} catch (error) {
  console.error(`skel: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
