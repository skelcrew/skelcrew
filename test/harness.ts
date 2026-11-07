// What skel's tests share: finding skel's source files.
import { join } from "node:path";

// Returns the path of a file in src/, or of src/ itself, for a test that runs skel or hands
// its code to a process of its own.
export const source = (file = "") => join(import.meta.dir, "..", "src", file);
