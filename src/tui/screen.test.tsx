import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Screen } from "./screen";

// Ink reads keys on the next tick, so a test waits for it after typing.
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("the screen names the repository and says how to quit", () => {
  const { lastFrame } = render(<Screen repo="/code/app" quit={() => {}} />);
  expect(lastFrame()).toContain("skelcrew  /code/app");
  expect(lastFrame()).toContain("q quit");
});

test("q closes the screen", async () => {
  let quit = 0;
  const { stdin } = render(<Screen repo="/code/app" quit={() => quit++} />);
  await tick();
  stdin.write("q");
  await tick();
  expect(quit).toBe(1);
});

test("other keys don't close it", async () => {
  let quit = 0;
  const { stdin } = render(<Screen repo="/code/app" quit={() => quit++} />);
  await tick();
  stdin.write("x");
  await tick();
  expect(quit).toBe(0);
});
