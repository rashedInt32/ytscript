# yt-transcript

YouTube transcripts in your terminal. No login, no API key, no subscription, no proxy.

Output is shaped for pasting into Claude Code, `llm`, or any other AI CLI.

```bash
ytt                                      # open the app
ytt "https://youtu.be/dQw4w9WgXcQ"       # print the transcript
```

## Install

```bash
npm install -g yt-transcript
```

Needs Node 20 or newer. One runtime dependency, `effect`.

Two commands are installed: `yt-transcript` and the shorter `ytt`.

## Feed it to an AI

Piping is the fastest route. The transcript goes to stdout, and nothing else does, so pipes stay clean.

```bash
ytt "https://youtu.be/VIDEO" | claude -p "Summarise the key arguments"
ytt "https://youtu.be/VIDEO" -p "Extract every action item" | claude
ytt "https://youtu.be/VIDEO" -f ts | llm "When do they discuss pricing?"
```

If you would rather paste by hand, put it straight on the clipboard:

```bash
ytt "https://youtu.be/VIDEO" -c
ytt "https://youtu.be/VIDEO" -c -p "Summarise this talk in five bullets"
```

For a model with a small context window, split it up first:

```bash
ytt "https://youtu.be/VIDEO" --chunk 8000
```

Every part is labelled `--- part 1 of 3 ---`, so you can paste them in order.

## The app

Run `ytt` with no arguments and it opens a full-screen app: a field to paste a URL into, and a reader for the result.

```bash
ytt
```

```
                ▀█▀ █▀█ ▄▀█ █▄ █ █▀▀ █▀▀ █▀█ █ █▀█ ▀█▀
                 █  █▀▄ █▀█ █ ▀█ ▄▄█ █▄▄ █▀▄ █ █▀▀  █
               YouTube transcripts without an account.

   ╭─ paste a youtube url ────────────────────────────────────────╮
   │ https://youtu.be/...                                         │
   ╰──────────────────────────────────────────────────────────────╯

  enter  fetch      ^c  quit
```

In the reader: `/` searches, `y` copies what is on screen, `t` toggles timestamps, `a` opens the ask-ai panel, `esc` goes back for another URL, `q` quits. Searching narrows to matching paragraphs, and `y` then copies only those. The header keeps a live token count so you know the size of what you are about to paste.

`ytt <url> -i` skips the home screen and goes straight to the reader.

## Try it without a network call

```bash
ytt demo
```

`demo` returns a built-in sample transcript. Every part of the tool works on it — formats, search, the reader, the ask-ai panel — with no request to YouTube. Useful when you are rate limited, offline, or changing the app itself. It also works inside the app: type `demo` into the URL field.

## Ask AI

Press `a` in the reader and a panel slides in from the right.

```
╭─ transcript ───────────────╮╭─ ask ai · claude ────────────────╮
│ [0:02]                     ││ s summarise     k key points     │
│ Right, let's get started.  ││ a action items  c chapters       │
│ I want to talk about why   ││ i ask…   m model   o scope: all  │
│ most internal tools die    ││                                  │
│ within a year.             ││ > Summarise this transcript      │
│                            ││                                  │
│ [0:14]                     ││ A talk on why internal tools get │
│ The first reason is that   ││ abandoned within a year, and how │
│ they solve a problem       ││ to build ones that survive.      │
╰────────────────────────────╯╰──────────────────────────────────╯
  tab  transcript    y  copy answer    esc  close
```

It finds whatever AI CLI you already have and shells out to it. Searched in order: `claude`, `codex`, `qwen`, `gemini`, `opencode`, `llm`. Press `m` to cycle between the ones you have installed.

No API keys are stored or asked for. The tool runs the CLI exactly as you have already configured and authenticated it, which is the same principle as the rest of `yt-transcript`.

Four presets are one keypress each: `s` summarise, `k` key points, `a` action items, `c` chapters with timestamps. Press `i` to type any question instead.

`o` toggles scope. By default the whole transcript is sent; with scope set to `screen`, only the paragraphs matching your current `/` search go to the model. That is cheaper and keeps the answer focused. The panel always shows the token count before you send.

`y` copies the answer.

Answers stream in as they are generated where the CLI supports it. Claude does, via `--output-format=stream-json`; the others print once they finish.

### The app needs Bun

OpenTUI's renderer is native code bound through `bun:ffi`. There is no Node equivalent yet, so under Node it fails with "OpenTUI native FFI is not available for this runtime yet", regardless of what its `engines` field claims.

`ytt` handles this for you: if it is running under Node and finds `bun` on your PATH, it re-runs itself under Bun. You only need to care if Bun is not installed, in which case the app tells you so and everything else keeps working.

Only the app is affected. `ytt <url>` and every flag below run on plain Node.

## Why the default output looks the way it does

The default format is plain prose. No cue numbers, no timestamps, no `-->` arrows.

Subtitle files waste tokens. A typical SRT spends roughly a third of its characters on timing metadata that a language model does not need. Stripping it leaves more of your context window for the actual content.

Paragraph breaks land where the speaker paused for two and a half seconds or more. That gives a model real structure to work with instead of one undifferentiated wall of text.

Each transcript is topped with the title, channel, duration, and source URL. A model reasons better when it knows what it is reading. Use `--raw` to drop that header.

## Options

```
-l, --lang <code>       Caption language, e.g. en, es, ja
-t, --translate <code>  Machine-translate into this language
-f, --format <name>     text | ts | md | srt | vtt | json
-c, --copy              Copy to clipboard instead of printing
-o, --out <file>        Write to a file
-p, --prompt <text>     Prepend an instruction line
-i, --interactive       Open this URL straight in the app
    --chunk <tokens>    Split into parts of roughly this many tokens
    --wrap <cols>       Hard-wrap prose at this width
    --raw               Omit the title and channel header
    --retry             Wait out YouTube's rate limiting instead of failing
    --langs             List available caption languages
    --stats             Print character and token counts to stderr
```

### Formats

`text` is prose, and the default. `ts` adds a `[12:34]` stamp per paragraph, which is what you want when you plan to ask the model *where* something was said. `md` turns those stamps into links that jump to the right second. `srt` and `vtt` are standard subtitle files. `json` gives you raw cues with start and duration in seconds.

Counts go to stderr, never stdout, so `--stats` is safe inside a pipe.

`--langs` marks the video's own default track with `*`. That matters on heavily translated videos, where the track list is alphabetical and the first entry is often not the original language.

## How it works

Most transcript tools broke when YouTube started gating captions behind a Proof-of-Origin token. The `WEB` client now stamps caption URLs with `exp=xpo,xpe`, and those URLs return HTTP 200 with an empty body unless a real browser has run BotGuard first.

That gate is why competing tools ask you to log in, and why they charge. Serving those requests means either an authenticated session or residential proxy bandwidth, and both cost money. YouTube's own `get_transcript` endpoint refuses anonymous callers outright with `FAILED_PRECONDITION`.

This tool sidesteps all of it. The `ANDROID_VR` and `IOS` clients hand back caption URLs without the `exp` gate. No token, no browser, no session. Requests run from your own machine and your own IP, so there is nothing to meter and nobody to bill.

`src/Youtube.ts` tries those clients in order and keeps the first that returns captions. A failure on one client does not abort the chain.

## Rate limiting

YouTube throttles the caption endpoint separately from the metadata endpoint, and more aggressively. Fetching many transcripts back to back will earn a 429 on captions while `--langs` still works fine.

`--retry` waits it out with an exponential backoff across four attempts, roughly 75 seconds total. A heavier throttle can outlast that, in which case the answer is simply to wait longer.

## If it stops working

YouTube could close the ungated path. If that happens you will see:

```
YouTube returned an empty caption body. The ungated client path may have changed.
```

That message means the empty-200 signature is back. The fix is confined to the `CLIENTS` array at the top of `src/Youtube.ts`; adding a new client entry is all it takes.

## Limits

Videos with captions disabled cannot be transcribed. There is no speech recognition here, so there is nothing to fall back on.

Auto-generated captions have no punctuation or sentence casing. That is YouTube's output, not a formatting bug. Models handle it fine.

`--translate` uses YouTube's own machine translation. Quality varies by language pair.

## Development

```bash
bun test           # unit tests
bun run typecheck  # tsc --noEmit
bun run build      # emit dist/
bun run dev <url>  # run from source
```

Errors are a tagged union (`InvalidUrl`, `VideoUnavailable`, `NoCaptions`, `LanguageNotFound`, `RateLimited`, `CaptionsGated`, `NetworkError`), so the type checker enforces that every failure has a message in `explain`.

Tests are offline and cover URL parsing, track selection, paragraph grouping, chunking, and every output format. Network behaviour is deliberately not mocked, because the thing most likely to break is YouTube itself, and a mock would happily keep passing while it did.

## License

MIT
