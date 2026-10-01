// Opens the TUI for a repository and returns once it is closed. Only bare
// `skelcrew` imports this file, so Ink loads only for the screen.

import { homedir } from "node:os";
import { render, useWindowSize } from "ink";
import type { ComponentProps } from "react";
import { type Context, readStatus, run } from "../cli/cli";
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
  // Every action runs the same command you would type after `skelcrew`.
  const send = (args: string[]) => run(args, context);
  const home = homedir();
  const shown = repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo;
  // The screen draws over the terminal, like vim, and leaves it as it was.
  // Ink's own alternateScreen keeps the cursor where the prompt was, so the
  // screen started halfway down. This clears it and starts at the top.
  process.stdout.write(`${ALTERNATE_SCREEN}${CLEAR}${TOP_LEFT}`);
  try {
    const app = render(
      <FullScreen repo={shown} quit={() => app.unmount()} load={load} send={send} />,
    );
    await app.waitUntilExit();
  } finally {
    process.stdout.write(MAIN_SCREEN);
  }
}

// The screen as tall as the terminal, and kept so when the window is resized.
function FullScreen(props: Omit<ComponentProps<typeof Screen>, "height">) {
  const { rows } = useWindowSize();
  return <Screen {...props} height={rows} />;
}

const ALTERNATE_SCREEN = "\u001B[?1049h";
const MAIN_SCREEN = "\u001B[?1049l";
const CLEAR = "\u001B[2J";
const TOP_LEFT = "\u001B[H";
