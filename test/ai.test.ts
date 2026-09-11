import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import {
  ask,
  claudeStream,
  detectTools,
  explainAsk,
  PRESETS,
  type AiTool,
  type StreamMode
} from "../src/Ai.ts"
import { DEMO_TRANSCRIPT, isDemoTarget } from "../src/Demo.ts"
import { getTranscript } from "../src/Youtube.ts"
import { format, toParagraphs } from "../src/Format.ts"

const runtime = ManagedRuntime.make(BunServices.layer)

describe("detectTools", () => {
  test("returns well-formed tools, whatever happens to be installed", async () => {
    // The machine running this may have none, so assert the shape, not the set.
    for (const tool of await runtime.runPromise(detectTools)) {
      expect(tool.bin.startsWith("/")).toBe(true)
      expect(tool.id.length).toBeGreaterThan(0)
      expect(tool.args("hello")).toContain("hello")
    }
  })

  test("never reports the same tool twice", async () => {
    const ids = (await runtime.runPromise(detectTools)).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("only reports binaries that are actually executable", async () => {
    // A file on PATH with no execute bit must not be mistaken for a CLI.
    for (const tool of await runtime.runPromise(detectTools)) {
      const info = await Bun.file(tool.bin).stat()
      expect(info.mode & 0o111).toBeGreaterThan(0)
    }
  })
})

describe("PRESETS", () => {
  test("keys are unique and single characters", () => {
    const keys = PRESETS.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toHaveLength(1)
  })

  test("every preset carries a real prompt", () => {
    for (const preset of PRESETS) {
      expect(preset.prompt.length).toBeGreaterThan(20)
      expect(preset.label.length).toBeGreaterThan(0)
    }
  })
})

/**
 * `ask` is exercised against real processes rather than a mock, because every
 * part of it that could break is in the plumbing: the stdin pipe, the line
 * splitting, the exit code, and the kill on interrupt.
 */
describe("ask", () => {
  /** A fake CLI built from /bin/sh, so the script is the tool's behaviour. */
  const shellTool = (
    script: (question: string) => string,
    stream?: StreamMode
  ): AiTool => ({
    id: "fake",
    label: "fake",
    bin: "/bin/sh",
    args: (q) => ["-c", script(q)],
    ...(stream === undefined ? {} : { stream })
  })

  const collect = async (tool: AiTool, transcript = "hello transcript") => {
    const chunks: Array<string> = []
    const result = await runtime.runPromise(
      Effect.result(
        ask({ tool, question: "what is this", transcript, onChunk: (c) => chunks.push(c) })
      )
    )
    return { chunks, text: chunks.join(""), result }
  }

  test("pipes the transcript in on stdin and streams stdout back", async () => {
    const { text, result } = await collect(shellTool(() => "cat"))
    expect(result._tag).toBe("Success")
    expect(text.trim()).toBe("hello transcript")
  })

  test("passes the question through as an argument", async () => {
    const { text } = await collect(shellTool((q) => `printf '%s' "${q}"`))
    expect(text).toBe("what is this")
  })

  test("does not choke on a transcript larger than the pipe buffer", async () => {
    const big = "x".repeat(400_000)
    const { text } = await collect(shellTool(() => "cat"), big)
    expect(text.trim().length).toBe(big.length)
  })

  test("keeps stderr out of the answer when the tool succeeds", async () => {
    // These CLIs draw progress spinners on stderr. None of it may reach the panel.
    const { text } = await collect(
      shellTool(() => "echo spinner >&2; printf 'the answer'")
    )
    expect(text).toBe("the answer")
  })

  test("surfaces stderr only when the tool exits non-zero", async () => {
    const { result } = await collect(shellTool(() => "echo boom >&2; exit 3"))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure).toMatchObject({ _tag: "ToolFailed", exitCode: 3 })
    expect(explainAsk(result.failure)).toContain("boom")
  })

  test("reports a binary that does not exist", async () => {
    const missing: AiTool = {
      id: "nope",
      label: "nope",
      bin: "/nonexistent/definitely-not-here",
      args: (q) => [q]
    }
    const { result } = await collect(missing)
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure).toMatchObject({ _tag: "ToolUnavailable" })
    expect(explainAsk(result.failure)).toContain("nope")
  })

  test("never echoes the question back in an error", async () => {
    // The spawner formats its errors with the whole argv, and for a streaming
    // tool that argv holds the question. The panel must not repeat it.
    const secret = "zzsecretquestionzz"
    const cases: ReadonlyArray<AiTool> = [
      { id: "a", label: "a", bin: "/nonexistent/gone", args: (q) => [q] },
      shellTool(() => "exit 3")
    ]

    for (const tool of cases) {
      const chunks: Array<string> = []
      const result = await runtime.runPromise(
        Effect.result(
          ask({ tool, question: secret, transcript: "t", onChunk: (c) => chunks.push(c) })
        )
      )
      if (result._tag !== "Failure") throw new Error("expected a failure")
      expect(explainAsk(result.failure)).not.toContain(secret)
    }
  })

  test("a tool killed from outside is reported as stopped, not as unstartable", async () => {
    // Only reachable for an external kill. The app's own escape interrupts the
    // fiber, which aborts in the stream and never reads the exit code.
    const pidFile = join(tmpdir(), `yts-kill-${process.pid}-${Date.now()}`)
    const chunks: Array<string> = []
    const running = runtime.runPromise(
      Effect.result(
        ask({
          tool: shellTool(() => `echo $$ > ${pidFile}; printf 'partial'; exec sleep 30`),
          question: "zzsecretquestionzz",
          transcript: "t",
          onChunk: (c) => chunks.push(c)
        })
      )
    )

    let pid = 0
    const started = Date.now()
    while (pid === 0 && Date.now() - started < 5_000) {
      await Bun.sleep(25)
      const text = await Bun.file(pidFile).text().catch(() => "")
      pid = Number.parseInt(text.trim(), 10) || 0
    }
    expect(pid).toBeGreaterThan(0)
    process.kill(pid, "SIGTERM")

    const result = await running
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure).toMatchObject({ _tag: "ToolKilled" })
    // The words already streamed stay, and the question stays out.
    expect(chunks.join("")).toBe("partial")
    expect(explainAsk(result.failure)).not.toContain("zzsecretquestionzz")
    await rm(pidFile, { force: true })
  })

  describe("streaming mode", () => {
    const ndjson = [
      { type: "system", subtype: "init" },
      { event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } },
      { event: { type: "message_start" } },
      { event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } }
    ]

    const emitter = (separately: boolean): StreamMode => ({
      args: () => [
        "-c",
        separately
          ? ndjson.map((o) => `printf '%s\\n'  '${JSON.stringify(o)}'`).join("; ")
          : // %b, so the escapes in the argument become real newlines.
            `printf '%b' '${ndjson.map((o) => JSON.stringify(o)).join("\\n")}\\n'`
      ],
      extract: claudeStream.extract
    })

    test("emits only the prose, one delta at a time", async () => {
      const { chunks, text } = await collect(shellTool(() => "", emitter(true)))
      expect(chunks).toEqual(["Hel", "lo"])
      expect(text).toBe("Hello")
    })

    test("splits lines the same way when they arrive in one write", async () => {
      // The old hand-rolled buffer existed for this. Stream.splitLines owns it now.
      const { chunks } = await collect(shellTool(() => "", emitter(false)))
      expect(chunks).toEqual(["Hel", "lo"])
    })

    test("uses the stream argv, not the plain one", async () => {
      const tool = shellTool(() => "printf 'plain'", {
        args: () => ["-c", "printf '%s\\n' '{\"event\":null}'"],
        extract: () => "streamed"
      })
      const { text } = await collect(tool)
      expect(text).toBe("streamed")
    })
  })

  test("interrupting kills the child instead of leaving it running", async () => {
    // The child reports its own pid before sleeping, so the kill can be checked
    // rather than inferred from how quickly the interrupt returned.
    const pidFile = join(tmpdir(), `yts-ask-${process.pid}-${Date.now()}`)
    const started = Date.now()
    const fiber = runtime.runFork(
      ask({
        tool: shellTool(() => `echo $$ > ${pidFile}; sleep 30`),
        question: "q",
        transcript: "t",
        onChunk: () => {}
      })
    )

    let pid = 0
    while (pid === 0 && Date.now() - started < 5_000) {
      await Bun.sleep(25)
      const text = await Bun.file(pidFile).text().catch(() => "")
      pid = Number.parseInt(text.trim(), 10) || 0
    }
    expect(pid).toBeGreaterThan(0)

    await Effect.runPromise(Fiber.interrupt(fiber))
    await Bun.sleep(200)

    // Signal 0 only checks whether the process is still there.
    expect(() => process.kill(pid, 0)).toThrow()
    await rm(pidFile, { force: true })
  })
})

describe("claude stream parsing", () => {
  test("extracts text from a content_block_delta line", () => {
    const line = JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "El" } }
    })
    expect(claudeStream.extract(line)).toBe("El")
  })

  test("ignores the noise claude interleaves with the answer", () => {
    // Hook output, session init, and message envelopes all arrive on stdout.
    const noise = [
      JSON.stringify({ type: "system", subtype: "hook_started" }),
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop" } }),
      JSON.stringify({ type: "assistant", message: { content: "whole thing" } }),
      "not json at all",
      ""
    ]
    for (const line of noise) expect(claudeStream.extract(line)).toBeNull()
  })

  test("survives a truncated line without throwing", () => {
    expect(claudeStream.extract('{"type":"stream_ev')).toBeNull()
  })

  test("requests partial messages, or nothing would stream", () => {
    const args = claudeStream.args("question")
    expect(args).toContain("--include-partial-messages")
    expect(args).toContain("--output-format=stream-json")
    expect(args).toContain("question")
  })
})

describe("demo fixture", () => {
  test("recognises the spellings someone might type", () => {
    for (const input of ["demo", "DEMO", " demo ", "test", "sample"]) {
      expect(isDemoTarget(input)).toBe(true)
    }
    for (const input of ["demolition", "https://youtu.be/dQw4w9WgXcQ", ""]) {
      expect(isDemoTarget(input)).toBe(false)
    }
  })

  test("resolves without touching the network", async () => {
    const result = await Effect.runPromise(getTranscript("demo"))
    expect(result.client).toBe("DEMO")
    expect(result.cues.length).toBeGreaterThan(20)
  })

  test("cues run forwards in time", () => {
    const cues = DEMO_TRANSCRIPT.cues
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start).toBeGreaterThan(cues[i - 1]!.start)
    }
  })

  test("has pauses long enough to exercise paragraph grouping", () => {
    const paragraphs = toParagraphs(DEMO_TRANSCRIPT.cues)
    expect(paragraphs.length).toBeGreaterThan(3)
    expect(paragraphs.length).toBeLessThan(DEMO_TRANSCRIPT.cues.length)
  })

  test("omits a YouTube source link it does not have", () => {
    const text = format(DEMO_TRANSCRIPT, { format: "text" })
    expect(text).not.toContain("youtube.com/watch")
  })
})
