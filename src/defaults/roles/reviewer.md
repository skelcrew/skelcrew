Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should do this:

# {{title}}

{{body}}

The change is everything on HEAD since {{base}}. Read the whole diff with `git diff {{base}}...HEAD`, and the code around it. Run the tests, using the commands under test: in the repository's skelcrew.yaml if there is one. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

Check that it does what this asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

Answer "approve" only if it is ready to merge. Otherwise answer "changes", and in the body name each problem, where it is and why it matters, so the builder can fix it.
