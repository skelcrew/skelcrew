// Opens the TUI for a repository and returns once it is closed. Only bare
// `skelcrew` imports this file, so Ink loads only for the screen.

import { homedir } from "node:os";
import { render } from "ink";
import { type Context, readStatus } from "../cli/cli";
import { startDaemon } from "../cli/start";
import { Screen } from "./screen";

export async function open(repo: string): Promise<void> {
  // Like any command, the screen starts the daemon if it isn't running.
  const context: Context = {
    cwd: repo,
    session: undefined,
    readStdin: async () => "",
    start: startDaemon,
  };
  const load = () => readStatus(context);
  const home = homedir();
  const shown = repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo;
  // The screen draws over the terminal, like vim, and leaves it as it was.
  const app = render(<Screen repo={shown} quit={() => app.unmount()} load={load} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
}
