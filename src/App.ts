/**
 * The interactive app.
 *
 * Running `ytt` with no URL lands here. Piping (`ytt <url> | claude`) never
 * loads this module at all, so the fast path pays nothing for it.
 *
 * Screens: a home screen with a URL field, and a reader for the transcript.
 * The reader can slide an "ask ai" panel in from the right, which drives
 * whichever AI CLI the user already has installed.
 */
import { spawn } from "node:child_process"
import * as Effect from "effect/Effect"
import { estimateTokens, formatTimestamp, toParagraphs, wrap } from "./Format.ts"
import { explain, getTranscript, parseVideoId, type Transcript } from "./Youtube.ts"
import { ask, detectTools, PRESETS, type AiTool, type AskHandle } from "./Ai.ts"
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

/**
 * Wide enough for prose, narrow enough to leave the transcript readable.
 * A fixed 46 would squeeze the transcript to nothing on a small terminal,
 * so never take more than 45% of the window.
 */
const panelWidth = (terminalWidth: number): number =>
  Math.max(28, Math.min(46, Math.floor(terminalWidth * 0.45)))

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

  // The terminal supplies body text colour, so the app is legible on a light
  // theme too. parseColor("default") is not a thing; this sentinel is.
  const TEXT = tui.RGBA.defaultForeground()

  const inKey = fg(THEME.key)
  const inText = fg(TEXT)
  const inDim = fg(THEME.dim)
  const inGreen = fg(THEME.green)

  /**
   * One "key label" pair, with the pressable key picked out in its own colour
   * so the eye can find it without reading the whole line. `width` pads the
   * cell so stacked rows line up into columns.
   */
  const pair = (keyName: string, label: string, width = 0): Array<TextChunk> => {
    const gap = Math.max(1, width - keyName.length - label.length - 1)
    // The label is ordinary text, not secondary. Dimming it as well as the
    // key made whole menus read as disabled.
    return [inKey(keyName), inText(` ${label}`), inDim(" ".repeat(gap))]
  }

  const styled = (...chunks: Array<TextChunk>): StyledTextType =>
    new StyledText(chunks)

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: "transparent"
  })
  const ctx = renderer

  // stop() only pauses the render loop. destroy() is what puts the terminal
  // back: alt screen off, mouse tracking off, cursor visible. Without it the
  // shell is left echoing raw mouse reports and the pane has to be closed.
  let tornDown = false
  const teardown = (): void => {
    if (tornDown) return
    tornDown = true
    try {
      renderer.destroy()
    } catch {
      // Best effort: a half-initialised renderer must not mask the real exit.
    }
  }

  process.on("exit", teardown)
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      teardown()
      process.exit(0)
    })
  }
  process.on("uncaughtException", (error) => {
    teardown()
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exit(1)
  })

  const quit = (): never => {
    teardown()
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
    titleColor: THEME.green,
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

  // ------------------------------------------------------------- ai panel

  const tools = detectTools()
  let toolIndex = 0
  const tool = (): AiTool | null => tools[toolIndex] ?? null

  const PANEL_WIDTH = panelWidth(renderer.terminalWidth)

  const panel = new Box(ctx, {
    width: PANEL_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.green,
    paddingLeft: 1,
    paddingRight: 1
  })

  const panelMenu = new Text(ctx, { content: "", fg: THEME.dim, flexShrink: 0 })
  const panelQuestion = new Text(ctx, { content: "", fg: THEME.green, flexShrink: 0 })
  const panelBody: ScrollBoxRenderable = new ScrollBox(ctx, {
    flexGrow: 1,
    ...transparentLayers,
    rootOptions: { backgroundColor: "transparent" }
  })
  const panelAnswer = new Text(ctx, { content: "", fg: TEXT })
  panelBody.add(panelAnswer)

  panel.add(panelMenu)
  panel.add(panelQuestion)
  panel.add(panelBody)

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

  type Mode = "home" | "loading" | "reader" | "search" | "ask" | "askInput"
  let mode: Mode = "home"
  let transcript: Transcript | null = null
  let query = ""
  let showTimestamps = true
  let flash = ""
  let panelOpen = false
  let question = ""
  let answer = ""
  let running: AskHandle | null = null
  let scopeVisibleOnly = false
  const lines: Array<InstanceType<typeof Text>> = []

  const paragraphs = () => (transcript === null ? [] : toParagraphs(transcript.cues))

  const matching = () =>
    query === ""
      ? paragraphs()
      : paragraphs().filter((p) => p.text.toLowerCase().includes(query.toLowerCase()))

  /** What actually gets piped to the AI CLI. */
  const payload = (): string => {
    if (transcript === null) return ""
    const chosen = scopeVisibleOnly ? matching() : paragraphs()
    const body = chosen
      .map((p) => `[${formatTimestamp(p.start)}] ${p.text}`)
      .join("\n\n")
    return `Video: ${transcript.title}\nChannel: ${transcript.author}\n\n${body}`
  }

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
      case "askInput":
        return [
          lead,
          inDim("ask: "),
          inGreen(`${question}█`),
          inDim("   "),
          ...pair("enter", "send"),
          inDim("  "),
          ...pair("esc", "cancel")
        ]
      case "ask":
        return running !== null
          ? [lead, inGreen("thinking…"), inDim("   "), ...pair("esc", "stop")]
          : [
              lead,
              ...pair("tab", "transcript"),
              inDim("  "),
              ...pair("y", "copy answer"),
              inDim("  "),
              ...pair("esc", "close"),
              inDim("  "),
              ...pair("q", "quit")
            ]
      default:
        return [
          lead,
          ...pair("/", "search"),
          inDim("  "),
          ...pair("a", "ask ai"),
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

  const paintPanel = (): void => {
    const active = tool()
    panel.title = active === null ? " ask ai " : ` ask ai · ${active.label} `
    panel.titleColor = THEME.green

    if (active === null) {
      panelMenu.content = ""
      panelQuestion.content = ""
      panelAnswer.content = wrap(
        "No AI CLI found on your PATH.\n\n" +
          "Install any of: claude, codex, qwen, gemini, opencode, llm.\n\n" +
          "They are used exactly as you have them configured. No API keys are " +
          "stored here.",
        PANEL_WIDTH - 4
      )
      return
    }

    // Two per row, column-aligned, so no label wraps across a line break.
    const column = Math.floor((PANEL_WIDTH - 4) / 2)
    const chunks: Array<TextChunk> = []
    for (let i = 0; i < PRESETS.length; i += 2) {
      for (const preset of [PRESETS[i], PRESETS[i + 1]]) {
        if (preset === undefined) continue
        chunks.push(...pair(preset.key, preset.label, column))
      }
      chunks.push(inDim("\n"))
    }
    chunks.push(
      ...pair("i", "ask…"),
      inDim("  "),
      ...pair("m", "model"),
      inDim("  "),
      ...pair("o", `scope: ${scopeVisibleOnly ? "screen" : "all"}`),
      inDim("\n")
    )
    panelMenu.content = styled(...chunks)

    panelQuestion.content =
      question === "" ? "" : `${wrap(`> ${question}`, PANEL_WIDTH - 4)}\n`

    panelAnswer.content =
      answer === ""
        ? running !== null
          ? "thinking…"
          : `Pick a preset, or press i to type a question.\n\n~${estimateTokens(payload())} tokens will be sent.`
        : wrap(answer, PANEL_WIDTH - 4)
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

  const setPanelOpen = (open: boolean): void => {
    if (open === panelOpen) return
    panelOpen = open
    if (open) reader.add(panel)
    else reader.remove(panel)
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
      if (panelOpen) paintPanel()
    }
    paintBar()
    renderer.requestRender()
  }

  // ------------------------------------------------------------------- ai

  const runAsk = (prompt: string): void => {
    const active = tool()
    if (active === null || transcript === null) return

    running?.cancel()
    question = prompt
    answer = ""
    show("ask")

    running = ask({
      tool: active,
      question: prompt,
      transcript: payload(),
      onChunk: (chunk) => {
        answer += chunk
        paintPanel()
        renderer.requestRender()
      },
      onDone: (error) => {
        running = null
        if (error !== null) answer = answer === "" ? error : `${answer}\n\n${error}`
        paintPanel()
        paintBar()
        renderer.requestRender()
      }
    })
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
    answer = ""
    question = ""
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

    if (mode === "search" || mode === "askInput") {
      const buffer = mode === "search" ? query : question
      const commit = (next: string): void => {
        if (mode === "search") query = next
        else question = next
      }

      if (name === "escape") {
        commit("")
        show(mode === "search" ? "reader" : "ask")
      } else if (name === "return") {
        if (mode === "askInput") {
          if (question.trim() === "") show("ask")
          else runAsk(question.trim())
        } else show("reader")
      } else if (name === "backspace") {
        commit(buffer.slice(0, -1))
        show(mode)
      } else if (typed.length === 1) {
        commit(buffer + typed)
        show(mode)
      }
      return
    }

    if (mode === "ask") {
      if (name === "escape") {
        if (running !== null) {
          running.cancel()
          running = null
          show("ask")
        } else {
          setPanelOpen(false)
          show("reader")
        }
        return
      }
      if (name === "tab") {
        show("reader")
        return
      }

      const preset = PRESETS.find((p) => p.key === name)
      if (preset !== undefined && running === null) {
        runAsk(preset.prompt)
        return
      }

      switch (name) {
        case "q":
          quit()
          break
        case "i":
          question = ""
          show("askInput")
          break
        case "m":
          if (tools.length > 0) {
            toolIndex = (toolIndex + 1) % tools.length
            answer = ""
            question = ""
            show("ask")
          }
          break
        case "o":
          scopeVisibleOnly = !scopeVisibleOnly
          show("ask")
          break
        case "y":
          if (answer !== "") {
            copyToClipboard(answer)
            flash = `copied ~${estimateTokens(answer)} tokens`
            paintBar()
            renderer.requestRender()
          }
          break
        case "down":
          panelBody.scrollBy({ x: 0, y: 2 })
          break
        case "up":
          panelBody.scrollBy({ x: 0, y: -2 })
          break
        default:
          break
      }
      return
    }

    // Reader.
    switch (name) {
      case "q":
        quit()
        break
      case "escape":
        setPanelOpen(false)
        show("home")
        break
      case "a":
        setPanelOpen(true)
        show("ask")
        break
      case "tab":
        if (panelOpen) show("ask")
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
