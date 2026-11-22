// The commands for plugins: sc plugin adds, removes, updates and lists them and runs their setup,
// and sc install sets up this machine and the plugins your files name, and adds the repository
// you run it in.
import { usage } from "./input.ts";

export async function installCommand(args: string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const [flag = "", value] = args.slice(at, at + 2);
    if (!["--from", "--files"].includes(flag) || !value || options.has(flag)) usage("install");
    else options.set(flag, value);
  }
  const files = options.get("--files");
  if (files) {
    const { putSentFiles } = await import("../machine/your-files.ts");
    putSentFiles(files);
  }
  const { install } = await import("../machine/setup.ts");
  if (!install(options.get("--from"))) {
    process.exitCode = 1;
    return;
  }
  // On a server, the checkout is on your laptop, so only a run here adds a repository.
  if (options.has("--from")) return;
  const { installRepo } = await import("../flow/repo.ts");
  await installRepo("skelcrew");
}

export async function pluginCommand(args: string[], json: boolean): Promise<void> {
  const [command, ...rest] = args;
  const { addPlugin, listPlugins, removeYourPlugin, setUpPlugin, updatePlugins } = await import(
    "../plugins/install.ts"
  );
  const yours = rest[0] === "-g";
  const [name, ...more] = yours ? rest.slice(1) : rest;
  if (command === "add" && name && more.length === 0 && !yours) {
    const { addRepositoryPlugin } = await import("../plugins/repository.ts");
    const added = addRepositoryPlugin(name);
    if (added) console.log(added);
    return;
  }
  if ((command === "rm" || command === "update") && !yours) {
    const verb = command === "rm" ? "remove" : "update";
    throw new Error(
      `sc plugin ${command} without -g is for a repository's plugins, which Skelcrew can't ${verb} yet. sc plugin ${command} -g is for your own`,
    );
  }
  if (command === "add" && name && more.length === 0) {
    addPlugin(name);
    return;
  }
  if (command === "rm" && name && more.length === 0) {
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
  if (command === "ls" && rest.length === 0) {
    const { cantTell, everyNamed, repositoryNeeds } = await import("../plugins/repository.ts");
    const anywhere: string[] = [];
    const needed = everyNamed(anywhere);
    return listPlugins(json, repositoryNeeds(false, []), cantTell(anywhere) ?? needed);
  }
  usage("plugin");
}
