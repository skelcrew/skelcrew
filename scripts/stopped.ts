// Loaded before each test file by scripts/test.ts: once the run is stopped at its time limit, a
// file that would start then ends its worker at once, before any of its code runs. Bun still
// hands waiting files to workers after the limit, and one that started could set up and then
// be killed before it cleared up. Bun counts the file as cut off and goes on to write its report.
import { existsSync } from "node:fs";

const stopped = process.env.TEST_RUN_STOPPED;
if (stopped && existsSync(stopped)) process.exit(1);
