// The watch the daemon and the screen's sidebar keep on themselves: each logs when its main loop
// stops running, and at which step, so the next freeze shows where it was.

// The worker that watches this process, once watchForStalls started it.
let watcher: Worker | null = null;

// Has a worker thread log when this process's main loop has not run for `limit` ms, while it is
// still stuck, and again with how long once it runs. `who` names the process in each line, such
// as "The daemon". Lines go to stdout, which the daemon's journal stamps with the time, or, with
// `file`, to that file, each with its time, as the sidebar's stdout is your terminal.
// Everything runs on the main loop, and a call that hangs, such as to tmux, holds it all up, so
// only a thread of its own can say so in time. The main loop beats each tenth of the limit. A
// gap in the worker's own checks means the whole machine slept, which is no stall. The worker
// never keeps the process running.
export function watchForStalls(who: string, file?: string, limit = 10_000): void {
  const every = limit / 10;
  // Plain JavaScript, as a worker made from text loads in a compiled sc too, with no file to find.
  const code = `
    import { appendFileSync } from "node:fs";
    const who = ${JSON.stringify(who)};
    const file = ${JSON.stringify(file ?? null)};
    // A log that can't be written, such as on a full disk, must not end the process it watches.
    const log = (line) => {
      try {
        if (file === null) console.log(line);
        else appendFileSync(file, new Date().toISOString() + " " + line + "\\n");
      } catch {}
    };
    const seconds = (ms) => (ms / 1000).toFixed(1) + "s";
    let beat = Date.now();
    let checked = Date.now();
    let step = "";
    let told = false;
    // A beat, or the step the main loop starts or ended: either way, it runs.
    self.onmessage = (message) => {
      const now = Date.now();
      if (told) log(who + " runs again after " + seconds(now - beat) + " stuck.");
      if (typeof message.data === "string") step = message.data;
      beat = now;
      told = false;
    };
    setInterval(() => {
      const now = Date.now();
      if (now - checked > ${limit}) beat = now;
      checked = now;
      if (!told && now - beat >= ${limit}) {
        const at = step === "" ? "" : ", while " + step;
        log(who + " has been stuck for " + seconds(now - beat) + at + ".");
        told = true;
      }
    }, ${every});
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([code])));
  worker.unref();
  watcher = worker;
  // The beat is unref'd too, so the process ends when it means to.
  setInterval(() => worker.postMessage(null), every).unref();
}

// Runs `run`, a step that could hang, such as a call to tmux, and returns what it returns. A
// stall logged meanwhile names the step, in words such as "asking tmux for the agents' sessions".
// Without a watch it only runs the step.
export function doing<T>(step: string, run: () => T): T {
  watcher?.postMessage(step);
  try {
    return run();
  } finally {
    watcher?.postMessage("");
  }
}
