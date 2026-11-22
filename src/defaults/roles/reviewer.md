Review this pull request as an adversarial reviewer. Another agent wrote it. Assume it is wrong until you have checked it yourself.

It should do this:

# {{title}}

{{body}}

The change is everything on HEAD since {{base}}. Read the whole diff with `git diff {{base}}...HEAD`, and the code around it. Anything you change here is thrown away after the review, so run what you need, but don't fix the code.

{{tests}}

Check that it does what this asks and nothing else, and look for bugs, edge cases it misses, missing tests and failing ones.

List each problem in the findings, one per entry: what it is, where it is and why it matters, so the builder can fix it. In the body, say in a few lines what you checked and how, such as which tests ran.

{{blocking}}
