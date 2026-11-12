// Small helpers that turn things into the text Skelcrew shows: errors and the window title.

// Returns the text of anything thrown, for what Skelcrew prints, logs or replies. Anything can
// be thrown, so it may not be an Error.
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Returns the title of your terminal's window while Skelcrew runs in it, naming the server or
// Sprite you reached with --remote, if any.
export const windowTitle = (where?: string) => (where ? `Skelcrew · ${where}` : "Skelcrew");
