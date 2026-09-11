/**
 * The interactive app.
 *
 * Running `ytt` with no URL lands here. Piping (`ytt <url> | claude`) never
 * loads this module at all, so the fast path pays nothing for it.
 *
 * Screens: a home screen with a URL field, and a reader for the transcript.
 */
import { spawn } from "node:child_process"
import * as Effect from "effect/Effect"
import { estimateTokens, formatTimestamp, toParagraphs, wrap } from "./Format.ts"
import { explain, getTranscript, parseVideoId, type Transcript } from "./Youtube.ts"
import { isDemoTarget } from "./Demo.ts"
import type {
  BoxRenderable,
  CliRenderer,
  ScrollBoxRenderable,
  StyledText as StyledTextType,
  TextChunk
} from "@opentui/core"

/**
 * Foreground colours only. The terminal keeps its own background, so the app
 * sits inside whatever theme the user already chose rather than painting a
 * rectangle of someone else's dark grey over it.
 *
 * Every value clears 3:1 contrast against white, black, #0d1117, and
 * solarized light, which is the band where a colour stays legible whichever
 * theme the user runs. Red is reserved for failures so it keeps meaning
 * something; using it for ordinary chrome made the app look permanently
 * broken.
 */
const THEME = {
  /** Timestamps, prompts, focus. 4.81:1 on black, 4.37:1 on white. */
  green: "#2b8a3e",
  /** The wordmark only. Large text, so 3:1 is the relevant bar. */
  greenBright: "#2f9e44",
  /** Keys you can press. Distinct from green without shouting. */
  key: "#946300",
  /** Labels and secondary text. 4.34:1 on black, 4.83:1 on white. */
  dim: "#6b7280",
  border: "#5a6472",
  /** Errors, and nothing else. */
  bad: "#c92a2a"
} as const

const copyToClipboard = (text: string): void => {
  const [command, args] =
    process.platform === "darwin"
      ? (["pbcopy", [] as Array<string>] as const)
      : process.platform === "win32"
        ? (["clip", [] as Array<string>] as const)
        : (["xclip", ["-selection", "clipboard"]] as const)
  const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] })
  child.on("error", () => {})
  child.stdin.end(text)
}

export const launch = async (initialUrl?: string): Promise<void> => {
  const tui = await import("@opentui/core").catch(() => null)
  if (tui === null) {
    throw new Error(
      "The interactive app needs @opentui/core.\n" +
        "It requires Bun, because its renderer binds native code through bun:ffi.\n" +
        "Pass a URL to use the plain output instead:\n" +
        "  ytt https://youtu.be/VIDEO"
    )
  }

  const {
    ASCIIFontRenderable,
    BoxRenderable: Box,
    InputRenderable: Input,
    InputRenderableEvents,
    ScrollBoxRenderable: ScrollBox,
    TextRenderable: Text,
    StyledText,
    createCliRenderer,
    fg
  } = tui

  const inKey = fg(THEME.key)
  const inDim = fg(THEME.dim)
  const inGreen = fg(THEME.green)

  /**
   * One "key label" pair, with the pressable key picked out in its own colour
   * so the eye can find it without reading the whole line. `width` pads the
   * cell so stacked rows line up into columns.
   */
  const pair = (keyName: string, label: string, width = 0): Array<TextChunk> => {
    const body = ` ${label}`
    const gap = Math.max(1, width - keyName.length - body.length)
    return [inKey(keyName), inDim(body + " ".repeat(gap))]
  }

  const styled = (...chunks: Array<TextChunk>): StyledTextType =>
    new StyledText(chunks)

  // The terminal supplies body text colour, so the app is legible on a light
  // theme too. parseColor("default") is not a thing; this sentinel is.
  const TEXT = tui.RGBA.defaultForeground()

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: "transparent"
  })
  const ctx = renderer

  const quit = (): never => {
    renderer.stop()
    process.exit(0)
  }

  // ---------------------------------------------------------------- layout

  const screen = new Box(ctx, {
    flexGrow: 1,
    flexDirection: "column",
    padding: 1,
    backgroundColor: "transparent"
  })
  renderer.root.add(screen)

  // ------------------------------------------------------------ home screen

  const home = new Box(ctx, {
    flexGrow: 1,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center"
  })

  // The "tiny" font is two rows tall but reports no intrinsic height to the
  // layout engine, so on its own it gets overdrawn by whatever follows it.
  // ASCIIFontOptions forbids an explicit height, hence the sized wrapper.
  const wordmarkSlot = new Box(ctx, { height: 2, flexShrink: 0 })
  wordmarkSlot.add(
    new ASCIIFontRenderable(ctx, {
      text: "transcript",
      font: "tiny",
      color: THEME.greenBright
    })
  )
  const wordmark = wordmarkSlot

  const tagline = new Text(ctx, {
    content: "YouTube transcripts without an account.",
    fg: THEME.dim,
    marginTop: 1
  })

  const inputBox = new Box(ctx, {
    width: 64,
    height: 3,
    marginTop: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.green,
    title: " paste a youtube url ",
    titleColor: THEME.dim,
    paddingLeft: 1,
    paddingRight: 1
  })

  const urlInput = new Input(ctx, {
    value: initialUrl ?? "",
    placeholder: "https://youtu.be/...   (or type: demo)",
    textColor: TEXT,
    focusedTextColor: TEXT,
    placeholderColor: THEME.dim
  })
  inputBox.add(urlInput)

  const homeStatus = new Text(ctx, { content: "", fg: THEME.dim, marginTop: 1 })

  home.add(wordmark)
  home.add(tagline)
  home.add(inputBox)
  home.add(homeStatus)

  // ---------------------------------------------------------------- reader

  const reader = new Box(ctx, { flexGrow: 1, flexDirection: "row" })

  const readerMain = new Box(ctx, { flexGrow: 1, flexDirection: "column" })

  const readerHeader = new Box(ctx, {
    height: 4,
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.border,
    paddingLeft: 1,
    paddingRight: 1
  })
  const readerHeaderText = new Text(ctx, { content: "", fg: TEXT })
  readerHeader.add(readerHeaderText)

  // Every layer of a ScrollBox paints its own background by default, and the
  // scrollbar track defaults to a dark grey that only suits a dark terminal.
  const transparentLayers = {
    wrapperOptions: { backgroundColor: "transparent" },
    viewportOptions: { backgroundColor: "transparent" },
    contentOptions: { backgroundColor: "transparent" },
    // The scrollbar's own colours live on its track, not on the bar itself.
    scrollbarOptions: {
      trackOptions: {
        backgroundColor: "transparent",
        foregroundColor: THEME.border
      }
    }
  } as const

  const scroll: ScrollBoxRenderable = new ScrollBox(ctx, {
    flexGrow: 1,
    ...transparentLayers,
    rootOptions: {
      backgroundColor: "transparent",
      border: true,
      borderStyle: "rounded",
      borderColor: THEME.border,
      paddingLeft: 1,
      paddingRight: 1
    }
  })

  readerMain.add(readerHeader)
  readerMain.add(scroll)
  reader.add(readerMain)

  // The bottom bar belongs to the window, not to either screen.
  const bar = new Text(ctx, { content: "", fg: THEME.dim, flexShrink: 0 })
  screen.add(bar)

  // Screens are attached and detached rather than toggled with `visible`,
  // which only hides a node and leaves it occupying its flex space.
  let mounted: BoxRenderable | null = null
  const mount = (next: BoxRenderable): void => {
    if (mounted === next) return
    if (mounted !== null) screen.remove(mounted)
    screen.add(next, 0)
    mounted = next
  }

  // ----------------------------------------------------------------- state

  type Mode = "home" | "loading" | "reader" | "search"
  let mode: Mode = "home"
  let transcript: Transcript | null = null
  let query = ""
  let showTimestamps = true
  let flash = ""
  const lines: Array<InstanceType<typeof Text>> = []

  const paragraphs = () => (transcript === null ? [] : toParagraphs(transcript.cues))

  const matching = () =>
    query === ""
      ? paragraphs()
      : paragraphs().filter((p) => p.text.toLowerCase().includes(query.toLowerCase()))

  const keyHint = (): Array<TextChunk> => {
    const lead = inDim("  ")
    switch (mode) {
      case "home":
        return [lead, ...pair("enter", "fetch"), inDim("   "), ...pair("^c", "quit")]
      case "loading":
        return [lead, inDim("fetching…")]
      case "search":
        return [
          lead,
          inGreen(`/${query}█`),
          inDim("   "),
          ...pair("enter", "apply"),
          inDim("  "),
          ...pair("esc", "clear")
        ]
      default:
        return [
          lead,
          ...pair("/", "search"),
          inDim("  "),
          ...pair("y", "copy"),
          inDim("  "),
          ...pair("t", "times"),
          inDim("  "),
          ...pair("esc", "new url"),
          inDim("  "),
          ...pair("q", "quit")
        ]
    }
  }

  const paintBar = (): void => {
    const chunks = keyHint()
    bar.content =
      flash === "" ? styled(...chunks) : styled(...chunks, inGreen(`      ${flash}`))
  }

  const paintReader = (): void => {
    if (transcript === null) return
    const shown = matching()
    const total = paragraphs().length

    const body = shown.map((p) => p.text).join("\n\n")
    readerHeaderText.content =
      `${transcript.title}\n` +
      `${transcript.author}   ${formatTimestamp(transcript.durationSeconds)}   ` +
      `${transcript.track.languageCode}${transcript.track.isGenerated ? " (auto)" : ""}   ` +
      `~${estimateTokens(body)} tokens   ` +
      (query === "" ? `${total} paragraphs` : `${shown.length}/${total} matching`)

    for (const line of lines) {
      scroll.remove(line)
      line.destroyRecursively()
    }
    lines.length = 0

    if (shown.length === 0) {
      const empty = new Text(ctx, {
        content: `\nNo paragraph matches "${query}".`,
        fg: THEME.dim
      })
      lines.push(empty)
      scroll.add(empty)
    }

    for (const paragraph of shown) {
      if (showTimestamps) {
        const stamp = new Text(ctx, {
          content: `\n[${formatTimestamp(paragraph.start)}]`,
          fg: THEME.green
        })
        lines.push(stamp)
        scroll.add(stamp)
      }
      const text = new Text(ctx, { content: `${paragraph.text}\n`, fg: TEXT })
      lines.push(text)
      scroll.add(text)
    }
  }

  const show = (next: Mode): void => {
    mode = next
    const onHome = next === "home" || next === "loading"
    mount(onHome ? home : reader)

    // A focused Input swallows every keystroke, so leaving it focused off the
    // home screen means reader shortcuts like j/k/y/a get typed into the URL
    // field instead of doing anything.
    if (onHome) urlInput.focus()
    else urlInput.blur()

    if (!onHome) {
      paintReader()
      }
    paintBar()
    renderer.requestRender()
  }

  // ---------------------------------------------------------------- fetch

  const load = async (raw: string): Promise<void> => {
    const url = raw.trim()
    if (url === "") return

    if (parseVideoId(url) === null && !isDemoTarget(url)) {
      homeStatus.content = "That does not look like a YouTube URL."
      homeStatus.fg = THEME.bad
      renderer.requestRender()
      return
    }

    homeStatus.content = "Fetching transcript..."
    homeStatus.fg = THEME.dim
    show("loading")

    const result = await Effect.runPromise(
      Effect.result(getTranscript(url, { retryRateLimit: true }))
    )

    if (result._tag === "Failure") {
      homeStatus.content = explain(result.failure)
      homeStatus.fg = THEME.bad
      show("home")
      return
    }

    transcript = result.success
    query = ""
    flash = ""
    homeStatus.content = ""
    scroll.scrollTo(0)
    show("reader")
  }

  urlInput.on(InputRenderableEvents.ENTER, (value: string) => {
    void load(value)
  })

  // -------------------------------------------------------------- keyboard

  renderer.keyInput.on("keypress", (key: { name?: string; sequence?: string }) => {
    const name = key.name ?? ""
    const typed = key.sequence ?? ""
    flash = ""

    // The URL field owns every keystroke while the home screen is up.
    if (mode === "home" || mode === "loading") return

    if (mode === "search") {
      if (name === "escape") {
        query = ""
        show("reader")
      } else if (name === "return") {
        show("reader")
      } else if (name === "backspace") {
        query = query.slice(0, -1)
        show("search")
      } else if (typed.length === 1) {
        query += typed
        show("search")
      }
      return
    }

    // Reader.
    switch (name) {
      case "q":
        quit()
        break
      case "escape":
        show("home")
        break
      case "slash":
        query = ""
        show("search")
        break
      case "t":
        showTimestamps = !showTimestamps
        show("reader")
        break
      case "y": {
        const text = matching().map((p) => p.text).join("\n\n")
        copyToClipboard(text)
        flash = `copied ~${estimateTokens(text)} tokens`
        paintBar()
        renderer.requestRender()
        break
      }
      case "j":
      case "down":
        scroll.scrollBy({ x: 0, y: 2 })
        break
      case "k":
      case "up":
        scroll.scrollBy({ x: 0, y: -2 })
        break
      case "space":
      case "pagedown":
        scroll.scrollBy({ x: 0, y: 20 })
        break
      case "pageup":
        scroll.scrollBy({ x: 0, y: -20 })
        break
      case "g":
        scroll.scrollTo(0)
        break
      default:
        break
    }
  })

  show("home")
  renderer.start()

  // An initial URL means the user already told us what they want.
  if (initialUrl !== undefined && initialUrl !== "") await load(initialUrl)
}
