/**
 * Local AI CLI discovery and one-shot invocation.
 *
 * Every tool here is driven non-interactively: the transcript goes in on
 * stdin, the question goes in as an argument, and the answer comes back on
 * stdout. That keeps rendering under our control, which matters because a
 * sidebar is roughly forty columns wide and these CLIs are full-screen apps
 * when you let them own the terminal.
 *
 * No API keys live here. We shell out to whatever the user has already set up
 * and authenticated, which is the same principle as the rest of the tool.
 * `effect/unstable/ai` is deliberately not used: it speaks to provider HTTP
 * APIs and wants a key, which is the opposite trade.
 *
 * The process plumbing is Effect's. A question is an `Effect`, so cancelling
 * one is interrupting its fiber, and the scope kills the child on the way out.
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Filter from "effect/Filter"
import * as Path from "effect/Path"
import type * as PlatformError from "effect/PlatformError"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

/**
 * A line-oriented streaming protocol, where supported.
 *
 * Without this a tool only prints once it has finished, which for a long
 * summary means staring at a spinner. `extract` returns the visible text in
 * one NDJSON line, or null for the many lines that carry no prose.
 */
export interface StreamMode {
  readonly args: (question: string) => ReadonlyArray<string>
  readonly extract: (line: string) => string | null
}

export interface AiTool {
  readonly id: string
  readonly label: string
  readonly bin: string
  /** Argument vector for a one-shot run. The transcript arrives on stdin. */
  readonly args: (question: string) => ReadonlyArray<string>
  readonly stream?: StreamMode | undefined
}

interface Candidate {
  readonly id: string
  readonly label: string
  readonly args: (question: string) => ReadonlyArray<string>
  readonly stream?: StreamMode | undefined
}

/** Claude emits Anthropic stream events wrapped one per line. */
export const claudeStream: StreamMode = {
  args: (q) => [
    "-p",
    q,
    "--output-format=stream-json",
    "--include-partial-messages",
    "--verbose"
  ],
  extract: (line) => {
    try {
      const parsed = JSON.parse(line) as {
        event?: { type?: string; delta?: { type?: string; text?: string } }
      }
      const event = parsed.event
      if (event?.type !== "content_block_delta") return null
      if (event.delta?.type !== "text_delta") return null
      return event.delta.text ?? null
    } catch {
      return null
    }
  }
}

/** Ordered by how well each one handles a piped-stdin one-shot. */
const CANDIDATES: ReadonlyArray<Candidate> = [
  { id: "claude", label: "claude", args: (q) => ["-p", q], stream: claudeStream },
  { id: "codex", label: "codex", args: (q) => ["exec", q] },
  { id: "qwen", label: "qwen", args: (q) => ["-p", q] },
  { id: "gemini", label: "gemini", args: (q) => ["-p", q] },
  { id: "opencode", label: "opencode", args: (q) => ["run", q] },
  { id: "llm", label: "llm", args: (q) => [q] }
]

/** Places tools install to that a non-login shell often misses. */
const EXTRA_DIRS = [
  "~/.local/bin",
  "~/.bun/bin",
  "~/.cargo/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin"
]

/** PATH first, then the usual install directories. Duplicates are harmless. */
const searchDirs = (path: Path.Path): ReadonlyArray<string> => {
  const home = process.env.HOME ?? ""
  const extra = EXTRA_DIRS.map((dir) =>
    dir.startsWith("~/") ? path.join(home, dir.slice(2)) : dir
  )
  // Path has no `delimiter`, and it is decided by the same thing as `sep`.
  const delimiter = path.sep === "\\" ? ";" : ":"
  return [...(process.env.PATH ?? "").split(delimiter), ...extra].filter(
    (dir) => dir !== ""
  )
}

/**
 * A file the OS will let us run.
 *
 * The executable bit rather than mere existence, so a stray `claude` data file
 * on PATH is not mistaken for the CLI. Anything unreadable is simply not a
 * match, so a permission error here is not worth surfacing.
 */
const isExecutable = (
  fs: FileSystem.FileSystem,
  candidate: string
): Effect.Effect<boolean> =>
  fs.stat(candidate).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: (info) => info.type === "File" && (info.mode & 0o111) !== 0
    })
  )

const resolve = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  bin: string
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const dir of searchDirs(path)) {
      const full = path.join(dir, bin)
      if (yield* isExecutable(fs, full)) return full
    }
    return null
  })

/** Every AI CLI we can find, in preference order. Empty if none installed. */
export const detectTools: Effect.Effect<
  ReadonlyArray<AiTool>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const found: Array<AiTool> = []
  for (const candidate of CANDIDATES) {
    const bin = yield* resolve(fs, path, candidate.id)
    if (bin !== null) found.push({ ...candidate, bin })
  }
  return found
})

export interface Preset {
  readonly key: string
  readonly label: string
  readonly prompt: string
}

export const PRESETS: ReadonlyArray<Preset> = [
  {
    key: "s",
    label: "summarise",
    prompt:
      "Summarise this video transcript in under 200 words. Lead with what it is actually about."
  },
  {
    key: "k",
    label: "key points",
    prompt:
      "List the key points from this video transcript as concise bullets. No preamble."
  },
  {
    key: "a",
    label: "action items",
    prompt:
      "Extract every concrete action item, recommendation, or instruction from this transcript. If there are none, say so."
  },
  {
    key: "c",
    label: "chapters",
    prompt:
      "Break this transcript into chapters. Give each a timestamp and a short title. Use the [mm:ss] markers present in the text."
  }
]

/** The tool could not be started at all. */
export class ToolUnavailable extends Data.TaggedError("ToolUnavailable")<{
  readonly tool: string
  readonly reason: string
}> {}

/** Something outside the app killed the tool before it finished. */
export class ToolKilled extends Data.TaggedError("ToolKilled")<{
  readonly tool: string
}> {}

/** The tool ran and exited non-zero. */
export class ToolFailed extends Data.TaggedError("ToolFailed")<{
  readonly tool: string
  readonly exitCode: number
  readonly stderr: string
}> {}

export type AskError = ToolUnavailable | ToolKilled | ToolFailed

/**
 * Why the spawner said no, in two words.
 *
 * Only the tag. A PlatformError formats itself with the whole argv, and for a
 * streaming tool that argv holds the question the user just typed. None of it
 * belongs in a forty-column panel.
 */
const reasonOf = (error: PlatformError.PlatformError): string => error.reason._tag

/** A sentence to put in the panel. Mirrors `explain` in Youtube.ts. */
export const explainAsk = (error: AskError): string => {
  switch (error._tag) {
    case "ToolUnavailable":
      return `Could not start ${error.tool} (${error.reason}).`
    case "ToolKilled":
      return `${error.tool} was stopped before it finished.`
    case "ToolFailed": {
      const detail = error.stderr.trim().split("\n").slice(-3).join("\n")
      return detail === ""
        ? `${error.tool} exited with code ${error.exitCode}.`
        : `${error.tool} failed:\n${detail}`
    }
  }
}

export interface AskOptions {
  readonly tool: AiTool
  readonly question: string
  readonly transcript: string
  readonly onChunk: (text: string) => void
}

const encoder = new TextEncoder()

/** Lines that carry no prose are the common case, so drop them here. */
const prose = (mode: StreamMode): Filter.Filter<string, string> =>
  Filter.make((line) => {
    if (line.trim() === "") return Result.fail(line)
    const text = mode.extract(line)
    return text === null || text === "" ? Result.fail(line) : Result.succeed(text)
  })

/**
 * Runs one question and pushes stdout through `onChunk` as it arrives.
 *
 * Interrupting the fiber kills the child: the spawn is scoped, so there is no
 * cancel handle to forget to call. stderr is collected rather than streamed,
 * because these CLIs use it for progress spinners that would otherwise shred
 * the panel. It is only surfaced if the process exits non-zero.
 */
export const ask = (
  options: AskOptions
): Effect.Effect<void, AskError, ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const streaming = options.tool.stream
    const argv =
      streaming === undefined
        ? options.tool.args(options.question)
        : streaming.args(options.question)

    const command = ChildProcess.make(options.tool.bin, [...argv], {
      // Written below rather than handed over as a Stream, so the write error
      // is ours to ignore.
      stdin: "pipe",
      // extendEnv defaults to false, and these CLIs need PATH and whatever
      // credential variables their own login wrote.
      env: { NO_COLOR: "1", TERM: "dumb" },
      extendEnv: true
    })

    const handle = yield* spawner.spawn(command)

    // A tool that has read enough closes stdin early, and the rest of the
    // write then fails with EPIPE. That is success, not failure: it got what
    // it needed. Linux raises it where macOS quietly drops it, so ignoring it
    // has to be explicit. Closing stdin is also what tells the tool to begin,
    // which the sink does once the transcript runs out.
    yield* Effect.forkChild(
      Effect.ignore(
        Stream.run(Stream.make(encoder.encode(`${options.transcript}\n`)), handle.stdin)
      )
    )

    const stderr = yield* Effect.forkChild(
      Stream.mkString(Stream.decodeText(handle.stderr))
    )

    const text = Stream.decodeText(handle.stdout)
    const output =
      streaming === undefined
        ? text
        : Stream.filterMap(Stream.splitLines(text), prose(streaming))

    yield* Stream.runForEach(output, (chunk) =>
      Effect.sync(() => options.onChunk(chunk))
    )

    // exitCode only fails when the child died by a signal, which the app's own
    // cancel never reaches: interrupting aborts inside the stream above.
    const code = yield* Effect.catch(handle.exitCode, () => Effect.succeed(null))
    if (code === null) return yield* new ToolKilled({ tool: options.tool.label })
    if (code === 0) return
    return yield* new ToolFailed({
      tool: options.tool.label,
      exitCode: code,
      stderr: yield* Fiber.join(stderr)
    })
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (error) =>
      new ToolUnavailable({ tool: options.tool.label, reason: reasonOf(error) })
    )
  )
