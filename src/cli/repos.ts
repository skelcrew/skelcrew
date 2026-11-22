// The commands for the repositories Skelcrew works on: sc init and sc repo.
import { runByAgent } from "../agents/sandbox.ts";
import { usage } from "./input.ts";
import { leadCommand } from "./screen.ts";

export async function repoCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const { askForRepositories } = await import("../client.ts");
  const { openDb } = await import("../db.ts");
  const { listRepositories, printRepositories } = await import("../flow/list.ts");
  const { addRepo, initRepo, removeRepo, trustRepo } = await import("../flow/repo.ts");
  if (command === "init" && args.length === 1) {
    if (await initRepo("skelcrew")) await leadCommand(false);
    return;
  }
  if (sub === "add" && rest.length <= 1) {
    const added = await addRepo(rest[0], "skelcrew");
    if (added) console.log(`Added ${added.owner}/${added.repo}, as ${added.name}.`);
    return;
  }
  if (sub === "ls" && rest.length === 0) {
    if (runByAgent()) return printRepositories(await askForRepositories(), json);
    const db = openDb();
    printRepositories(listRepositories(db), json);
    if (json) return;
    const { notifyProblems } = await import("../flow/notify.ts");
    for (const problem of notifyProblems(db)) console.log(problem);
    return;
  }
  if (sub === "rm" && rest[0] && rest.length === 1) {
    console.log(await removeRepo(rest[0], "skelcrew"));
    return;
  }
  if (sub === "trust" && rest[0] && rest.length === 1) {
    await trustRepo(rest[0]);
    return;
  }
  usage(command);
}
