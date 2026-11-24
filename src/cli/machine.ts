// The commands for Skelcrew on this machine: sc serve, sc serve --bg, sc restart and sc update.
import { realpathSync } from "node:fs";
import { release, singleFile } from "../version.ts";
import { usage } from "./input.ts";

export async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "restart" && args.length === 1) {
    const { restartDaemon } = await import("../machine/service.ts");
    await restartDaemon();
    return;
  }
  if (command === "update" && args.length === 1) {
    if (!release || !singleFile)
      throw new Error(
        "this Skelcrew runs from a checkout, not a release, so it doesn't update itself. Run git pull in the checkout instead.",
      );
    const { updateItself } = await import("../machine/update.ts");
    await updateItself(realpathSync(process.execPath));
    return;
  }
  const { serve, DaemonSetupError } = await import("../flow/daemon.ts");
  const daemon = command === "serve";
  if (daemon && args.length === 1) {
    try {
      await serve("skelcrew");
    } catch (error) {
      if (error instanceof DaemonSetupError) process.exitCode = 78;
      throw error;
    }
    return;
  }
  if (daemon && args.length === 2 && args[1] === "--bg") {
    const { ensureDaemon } = await import("../machine/service.ts");
    const outside = await ensureDaemon();
    console.log(
      outside
        ? "Skelcrew's daemon already runs outside its service, such as with sc serve in a terminal. Stop it to run it in the background."
        : "Skelcrew's daemon is running in the background.",
    );
    return;
  }
  usage(command);
}
