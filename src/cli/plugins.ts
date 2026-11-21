// The commands for plugins: adding, removing, updating and listing them, and running their
// setup, plus sc install, which sets up this machine and the plugins your files name.
import { usage } from "./input.ts";

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
