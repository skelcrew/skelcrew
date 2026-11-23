// The saved logins agents need. Login questions belong to sc in the human's terminal.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeTokenFile, dataDir } from "../paths.ts";
import { hasLogin as hasCodexLogin } from "./codex-login.ts";
import type { HarnessName } from "./harness.ts";
import { hasPiLogin } from "./pi-login.ts";

export function hasAgentLogin(harness: HarnessName, home = homedir()): boolean {
  if (harness === "claude") return existsSync(claudeTokenFile(home));
  if (harness === "pi") return hasPiLogin(home);
  return hasCodexLogin(home) || existsSync(join(dataDir(home), "codex", "auth.json"));
}

export const loginInstruction = (harness: HarnessName) => `run sc: sign in to ${harness}`;

export class MissingLogin extends Error {
  constructor(readonly harness: HarnessName) {
    super(`An agent needs a ${harness} login: ${loginInstruction(harness)}`);
  }
}
