# Roadmap

Where this is going, and what has been ruled out. Written 2026-09-11.

## Scope

YouTube transcripts. Nothing else.

This is a deliberate limit, not an oversight. The architecture would take other
sources cheaply — only 53 of roughly 1,400 lines are YouTube-specific, and they
all sit in `src/Youtube.ts` — but a narrow tool that works is worth more than a
broad one that half works. Revisit only if YouTube alone stops being enough.

## Next: publish to npm

The goal is one command with nothing permanently installed:

```bash
bunx <name>          # opens the app
npx <name> <url>     # prints the transcript
```

### The name is blocked

`yt-transcript` is **taken on npm**, as is `ytt`. Checked 2026-09-11.

Available at the time of checking:

| name | notes |
|---|---|
| `ytscript` | short, reads well, no hyphen |
| `yt-tx` | very short, `tx` is opaque to newcomers |
| `tubescript` | memorable, no `yt` prefix |
| `scribe-yt` | |
| `yt-transcript-cli` | keeps the current name, clumsy |
| `@rashed/yt-transcript` | scoped names are always free; costs discoverability |

The binaries can stay `yt-transcript` and `ytt` regardless of the package name,
so this only affects how people install it, not how they run it.

Decide before publishing. Renaming after release means a deprecation notice and
a split install base.

### Checklist

- [ ] Pick the package name and update `package.json`
- [ ] Confirm `files` ships only `dist`, `README.md`, and the licence
- [ ] Add a `prepublishOnly` script running typecheck, tests, and build
- [ ] Verify the tarball with `npm pack --dry-run`
- [ ] Publish, then verify `bunx <name> demo` works on a clean machine
- [x] Add a LICENSE file (package.json says MIT; the file is missing)

### Known packaging constraints

`@opentui/core` and `@effect/platform-bun` are optional dependencies, so
`npm install` succeeds without them, and only the app needs them. The plain
output path runs anywhere.

`@effect/platform-bun` provides the `ChildProcessSpawner` layer that `src/Ai.ts`
uses to run the local AI CLIs. `effect` ships the `ChildProcess` API but no
implementation of it, so the platform package is the price of not hand-rolling
the process plumbing.

The app requires **Bun**, because OpenTUI binds native code through `bun:ffi`
and has no Node equivalent. The CLI already detects Node and re-executes itself
under Bun when it finds it. Anyone without Bun gets a clear message and can
still use every non-app feature. This needs saying plainly in the README before
publishing, or it will read as a bug.

## Then: the terminal.shop feel

The target is the experience, not the transport: one command, no signup, no
config, and a UI that feels considered.

Most of that already exists. What is missing:

- [ ] First-run polish. The app currently opens on an empty field; a line about
      `demo` would help a newcomer who has not read the README.
- [ ] Recent history. Re-pasting a URL to revisit a transcript is friction.
- [ ] Resize handling. Untested below roughly 60 columns.
- [ ] A demo recording (asciinema or a GIF) for the README. The UI is the
      selling point and it cannot be conveyed in prose.

### SSH hosting is ruled out

`ssh transcript.sh` was considered and rejected. The plumbing is easy; the
consequences are not.

Hosting inverts the decision everything else depends on. The tool works
precisely because requests come from the user's own machine and IP. Evidence:
a few dozen caption requests from this single address earned a throttle that
was still active **two hours later**. A shared server serving strangers would be
rate limited permanently, and the fix is buying residential proxy bandwidth —
the exact cost that makes the subscription competitors charge money.

The ask-ai panel would also die. It works by shelling out to the user's own
authenticated `claude` or `qwen`. On a server there is no user CLI, so you would
supply your own API keys and pay for every stranger's inference.

A hosted version would be slower, rate limited, and missing its best feature,
while costing money to run. `bunx` delivers the same one-command experience with
none of that.

## Unfinished business

- **Live fetching is unverified end to end through the TypeScript build.** The
  caption endpoint has been throttling this IP since the reverse-engineering
  work. `ytt demo` covers everything else and `ytt <url> --langs` works, but the
  final hop wants confirming once the throttle clears.
- **The README is stale.** It predates the Tokyo Night palette, the bold keys,
  and `q` working inside the ask panel.
- **Git identity is repo-local** as `rashed <parvez08eee@gmail.com>`. Change it
  with `git config user.email` if that is wrong before anything is pushed.

## The thing most likely to break

YouTube closing the ungated client path. The `ANDROID_VR` and `IOS` clients
return caption URLs without the `exp=xpo,xpe` proof-of-origin gate; if that
changes, captions come back as HTTP 200 with an empty body and the app reports:

```
YouTube returned an empty caption body. The ungated client path may have changed.
```

The fix is confined to the `CLIENTS` array at the top of `src/Youtube.ts`.
Nothing else needs to move.
