# Changesets

Version numbers and the changelog are generated from the files in this folder.

After a change worth releasing, run `bun run changeset`. It asks whether the
change is a patch, a minor, or a major, then asks for a one-line summary. That
summary becomes the changelog entry, so write it for someone who has not read
the diff.

The answer is written to a markdown file here and committed alongside the code.
Several can pile up between releases. Nothing is published until you release.

To cut a release:

```bash
bun run version:packages   # rolls up the files here into a version and CHANGELOG.md
git commit -am "release"
bun run release            # publishes to npm
```

`version:packages` deletes the files it consumed, which is how the folder stays
empty between releases.
