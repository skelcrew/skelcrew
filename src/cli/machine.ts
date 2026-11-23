// The commands for the daemon on this machine: sc serve, sc serve --bg and sc restart.
import { usage } from "./input.ts";

export async function machineCommand(args: string[]): Promise<void> {
  const [command] = args;
  if (command === "restart" && args.length === 1) {
    const { restartDaemon } = await import("../machine/service.ts");
    await restartDaemon();
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
