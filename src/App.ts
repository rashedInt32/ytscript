/**
 * The interactive app.
 *
 * Running `yts` with no URL lands here. Piping (`yts <url> | claude`) never
 * loads this module at all, so the fast path pays nothing for it.
 *
 * Screens: a home screen with a URL field, and a reader for the transcript.
 * The reader can slide an "ask ai" panel in from the right, which drives
 * whichever AI CLI the user already has installed.
 */
import { spawn } from "node:child_process"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { estimateTokens, formatTimestamp, toParagraphs, wrap } from "./Format.ts"
import { explain, getTranscript, parseVideoId, type Transcript } from "./Youtube.ts"
import { ask, detectTools, explainAsk, PRESETS, type AiTool } from "./Ai.ts"
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
 * Colours carry meaning rather than decoration, so a hint bar can be read at
 * a glance: leaving is red, copying is green, moving is blue, settings are
 * orange, and anything to do with the AI is teal.
 *
 * The hues come from Tokyo Night, to match the claude-hl package. Its actual
 * values could not be used as-is: they are tuned for a #1a1b26 background and
 * score 1.5:1 to 2.8:1 against white, which is illegible. Each hue was kept
 * and its lightness moved until the colour clears 3:1 against white, black,
 * #0d1117, solarized light, and #f5f5f5. Every value here sits at about
 * 4.15:1 on all five.
 */
const THEME = {
  /** Identity: wordmark, panel edge, anything AI. */
  brand: "#2c8376",
  /** Timestamps. */
  time: "#0f7cbb",
  /** Moving around: search, focus. */
  nav: "#3a70e3",
  /** Something was taken or confirmed: copy, enter. */
  ok: "#5c8133",
  /** Leaving or stopping, and anything that failed. */
  danger: "#e1294c",
  /** Changing a setting: toggles and pickers. */
  option: "#c55410",
  /** Padding, secondary text, box edges. */
  dim: "#6e7499"
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
        "  yts https://youtu.be/VIDEO"
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
    bold,
    createCliRenderer,
    dim,
    fg
  } = tui

  // The terminal supplies body text colour, so the app is legible on a light
  // theme too. parseColor("default") is not a thing; this sentinel is.
  const TEXT = tui.RGBA.defaultForeground()

  const inText = fg(TEXT)
  const inDim = fg(THEME.dim)
  const inBrand = fg(THEME.brand)
  const inNav = fg(THEME.nav)
  const inOk = fg(THEME.ok)
  const inDanger = fg(THEME.danger)
  const inOption = fg(THEME.option)

  type Paint = (input: string) => TextChunk

  /**
   * One "key label" pair. The key carries a colour that means something:
   * leaving is red, copying is green, moving is blue, and so on. That way the
   * hint bar can be read at a glance instead of word by word.
   *
   * The label stays in the terminal's own text colour. Dimming it as well as
   * the key made whole menus look disabled.
   */
  const pair = (
    keyName: string,
    label: string,
    paint: Paint,
    width = 0,
    muted = false
  ): Array<TextChunk> => {
    const gap = Math.max(1, width - keyName.length - label.length - 1)
    const text = ` ${label}`
    // Bold as well as coloured: on a single character, colour alone is a weak
    // signal, and it is the only signal for anyone who cannot separate hues.
    return [
      bold(paint(keyName)),
      muted ? dim(inText(text)) : inText(text),
      inDim(" ".repeat(gap))
    ]
  }

  /**
   * Bar variant. The hint bar is always on screen, so its labels recede.
   *
   * This uses the terminal's faint attribute over the default foreground
   * rather than a fixed grey, so "slightly dimmer than body text" stays true
   * whatever theme is running. A hardcoded grey can only be right for one.
   */
  const hint = (keyName: string, label: string, paint: Paint): Array<TextChunk> =>
    pair(keyName, label, paint, 0, true)

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
      color: THEME.brand
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
    borderColor: THEME.brand,
    title: " paste a youtube url ",
    titleColor: THEME.brand,
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
    borderColor: THEME.dim,
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
        foregroundColor: THEME.dim
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
      borderColor: THEME.dim,
      paddingLeft: 1,
      paddingRight: 1
    }
  })

  readerMain.add(readerHeader)
  readerMain.add(scroll)
  reader.add(readerMain)

  // ------------------------------------------------------------- ai panel

  // One runtime for everything that needs a platform service: finding the AI
  // CLIs, and running them. Bun-only, which this module already is.
  const runtime = ManagedRuntime.make(BunServices.layer)

  const tools = await runtime.runPromise(detectTools)
  let toolIndex = 0
  const tool = (): AiTool | null => tools[toolIndex] ?? null

  const PANEL_WIDTH = panelWidth(renderer.terminalWidth)

  const panel = new Box(ctx, {
    width: PANEL_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: THEME.brand,
    paddingLeft: 1,
    paddingRight: 1
  })

  const panelMenu = new Text(ctx, { content: "", fg: THEME.dim, flexShrink: 0 })
  const panelQuestion = new Text(ctx, { content: "", fg: THEME.brand, flexShrink: 0 })
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
  let running: Fiber.Fiber<void, never> | null = null
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
        return [lead, ...hint("enter", "fetch", inOk), inDim("   "), ...hint("^c", "quit", inDanger)]
      case "loading":
        return [lead, inDim("fetching…")]
      case "search":
        return [
          lead,
          inNav(`/${query}█`),
          inDim("   "),
          ...hint("enter", "apply", inOk),
          inDim("  "),
          ...hint("esc", "clear", inDanger)
        ]
      case "askInput":
        return [
          lead,
          inDim("ask: "),
          inBrand(`${question}█`),
          inDim("   "),
          ...hint("enter", "send", inOk),
          inDim("  "),
          ...hint("esc", "cancel", inDanger)
        ]
      case "ask":
        return running !== null
          ? [lead, inBrand("thinking…"), inDim("   "), ...hint("esc", "stop", inDanger)]
          : [
              lead,
              ...hint("tab", "transcript", inNav),
              inDim("  "),
              ...hint("y", "copy answer", inOk),
              inDim("  "),
              ...hint("esc", "close", inDanger),
              inDim("  "),
              ...hint("q", "quit", inDanger)
            ]
      default:
        return [
          lead,
          ...hint("/", "search", inNav),
          inDim("  "),
          ...hint("a", "ask ai", inBrand),
          inDim("  "),
          ...hint("y", "copy", inOk),
          inDim("  "),
          ...hint("t", "times", inOption),
          inDim("  "),
          ...hint("esc", "new url", inDanger),
          inDim("  "),
          ...hint("q", "quit", inDanger)
        ]
    }
  }

  const paintBar = (): void => {
    const chunks = keyHint()
    bar.content =
      flash === "" ? styled(...chunks) : styled(...chunks, inOk(`      ${flash}`))
  }

  const paintPanel = (): void => {
    const active = tool()
    panel.title = active === null ? " ask ai " : ` ask ai · ${active.label} `
    panel.titleColor = THEME.brand

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
        chunks.push(...pair(preset.key, preset.label, inBrand, column))
      }
      chunks.push(inDim("\n"))
    }
    chunks.push(
      ...pair("i", "ask…", inBrand),
      inDim("  "),
      ...pair("m", "model", inOption),
      inDim("  "),
      ...pair("o", `scope: ${scopeVisibleOnly ? "screen" : "all"}`, inOption),
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
          fg: THEME.time
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

  /** Kills whatever question is in flight. Safe when there is none. */
  const cancelAsk = (): void => {
    if (running === null) return
    Effect.runFork(Fiber.interrupt(running))
    running = null
  }

  /**
   * Which question the panel belongs to.
   *
   * Interruption is not instant: the scope has to kill the child and wait for
   * it. So a cancelled question is still winding down after its replacement
   * has started. Without this it would append its last chunks to the new
   * answer, then clear the new handle and leave a tool running unreachable.
   */
  let generation = 0

  const runAsk = (prompt: string): void => {
    const active = tool()
    if (active === null || transcript === null) return

    cancelAsk()
    question = prompt
    answer = ""
    show("ask")

    const mine = ++generation
    const current = (): boolean => mine === generation

    running = runtime.runFork(
      ask({
        tool: active,
        question: prompt,
        transcript: payload(),
        onChunk: (chunk) => {
          if (!current()) return
          answer += chunk
          paintPanel()
          renderer.requestRender()
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            if (!current()) return
            const message = explainAsk(error)
            answer = answer === "" ? message : `${answer}\n\n${message}`
          })
        ),
        // Fires on interrupt too, which is what redraws the panel after escape.
        Effect.onExit(() =>
          Effect.sync(() => {
            if (!current()) return
            running = null
            paintPanel()
            paintBar()
            renderer.requestRender()
          })
        )
      )
    )
  }

  // ---------------------------------------------------------------- fetch

  const load = async (raw: string): Promise<void> => {
    const url = raw.trim()
    if (url === "") return

    if (parseVideoId(url) === null && !isDemoTarget(url)) {
      homeStatus.content = "That does not look like a YouTube URL."
      homeStatus.fg = THEME.danger
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
      homeStatus.fg = THEME.danger
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
          cancelAsk()
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
        // Guarded like the presets above: while one question is in flight the
        // only thing the panel accepts is escape.
        case "i":
          if (running === null) {
            question = ""
            show("askInput")
          }
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
        // The hint says "new url", so start empty. The failure path in `load`
        // deliberately keeps the old one, because there you want to retry it.
        urlInput.value = ""
        show("home")
        break
      case "a":
        setPanelOpen(true)
        show("ask")
        break
      case "tab":
        if (panelOpen) show("ask")
        break
      // OpenTUI reports this key as "/", not "slash".
      case "/":
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
