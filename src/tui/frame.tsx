// The frame around the screen's body: the header on the first line, and
// the bottom, which sits on the last lines: what the last command said, a
// y/n question or a text box, and the keys line.

import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import type { Run, Step } from "./actions";

// The list, a y/n question, or a line being typed.
export type Mode =
  | { kind: "list" }
  | { kind: "confirm"; question: string; run: Run }
  | { kind: "type"; prompt: string; run: (text: string) => Run | Step; text: string };

// A small copy of the logo on skelcrew.dev, drawn with half blocks.
export const LOGO = [
  "▄▄▄▄ █  ▄ ▄▄▄▄ █ ▄▄▄▄ ▄▄▄▄ ▄▄▄▄ ▄    ▄",
  "█▄▄▄ █▄▀  █▄▄█ █ █    █  ▀ █▄▄█ █ ▄▄ █",
  "▄▄▄█ █ ▀▄ █▄▄▄ █ █▄▄▄ █    █▄▄▄ █▄██▄█",
];

// The logo shows on the list only in a window at least this tall, so a
// short window keeps its room for tasks.
export const LOGO_MIN_HEIGHT = 24;

export function Logo() {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {LOGO.map((line) => (
        <Text key={line} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
}

// "skelcrew  ~/code/app  ·  Reports page          1 waits on you". A long
// path is cut from the left, so its last folders show. Under the logo, the
// header leaves out the name, which the logo already says.
export function ListHeader(props: {
  repo: string;
  project: string | null;
  counts: string;
  named: boolean;
}) {
  return (
    <Box flexShrink={0}>
      {props.named && (
        <Box flexShrink={0} marginRight={2}>
          <Text>skelcrew</Text>
        </Box>
      )}
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-start">{props.repo}</Text>
      </Box>
      {props.project !== null && (
        <Box flexShrink={0} marginLeft={2}>
          <Text bold>{`·  ${props.project}`}</Text>
        </Box>
      )}
      <Box flexShrink={0} marginLeft={2}>
        <Text>{props.counts}</Text>
      </Box>
    </Box>
  );
}

// "#14 CSV export                    Spec · approve its spec", or "Keys",
// or "Projects    2 active · 1 archived". A long title is cut at the end.
export function TitleHeader(props: { title: string; right?: string }) {
  return (
    <Box flexShrink={0}>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold wrap="truncate-end">
          {props.title}
        </Text>
      </Box>
      {props.right !== undefined && (
        <Box flexShrink={0} marginLeft={2}>
          <Text>{props.right}</Text>
        </Box>
      )}
    </Box>
  );
}

// How many lines the bottom takes, so the body knows its room. Each part
// comes after a blank line, and the keys line is always there.
export function bottomHeight(problem: string[], said: string[], mode: Mode): number {
  return (
    (problem.length > 0 ? 1 + problem.length : 0) +
    (said.length > 0 ? 1 + said.length : 0) +
    (mode.kind === "list" ? 0 : 2) +
    2
  );
}

type BottomProps = {
  // Why the last refresh failed, and what the last command said.
  problem: string[];
  said: string[];
  mode: Mode;
  // What the text box holds as it is typed, and what enter does with it.
  type: (text: string) => void;
  submit: (text: string) => void;
  keys: string;
};

// Every line is cut to the screen's width, so the keys stay on the last
// line.
export function Bottom({ problem, said, mode, type, submit, keys }: BottomProps) {
  return (
    <>
      {[problem, said]
        .filter((lines) => lines.length > 0)
        .map((lines, part) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts never move.
          <Box key={part} marginTop={1} flexDirection="column" flexShrink={0}>
            {lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
              <Text key={index} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
        ))}
      {mode.kind === "confirm" && (
        <Box marginTop={1} flexShrink={0}>
          <Text wrap="truncate-end">{mode.question}</Text>
        </Box>
      )}
      {mode.kind === "type" && (
        <Box marginTop={1} flexShrink={0}>
          <Text>{`${mode.prompt} `}</Text>
          <TextInput value={mode.text} onChange={type} onSubmit={submit} />
        </Box>
      )}
      <Box marginTop={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {keys}
        </Text>
      </Box>
    </>
  );
}
