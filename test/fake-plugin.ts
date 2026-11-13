// A tracker and forge for tests, run as a plugin's call command: it keeps each question it is
// asked in its settings folder, in `asked`, and answers from a file there named after the
// question, such as `changed.json`, or else as a plugin with nothing to say would. For claims,
// that file maps each remote it claims to its answer. With a file `fail-<question>`, it fails
// with that file's words, and with `setup-<question>` it fails the same way with exit code 2,
// as a plugin that needs its setup again does. While `hold-<question>`, or for a question with
// a state, `hold-<question>-<state>`, is there, it waits before answering, saying so with
// `held-<question>`. Asked to assign you, it says this call did, and taking you off answers
// nothing, as GitHub's plugin does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.SKELCREW_PLUGIN_CONFIG ?? "";
const question = JSON.parse(await Bun.stdin.text());
appendFileSync(join(dir, "asked"), `${JSON.stringify(question)}\n`);
const name = String(question.ask).replaceAll(" ", "-");
const failing = join(dir, `fail-${name}`);
if (existsSync(failing)) {
  console.error(readFileSync(failing, "utf8").trim());
  process.exit(1);
}
const setup = join(dir, `setup-${name}`);
if (existsSync(setup)) {
  console.error(readFileSync(setup, "utf8").trim());
  process.exit(2);
}
const holds = [join(dir, `hold-${name}`), join(dir, `hold-${name}-${question.state}`)];
const hold = holds.find((file) => existsSync(file));
if (hold) {
  writeFileSync(join(dir, `held-${name}`), "");
  // Never on the file alone: the test can remove the folder meanwhile.
  const deadline = Date.now() + 20_000;
  while (existsSync(hold) && Date.now() < deadline) await Bun.sleep(50);
}
const file = join(dir, `${name}.json`);
// Reviews are numbered from 1001, one after the other.
const reviewed = () => {
  const count = join(dir, "reviews");
  const n = (existsSync(count) ? Number(readFileSync(count, "utf8")) : 1000) + 1;
  writeFileSync(count, String(n));
  return { id: String(n) };
};
const answers: Record<string, () => unknown> = {
  claims: () => null,
  changed: () => ({ items: [], next: null }),
  "open-pr": () => ({ number: 7 }),
  review: reviewed,
  log: () => ({ log: "expected 2, got 3" }),
  assign: () => (question.on ? { assigned: true } : null),
};
const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
// Which remotes it claims is a map from each remote to its answer.
const answer = name === "claims" ? saved?.[question.remote] : (saved ?? answers[name]?.());
console.log(JSON.stringify(answer ?? null));
