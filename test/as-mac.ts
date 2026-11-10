// Loaded before Skelcrew with bun --preload, so Skelcrew takes the paths it takes on a Mac on this
// Linux machine, with fake launchctl and sandbox-exec scripts in place of the real ones.
Object.defineProperty(process, "platform", { value: "darwin" });
