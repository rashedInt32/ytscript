import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import * as Effect from "effect/Effect"
import {
  buildHeader,
  chunk,
  estimateTokens,
  format,
  isFormatName,
  FORMATS,
  type FormatName
} from "./Format.ts"
import {
  explain,
  fetchVideoInfo,
  getTranscript,
  parseVideoId,
  InvalidUrl,
  type TranscriptError
} from "./Youtube.ts"
import { DEMO_TRANSCRIPT, isDemoTarget } from "./Demo.ts"

const HELP = `yt-transcript - YouTube transcripts in your terminal. No login, no key.

USAGE
  ytt                          Open the interactive app
  ytt <url|id> [options]       Print the transcript

OPTIONS
  -l, --lang <code>       Caption language, e.g. en, es, ja
  -t, --translate <code>  Machine-translate into this language
  -f, --format <name>     ${FORMATS.join(" | ")}   (default: text)
  -c, --copy              Copy to clipboard instead of printing
  -o, --out <file>        Write to a file
  -p, --prompt <text>     Prepend an instruction line, for piping into an AI CLI
  -i, --interactive       Open this URL straight in the app
      --chunk <tokens>    Split output into parts of roughly this many tokens
      --wrap <cols>       Hard-wrap prose at this width   (default: off)
      --raw               Omit the title and channel header
      --retry             Wait out YouTube's rate limiting instead of failing
      --langs             List available caption languages and exit
      --stats             Print character and token counts to stderr
  -h, --help              Show this help
  -v, --version           Show version

PIPE IT INTO AN AI CLI
  yt-transcript <url> | claude -p "Summarise the key arguments"
  yt-transcript <url> -p "Extract every action item" | claude
  yt-transcript <url> -f ts | llm "When do they discuss pricing?"

COPY IT BY HAND
  yt-transcript <url> -c
  yt-transcript <url> -c -p "Summarise this talk in five bullets"

Exit codes: 0 ok, 1 error, 2 bad usage.`

const OPTIONS = {
  lang: { type: "string", short: "l" },
  translate: { type: "string", short: "t" },
  format: { type: "string", short: "f", default: "text" },
  copy: { type: "boolean", short: "c", default: false },
  out: { type: "string", short: "o" },
  prompt: { type: "string", short: "p" },
  interactive: { type: "boolean", short: "i", default: false },
  chunk: { type: "string" },
  wrap: { type: "string" },
  raw: { type: "boolean", default: false },
  retry: { type: "boolean", default: false },
  langs: { type: "boolean", default: false },
  stats: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false }
} as const

class UsageError extends Error {}

const copyToClipboard = (text: string): Promise<void> => {
  const candidates: ReadonlyArray<readonly [string, ReadonlyArray<string>]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]]
          ]

  return new Promise((resolve, reject) => {
    const attempt = (index: number): void => {
      const entry = candidates[index]
      if (entry === undefined) {
        reject(new Error("No clipboard tool found. Install wl-copy, xclip, or xsel."))
        return
      }
      const child = spawn(entry[0], [...entry[1]], {
        stdio: ["pipe", "ignore", "ignore"]
      })
      child.on("error", () => attempt(index + 1))
      child.on("close", (code) => (code === 0 ? resolve() : attempt(index + 1)))
      child.stdin.end(text)
    }
    attempt(0)
  })
}

/**
 * Opens the interactive app.
 *
 * OpenTUI's renderer is a native library bound through `bun:ffi`, so it only
 * runs under Bun despite what its `engines` field claims. Node gets
 * "OpenTUI native FFI is not available for this runtime yet". Rather than
 * making that the user's problem, hand the same command to Bun when we find
 * it. The plain output path is unaffected and still runs anywhere.
 */
const launchApp = async (url: string | undefined): Promise<number> => {
  if (process.versions.bun === undefined) {
    const bun = spawnSync("command", ["-v", "bun"], { shell: true, encoding: "utf8" })
    const bunPath = bun.stdout?.trim()
    if (bunPath === undefined || bunPath === "") {
      process.stderr.write(
        "The interactive app needs Bun, because OpenTUI's renderer binds native\n" +
          "code through bun:ffi and has no Node equivalent yet.\n\n" +
          "  curl -fsSL https://bun.sh/install | bash\n\n" +
          "Everything else works on Node. Pass a URL for plain output:\n" +
          "  ytt https://youtu.be/VIDEO\n"
      )
      return 1
    }
    const entry = process.argv[1]
    if (entry === undefined) return 1
    const relaunch = spawnSync(bunPath, [entry, ...process.argv.slice(2)], {
      stdio: "inherit"
    })
    return relaunch.status ?? 0
  }

  try {
    // Imported lazily so the plain output path never loads the renderer.
    const { launch } = await import("./App.ts")
    await launch(url)
    return 0
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

const positiveInt = (value: string, flag: string): number => {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${flag} needs a positive whole number.`)
  }
  return parsed
}

const listLanguages = (target: string) =>
  Effect.gen(function* () {
    const info = isDemoTarget(target)
      ? DEMO_TRANSCRIPT
      : yield* Effect.gen(function* () {
          const videoId = parseVideoId(target)
          if (videoId === null) return yield* new InvalidUrl({ input: target })
          return yield* fetchVideoInfo(videoId)
        })
    const lines = [`${info.title} - ${info.author}`, ""]
    for (const track of info.tracks) {
      // YouTube already bakes "(auto-generated)" into some track names.
      const tag =
        track.isGenerated && !/auto-generated/i.test(track.name)
          ? " (auto-generated)"
          : ""
      const marker = track.isDefault ? "*" : " "
      lines.push(`${marker} ${track.languageCode.padEnd(8)} ${track.name}${tag}`)
    }
    return lines.join("\n")
  })

export const run = async (argv: ReadonlyArray<string>): Promise<number> => {
  let values: Record<string, string | boolean | undefined>
  let positionals: ReadonlyArray<string>
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true
    })
    values = parsed.values as Record<string, string | boolean | undefined>
    positionals = parsed.positionals
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\nRun with --help.\n`)
    return 2
  }

  if (values.help === true) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (values.version === true) {
    // Read at runtime rather than imported, so the build output stays flat.
    const pkg = createRequire(import.meta.url)("../package.json") as {
      version: string
    }
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }

  const target = positionals[0]

  // Bare `ytt` opens the app. Piping without a URL has nothing to print, so
  // that stays an error rather than launching a TUI into a pipe.
  if (target === undefined) {
    if (!process.stdout.isTTY) {
      process.stderr.write("Missing a YouTube URL or video id.\n\nRun with --help.\n")
      return 2
    }
    return await launchApp(undefined)
  }

  if (values.interactive === true) return await launchApp(target)

  const formatName = String(values.format ?? "text")
  if (!isFormatName(formatName)) {
    process.stderr.write(
      `Unknown format "${formatName}". Try: ${FORMATS.join(", ")}\n`
    )
    return 2
  }

  try {
    if (values.langs === true) {
      const listing = await Effect.runPromise(listLanguages(target))
      process.stdout.write(`${listing}\n`)
      return 0
    }

    const transcript = await Effect.runPromise(
      getTranscript(target, {
        lang: values.lang as string | undefined,
        translateTo: values.translate as string | undefined,
        retryRateLimit: values.retry === true
      })
    )

    const body = format(transcript, {
      format: formatName as FormatName,
      wrapWidth:
        values.wrap === undefined
          ? undefined
          : positiveInt(String(values.wrap), "wrap")
    })

    // Subtitle and JSON output is machine-read, so never decorate it.
    const isSubtitle = formatName === "srt" || formatName === "vtt"
    const wantsHeader = values.raw !== true && !isSubtitle && formatName !== "json"

    let content = wantsHeader ? `${buildHeader(transcript)}\n\n${body}` : body

    if (values.chunk !== undefined) {
      const parts = chunk(content, positiveInt(String(values.chunk), "chunk"))
      content = parts
        .map((part, i) => `--- part ${i + 1} of ${parts.length} ---\n\n${part}`)
        .join("\n\n")
    }

    // The instruction stays above the part markers so the model reads it first.
    const output =
      typeof values.prompt === "string" && !isSubtitle
        ? `${values.prompt}\n\n${content}`
        : content

    if (values.stats === true) {
      process.stderr.write(
        `${transcript.cues.length} cues | ${output.length} chars | ~${estimateTokens(output)} tokens | via ${transcript.client}\n`
      )
    }

    if (typeof values.out === "string") {
      await writeFile(values.out, `${output}\n`, "utf8")
      process.stderr.write(`Wrote ${values.out}\n`)
      return 0
    }

    if (values.copy === true) {
      await copyToClipboard(output)
      process.stderr.write(
        `Copied ~${estimateTokens(output)} tokens to the clipboard.\n`
      )
      return 0
    }

    process.stdout.write(`${output}\n`)
    return 0
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    const message = describe(error)
    const hint =
      message.startsWith("YouTube is rate limiting") && values.retry !== true
        ? " Or pass --retry to wait it out."
        : ""
    process.stderr.write(`${message}${hint}\n`)
    return 1
  }
}

/** Effect.runPromise rejects with a FiberFailure wrapping our tagged error. */
const describe = (error: unknown): string => {
  const cause = (error as { cause?: unknown })?.cause ?? error
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    typeof (cause as { _tag: unknown })._tag === "string"
  ) {
    return explain(cause as TranscriptError)
  }
  return (error as Error)?.message ?? String(error)
}
