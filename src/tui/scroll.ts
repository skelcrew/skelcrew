// Which part of a list taller than the screen shows.

// The first line to show, so that lines `from` to `to` are in view, such
// as the cursor's line and its group's heading above it. It moves as
// little as it can from where the list was, so the list doesn't jump.
// `shown` is how many lines fit, and `total` how many there are.
//
// For example, with 7 lines shown from line 0, moving the cursor to line 7
// shows from line 1.
export function firstShown(
  previous: number,
  from: number,
  to: number,
  shown: number,
  total: number,
): number {
  const inView = Math.min(Math.max(previous, to - shown + 1), from);
  return Math.min(Math.max(inView, 0), Math.max(total - shown, 0));
}
