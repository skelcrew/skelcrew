// Turning what you type or paste at the token question into the token and the stars shown.
import { expect, test } from "bun:test";
import { typeKeys } from "../src/secret.ts";

test("shows a star for each character, and ends on Enter", () => {
  expect(typeKeys("", "abc\r")).toEqual({ token: "abc", shown: "***", end: "enter" });
  expect(typeKeys("ab", "c\n")).toEqual({ token: "abc", shown: "*", end: "enter" });
});

test("keeps reading until Enter", () => {
  expect(typeKeys("", "sk-ant")).toEqual({ token: "sk-ant", shown: "******", end: null });
});

test("backspace takes back the last character and its star", () => {
  expect(typeKeys("", "ab\x7fc\r")).toEqual({ token: "ac", shown: "**\b \b*", end: "enter" });
  expect(typeKeys("a", "\b")).toEqual({ token: "", shown: "\b \b", end: null });
});

test("backspace with nothing typed changes nothing", () => {
  expect(typeKeys("", "\x7f")).toEqual({ token: "", shown: "", end: null });
});

test("leaves the paste markers out of a pasted token", () => {
  const pasted = typeKeys("", "\x1b[200~sk-ant-oat01-good\x1b[201~");
  expect(pasted).toEqual({ token: "sk-ant-oat01-good", shown: "*****************", end: null });
});

test("leaves out arrow keys and other control keys", () => {
  expect(typeKeys("", "a\x1b[Db\x1bOA\tc\r")).toEqual({ token: "abc", shown: "***", end: "enter" });
});

test("Ctrl-C stops, whatever was typed", () => {
  expect(typeKeys("", "ab\x03c\r").end).toBe("stop");
});
