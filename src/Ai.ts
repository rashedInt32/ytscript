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
 */
import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

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
  join(process.env.HOME ?? "", ".local/bin"),
  join(process.env.HOME ?? "", ".bun/bin"),
  join(process.env.HOME ?? "", ".cargo/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin"
]

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const resolve = (bin: string): string | null => {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS]
  for (const dir of dirs) {
    if (dir === "") continue
    const full = join(dir, bin)
    if (isExecutable(full)) return full
  }
  return null
}

/** Every AI CLI we can find, in preference order. Empty if none installed. */
export const detectTools = (): ReadonlyArray<AiTool> => {
  const found: Array<AiTool> = []
  for (const candidate of CANDIDATES) {
    const bin = resolve(candidate.id)
    if (bin !== null) {
      found.push({
        id: candidate.id,
        label: candidate.label,
        bin,
        args: candidate.args,
        stream: candidate.stream
      })
    }
  }
  return found
}

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

export interface AskHandle {
  /** Kills the process. Safe to call after it has already exited. */
  readonly cancel: () => void
}

export interface AskOptions {
  readonly tool: AiTool
  readonly question: string
  readonly transcript: string
  readonly onChunk: (text: string) => void
  readonly onDone: (error: string | null) => void
}

/**
 * Runs one question and streams stdout back through `onChunk`.
 *
 * stderr is collected rather than streamed, because these CLIs use it for
 * progress spinners that would otherwise shred the panel. It is only surfaced
 * if the process exits non-zero.
 */
export const ask = (options: AskOptions): AskHandle => {
  const streaming = options.tool.stream
  const argv =
    streaming === undefined
      ? options.tool.args(options.question)
      : streaming.args(options.question)

  let child: ChildProcess
  try {
    child = spawn(options.tool.bin, [...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" }
    })
  } catch (error) {
    options.onDone(`Could not start ${options.tool.label}: ${String(error)}`)
    return { cancel: () => {} }
  }

  let stderr = ""
  let settled = false

  const finish = (error: string | null): void => {
    if (settled) return
    settled = true
    options.onDone(error)
  }

  child.stdout?.setEncoding("utf8")
  if (streaming === undefined) {
    child.stdout?.on("data", (chunk: string) => options.onChunk(chunk))
  } else {
    // NDJSON arrives in arbitrary slices, so hold the trailing partial line.
    let pending = ""
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      for (const line of parts) {
        if (line.trim() === "") continue
        const text = streaming.extract(line)
        if (text !== null && text !== "") options.onChunk(text)
      }
    })
  }
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })

  child.on("error", (error) => {
    finish(`${options.tool.label} failed to run: ${error.message}`)
  })

  child.on("close", (code) => {
    if (code === 0 || code === null) finish(null)
    else {
      const detail = stderr.trim().split("\n").slice(-3).join("\n")
      finish(
        detail === ""
          ? `${options.tool.label} exited with code ${code}.`
          : `${options.tool.label} failed:\n${detail}`
      )
    }
  })

  // A long transcript can outrun the pipe buffer, so ignore EPIPE if the tool
  // decides it has read enough and closes stdin early.
  child.stdin?.on("error", () => {})
  child.stdin?.end(`${options.transcript}\n`)

  return {
    cancel: () => {
      if (!settled) child.kill("SIGTERM")
      finish(null)
    }
  }
}
