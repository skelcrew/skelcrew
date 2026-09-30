// A Markdown file imported with `with { type: "text" }` is its text.
declare module "*.md" {
  const text: string;
  export default text;
}
