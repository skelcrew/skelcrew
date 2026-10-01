// Opens the TUI for a repository and returns once it is closed. Only bare
// `skelcrew` imports this file, so Ink loads only for the screen.

import { render } from "ink";
import { Screen } from "./screen";

export async function open(repo: string): Promise<void> {
  // The screen draws over the terminal, like vim, and leaves it as it was.
  const app = render(<Screen repo={repo} quit={() => app.unmount()} />, {
    alternateScreen: true,
  });
  await app.waitUntilExit();
}
