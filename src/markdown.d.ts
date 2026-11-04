// Lets TypeScript accept the prompts skel imports as text: Bun reads a Markdown file
// imported with { type: "text" } as a string and builds it into skel.
declare module "*.md" {
  const text: string;
  export default text;
}
