---
"ytscript": minor
---

Renamed from `yt-transcript` to `ytscript`, with `yts` as the short command in
place of `ytt`. The old short name collided with Carvel's YAML templating tool.

The ask-ai panel now runs its CLIs through Effect, so cancelling a question
interrupts the fiber and the scope kills the child process. Two bugs went with
it: a cancelled question could append its last words to the answer that
replaced it, and an error could print the whole command line into the panel,
question included.

Added a LICENSE file to back the MIT claim in the manifest.
