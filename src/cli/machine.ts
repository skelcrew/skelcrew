// The commands for this machine: plain sc, which opens the lead, the daemon, repositories,
// plugins and the parts of the screen.
import { runByAgent } from "../agents/sandbox.ts";
import { usage } from "./input.ts";

export async function leadCommand(list: boolean, from?: string): Promise<void> {
  const { attachToLead, upInBackground } = await import("../attach.ts");
  const { openDb } = await import("../db.ts");
  const { bringInFrom, checkoutTop, repositories } = await import("../flow/repo.ts");
  const { originHere } = await import("../machine/origin.ts");
  const { firstRun, install, installFinished } = await import("../machine/setup.ts");
  if (installFinished()) firstRun(from);
  else install(from, true);
  await upInBackground();
  const origin = originHere();
  if (from === undefined && origin === null && checkoutTop() !== null) {
    const { toRun } = await import("../say.ts");
    const steps = toRun(["git remote add origin <url>", "git push -u origin HEAD"]);
    console.log(`This git repository has no remote. To add a remote and push it:\n${steps}`);
    console.log("Then run sc again.");
    process.exit(1);
  }
  const found = await bringInFrom(from);
  const { tellOldKeys } = await import("../config.ts");
  tellOldKeys(undefined);
  if (repositories(openDb()).length === 0) return;
  const away = from === undefined && origin === null;
  if (await attachToLead("skelcrew", list, found, away)) return;
  console.error("No git repository found. Run sc inside a git repository to open it.");
  process.exit(1);
}

export async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "restart" && args.length === 1) {
    const { restartEngine } = await import("../attach.ts");
    await restartEngine();
    return;
  }
  const { serve } = await import("../flow/daemon.ts");
  if (command === "up" && args.length === 1) {
    await serve("skelcrew");
    return;
  }
  if (command === "up" && args.length === 2 && args[1] === "--bg") {
    const { setupDone } = await import("../machine/setup.ts");
    if (!setupDone()) throw new Error("the first run isn't done on this machine: run sc first");
    const { upInBackground } = await import("../attach.ts");
    const outside = await upInBackground();
    console.log(
      outside
        ? "Skelcrew's daemon already runs outside its service, such as with sc up in a terminal. Stop it to run it in the background."
        : "Skelcrew's daemon is running in the background.",
    );
    return;
  }
  if (command === "serve" && args.length === 1) {
    console.error("sc serve is now sc up, and sc serve will go in a later release.");
    await serve("skelcrew");
    return;
  }
  usage(command);
}

export async function screenCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { runSidebar } = await import("../screen/sidebar.ts");
  const { runFooter } = await import("../screen/footer.ts");
  if (command === "footer" && rest.length === 2) {
    const [agents, session] = rest;
    if (agents && session) {
      await runFooter(agents, session);
      return;
    }
  }
  if (command === "sidebar" && rest.length === 5) {
    const [agents, session, where, repository, onHost] = rest;
    if (agents && session && where !== undefined && repository && onHost !== undefined) {
      await runSidebar(agents, session, where, repository, onHost);
      return;
    }
  }
  if (command === "details" && rest.length === 3) {
    const [, repository, name] = rest;
    if (repository && name) {
      const { runTaskDetails } = await import("../screen/task.ts");
      await runTaskDetails(repository, name);
      return;
    }
  }
  usage(command);
}

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
    printRepositories(runByAgent() ? await askForRepositories() : listRepositories(openDb()), json);
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

export async function pluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, ...rest] = args;
  const { addPlugin, listPlugins, removeYourPlugin, setUpPlugin, updatePlugins } = await import(
    "../plugins/install.ts"
  );
  const yours = rest[0] === "-g";
  const [name, ...more] = yours ? rest.slice(1) : rest;
  if (command === "install") {
    const options = new Map<string, string>();
    for (let at = 0; at < rest.length; at += 2) {
      const [flag = "", value] = rest.slice(at, at + 2);
      if (!["--from", "--files"].includes(flag) || !value || options.has(flag)) usage(command);
      else options.set(flag, value);
    }
    const files = options.get("--files");
    if (files) {
      const { putSentFiles } = await import("../machine/your-files.ts");
      putSentFiles(files);
    }
    const { install } = await import("../machine/setup.ts");
    if (!install(options.get("--from"))) process.exitCode = 1;
    return;
  }
  if (command === "add" && name && more.length === 0 && !yours) {
    const { addRepositoryPlugin } = await import("../plugins/repository.ts");
    const added = addRepositoryPlugin(name);
    if (added) console.log(added);
    return;
  }
  if ((command === "remove" || command === "update") && !yours)
    throw new Error(
      `sc ${command} without -g is for a repository's plugins, which Skelcrew can't ${command} yet. sc ${command} -g is for your own`,
    );
  if (command === "add" && name && more.length === 0) {
    addPlugin(name);
    return;
  }
  if (command === "remove" && name && more.length === 0) {
    const { repositoryNeeds } = await import("../plugins/repository.ts");
    return removeYourPlugin(name, repositoryNeeds(true));
  }
  if (command === "update" && more.length === 0) return updatePlugins(name);
  if (command === "setup" && rest[0] && rest.length === 1) {
    const { originHere } = await import("../machine/origin.ts");
    setUpPlugin(rest[0], originHere());
    console.log(`Ran ${rest[0]}'s setup.`);
    return;
  }
  if (command === "plugins" && rest.length === 0) {
    const { cantTell, everyNamed, repositoryNeeds } = await import("../plugins/repository.ts");
    const anywhere: string[] = [];
    const needed = everyNamed(anywhere);
    return listPlugins(json, repositoryNeeds(false, []), cantTell(anywhere) ?? needed);
  }
  usage(command);
}

export async function oldPluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, sub, ...rest] = args;
  const now: Record<string, string[]> = {
    install: ["add", "-g"],
    update: ["update", "-g"],
    setup: ["setup"],
    rm: ["remove", "-g"],
    ls: ["plugins"],
  };
  const words = sub === undefined ? undefined : now[sub];
  if (!words) return usage(command);
  return pluginCommand([...words, ...rest], json);
}
