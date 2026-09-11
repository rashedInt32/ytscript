# @rashed.parvez/ytscript

## 0.2.1

### Patch Changes

- 5a73a6e: Pressing escape in the reader now clears the URL field, so a new URL can be
  typed straight away instead of deleting the old one first. A fetch that failed
  still keeps its URL, because that one you want to retry rather than retype.

## 0.2.0

### Minor Changes

- 3cc152b: Renamed from `yt-transcript` to `ytscript`, with `yts` as the short command in
  place of `ytt`. The old short name collided with Carvel's YAML templating tool.
  
  The ask-ai panel now runs its CLIs through Effect, so cancelling a question
  interrupts the fiber and the scope kills the child process. Two bugs went with
  it: a cancelled question could append its last words to the answer that
  replaced it, and an error could print the whole command line into the panel,
  question included.
  
  Added a LICENSE file to back the MIT claim in the manifest.
