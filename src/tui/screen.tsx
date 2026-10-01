// The whole TUI screen. For now it names the repository and quits on q.

import { Box, Text, useInput } from "ink";

type Props = {
  repo: string;
  quit: () => void;
};

export function Screen({ repo, quit }: Props) {
  useInput((input) => {
    if (input === "q") quit();
  });
  return (
    <Box flexDirection="column">
      <Text>{`skelcrew  ${repo}`}</Text>
      <Text dimColor>q quit</Text>
    </Box>
  );
}
