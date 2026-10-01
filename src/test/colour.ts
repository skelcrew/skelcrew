// Loaded before every test file. Ink draws in colour here, as it does in
// the developer's terminal, so the TUI's tests behave the same whether or
// not they run in one. Without this, a test that compares coloured output
// passes in a script and fails in a terminal.
//
// Ink decides about colour once, when it loads. So colour is on only while
// it loads, and the setting goes back as it was. Nothing else sees it, such
// as the `skelcrew` processes the CLI's tests start.
const before = process.env.FORCE_COLOR;
process.env.FORCE_COLOR = "1";
await import("ink");
if (before === undefined) delete process.env.FORCE_COLOR;
else process.env.FORCE_COLOR = before;

// A module, so the await above may stand at the top of the file.
export {};
