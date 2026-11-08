// The harnesses skel runs agents on, found by the name your config uses. Each harness lives in
// a module of its own, so the flow never names one.
import { claude } from "./claude.ts";

const harnesses = { claude };

export type HarnessName = keyof typeof harnesses;

// Returns the harness your config names, such as "claude", with how to start it and what its
// screen shows. The type follows the name, so a caller sees exactly what that harness offers.
export function harnessNamed<Name extends HarnessName>(name: Name): (typeof harnesses)[Name] {
  return harnesses[name];
}
