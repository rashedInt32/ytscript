import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { claudeStream, detectTools, PRESETS } from "../src/Ai.ts"
import { DEMO_TRANSCRIPT, isDemoTarget } from "../src/Demo.ts"
import { getTranscript } from "../src/Youtube.ts"
import { format, toParagraphs } from "../src/Format.ts"

describe("detectTools", () => {
  test("returns well-formed tools, whatever happens to be installed", () => {
    // The machine running this may have none, so assert the shape, not the set.
    for (const tool of detectTools()) {
      expect(tool.bin.startsWith("/")).toBe(true)
      expect(tool.id.length).toBeGreaterThan(0)
      expect(tool.args("hello")).toContain("hello")
    }
  })

  test("never reports the same tool twice", () => {
    const ids = detectTools().map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
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
