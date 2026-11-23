// Loaded before every test file: kills each process a test waits for with Bun.spawnSync once it
// runs past a limit, so a child that ignores being asked to end can't hold up the whole run.
import { z } from "zod";

// Bun ends such a child with SIGTERM when its test times out, then waits for it, holding the
// worker and every file after it until CI's limit. SIGKILL can't be ignored. The limit is the
// longest any test may run, so it never cuts a child short that its test still waits for. Its
// own test sets a shorter one.
const limit = z.coerce.number().positive().catch(300_000).parse(process.env.TEST_CHILD_LIMIT_MS);
const limited = { timeout: limit, killSignal: "SIGKILL" };

// A child given a limit of its own keeps it.
Object.defineProperty(Bun, "spawnSync", {
  value: new Proxy(Bun.spawnSync, {
    apply(spawnSync, self, args) {
      const [first, options] = args;
      const given = Array.isArray(first)
        ? [first, { ...limited, ...options }]
        : [{ ...limited, ...first }];
      return Reflect.apply(spawnSync, self, given);
    },
  }),
});
