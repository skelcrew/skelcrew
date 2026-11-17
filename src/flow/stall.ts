// The daemon's watch on itself: it logs when its main loop stops running, so a freeze of the
// daemon can be told apart from a freeze of the screen.

// Has a worker thread log when the daemon's main loop has not run for `limit` ms, while it is
// still stuck, and again with how long once it runs. Everything the daemon does runs on that
// loop, and a call that hangs, such as to tmux, holds it all up, so only a thread of its own can
// say so in time. The main loop beats each tenth of the limit. A gap in the worker's own checks
// means the whole machine slept, which is no stall. The worker never keeps the daemon running.
export function watchForStalls(limit = 10_000): void {
  const every = limit / 10;
  // Plain JavaScript, as a worker made from text loads in a compiled sc too, with no file to find.
  const code = `
    const seconds = (ms) => (ms / 1000).toFixed(1) + "s";
    let beat = Date.now();
    let checked = Date.now();
    let told = false;
    self.onmessage = () => {
      const now = Date.now();
      if (told) console.log("The daemon runs again after " + seconds(now - beat) + " stuck.");
      beat = now;
      told = false;
    };
    setInterval(() => {
      const now = Date.now();
      if (now - checked > ${limit}) beat = now;
      checked = now;
      if (!told && now - beat >= ${limit}) {
        console.log("The daemon has been stuck for " + seconds(now - beat) + ".");
        told = true;
      }
    }, ${every});
  `;
  const worker = new Worker(URL.createObjectURL(new Blob([code])));
  worker.unref();
  // The beat is unref'd too, so the daemon ends when it means to.
  setInterval(() => worker.postMessage(0), every).unref();
}
