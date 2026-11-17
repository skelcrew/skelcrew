// The processes on this machine, so the daemon and a session's end can wait for what they
// started to exit.

// Returns every process with what started it and its state letter, Z for one that exited
// but wasn't yet reaped. It asks ps, since a Mac has no /proc. Each column is its own -o: a
// Mac's ps reads what follows an = as the column's title, commas and all.
function listProcesses(): { pid: number; parent: number; state: string }[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "stat="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  // Each line holds a pid, its parent and its state, padded with spaces. A line missing any
  // of them, such as the empty one at the end, is skipped.
  return ps.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, state] = line.trim().split(/\s+/);
      return pid && parent && state
        ? [{ pid: Number(pid), parent: Number(parent), state: state.slice(0, 1) }]
        : [];
    });
}

// Returns a process and every process under it, so stopping a session can wait for all of
// them: an agent in its sandbox runs a few levels down from the pane's own process.
export function processTree(root: number): number[] {
  // List each process's children, from one look at every process.
  const children = new Map<number, number[]>();
  for (const { pid, parent } of listProcesses())
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  // Walk down from the root: each process found adds its children to the end of the list,
  // so the loop reaches them in turn.
  const tree = [root];
  for (let i = 0; i < tree.length; i++) tree.push(...(children.get(tree[i] ?? 0) ?? []));
  return tree;
}

// Returns those of the given processes that haven't exited, to wait for them to end.
export function stillRunning(tree: number[]): number[] {
  const alive = listProcesses().filter(({ state }) => state !== "Z");
  return tree.filter((pid) => alive.some((process) => process.pid === pid));
}
