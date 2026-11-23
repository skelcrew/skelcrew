// The commands for plugins: sc plugin adds, removes, updates and lists them and runs their setup,
// and sc install installs only the plugins named by the checkout and personal lock.
import { usage } from "./input.ts";

export async function installCommand(args: string[]): Promise<void> {
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--from" && args[1]))
    usage("install");
  const { installFiles } = await import("../plugins/install-files.ts");
  if (!installFiles(args[1])) process.exitCode = 1;
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
  if (command === "update" && !yours) {
    throw new Error(
      `sc plugin ${command} without -g is for a repository's plugins, which Skelcrew can't update yet. sc plugin ${command} -g is for your own`,
    );
  }
  if (command === "add" && name && more.length === 0) {
    addPlugin(name);
    return;
  }
  if (command === "rm" && name && more.length === 0) {
    return removeYourPlugin(name);
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
