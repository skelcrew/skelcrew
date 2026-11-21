// Restarting an agent from the screen, by R on its row while your typing is in the sidebar: the
// question, the yes that has the daemon restart it, and the rows that don't offer it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  acted,
  attachTo,
  daemon,
  endTest,
  footer,
  onDetails,
  open,
  press,
  ready,
  selected,
  sql,
  startTest,
  type,
  typingToSidebar,
  until,
} from "./screen.ts";

beforeEach(startTest);
afterEach(endTest);

test("R on the lead's row asks, and y has the daemon restart app's lead", async () => {
  daemon();
  open("lead");
  await ready("lead");
  press("C-\\");
  await until(() => typingToSidebar() && footer().includes("R restart"), "the lead's keys");
  type("R");
  await until(
    () => footer() === "  Restart app's lead? Its conversation is kept. y/n",
    "the question",
  );
  type("y");
  await until(() => footer() === "  Restarted app's lead.", "what the daemon said");
  expect(acted).toEqual(["restart simon/app"]);
});

test("R on a task whose builder runs asks, n restarts nothing, and y restarts it", async () => {
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  await until(() => footer().includes("R restart"), "the task's keys");
  type("R");
  await until(
    () => footer() === "  Restart APP-12's builder? Its conversation is kept. y/n",
    "the question",
  );
  type("n");
  await until(() => !footer().includes("Restart APP-12"), "the question to go");
  type("R");
  await until(() => footer().includes("Restart APP-12's builder?"), "the question again");
  type("y");
  await until(() => footer() === "  Restarted APP-12's builder.", "what the daemon said");
  expect(acted).toEqual(["restart simon/app 12"]);
});

test("a task whose builder isn't running offers no restart, and R there does nothing", async () => {
  daemon();
  sql("UPDATE threads SET status = 'stopped' WHERE task = '12'");
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await until(() => selected().includes("APP-12") && onDetails(), "APP-12's details");
  // Its row offers no R, though its old session still runs in this test.
  await until(() => footer().includes("w/⌥W close"), "the task's keys");
  expect(footer()).not.toContain("R restart");
  type("R");
  await Bun.sleep(500);
  expect(footer()).not.toContain("Restart");
  expect(acted).toEqual([]);
});

test("R typed to an attached builder reaches the builder, not the sidebar", async () => {
  daemon();
  open("lead");
  await ready("lead");
  press("M-S-Down");
  await attachTo("app-12");
  type("R\r");
  await Bun.sleep(500);
  expect(acted).toEqual([]);
});
