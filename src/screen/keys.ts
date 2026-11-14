// The list of keys: every key the screen has, in the groups both the list of keys and
// sc --help show, so the two never disagree.

// Each group's heading and its lines of a key, written as the sidebar writes keys, and what it
// does.
export const keyGroups: [string, [string, string][]][] = [
  [
    "Anywhere",
    [
      ["⌥↑↓", "Move a row in the sidebar"],
      ["⌥⇧↑↓", "Jump to the lead, the lists or the threads"],
      ["⌥←→", "Switch to the repository before or after"],
      ["⌥⇧←→", "The same, where ⌥←→ jumps words"],
      ["⌥/", "Show the list of keys"],
      ["⌃Q", "Leave the screen, with your agents still running"],
    ],
  ],
  [
    "Lists",
    [
      ["↑↓", "Move a row"],
      ["⏎", "Open the row"],
      ["?", "Show the list of keys"],
    ],
  ],
  [
    "Pages",
    [
      ["↑↓", "Scroll"],
      ["Esc ←", "Go back to the list"],
      ["?", "Show the list of keys"],
    ],
  ],
];
