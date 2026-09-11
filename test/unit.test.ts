import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import {
  chunk,
  estimateTokens,
  format,
  formatTimestamp,
  toParagraphs
} from "../src/Format.ts"
import {
  explain,
  getTranscript,
  parseVideoId,
  selectTrack,
  type CaptionTrack,
  type Transcript
} from "../src/Youtube.ts"

const track = (over: Partial<CaptionTrack> = {}): CaptionTrack => ({
  languageCode: "en",
  name: "English",
  isGenerated: false,
  isDefault: false,
  url: "https://example.com/captions",
  ...over
})

describe("parseVideoId", () => {
  const id = "dQw4w9WgXcQ"

  test("accepts every URL shape YouTube uses", () => {
    for (const input of [
      id,
      `https://youtu.be/${id}`,
      `https://www.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/watch?v=${id}&t=42s`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://music.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/live/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
      `youtube.com/watch?v=${id}`,
      `  https://youtu.be/${id}  `
    ]) {
      expect(parseVideoId(input)).toBe(id)
    }
  })

  test("rejects non-YouTube hosts and malformed input", () => {
    for (const input of [
      `https://example.com/watch?v=${id}`,
      `https://notyoutube.com/watch?v=${id}`,
      "https://www.youtube.com/watch?v=tooshort",
      "https://www.youtube.com/feed/subscriptions",
      "not a url",
      "",
      null,
      undefined
    ]) {
      expect(parseVideoId(input)).toBeNull()
    }
  })
})

describe("selectTrack", () => {
  test("prefers the video default over alphabetical order", () => {
    // Regression: a heavily translated video listed Arabic first, so the
    // naive "first track" rule returned Arabic for an English video.
    const tracks = [
      track({ languageCode: "ar" }),
      track({ languageCode: "en", isDefault: true }),
      track({ languageCode: "ja" })
    ]
    expect(selectTrack(tracks)?.languageCode).toBe("en")
  })

  test("prefers human-written over auto-generated", () => {
    const tracks = [track({ isGenerated: true }), track({ isGenerated: false })]
    expect(selectTrack(tracks, "en")?.isGenerated).toBe(false)
  })

  test("falls back to a regional variant", () => {
    const tracks = [track({ languageCode: "pt-BR" })]
    expect(selectTrack(tracks, "pt")?.languageCode).toBe("pt-BR")
  })

  test("returns null when the language is absent", () => {
    expect(selectTrack([track()], "zz")).toBeNull()
  })

  test("returns null for an empty track list", () => {
    expect(selectTrack([])).toBeNull()
  })
})

describe("toParagraphs", () => {
  test("breaks on speaker pauses", () => {
    const paragraphs = toParagraphs([
      { start: 0, duration: 1, text: "one" },
      { start: 1, duration: 1, text: "two" },
      { start: 10, duration: 1, text: "three" }
    ])
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0]!.text).toBe("one two")
    expect(paragraphs[1]).toEqual({ start: 10, text: "three" })
  })

  test("handles empty and single-cue input", () => {
    expect(toParagraphs([])).toEqual([])
    expect(toParagraphs([{ start: 5, duration: 1, text: "solo" }])).toHaveLength(1)
  })

  test("splits runaway speech that never pauses", () => {
    const cues = Array.from({ length: 200 }, (_, i) => ({
      start: i,
      duration: 1,
      text: "word"
    }))
    expect(toParagraphs(cues).length).toBeGreaterThan(1)
  })
})

describe("formatTimestamp", () => {
  test("adds hours only when needed", () => {
    expect(formatTimestamp(0)).toBe("0:00")
    expect(formatTimestamp(61)).toBe("1:01")
    expect(formatTimestamp(3661)).toBe("01:01:01")
    expect(formatTimestamp(61, { alwaysHours: true })).toBe("00:01:01")
  })
})

describe("chunk", () => {
  test("keeps short text whole", () => {
    expect(chunk("short", 100)).toEqual(["short"])
  })

  test("splits long text without losing content", () => {
    const block = "x".repeat(200)
    const source = [block, block, block].join("\n\n")
    const parts = chunk(source, 100)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join("\n\n")).toBe(source)
  })
})

describe("format", () => {
  const transcript: Transcript = {
    videoId: "dQw4w9WgXcQ",
    client: "IOS",
    title: "Test",
    author: "Someone",
    durationSeconds: 90,
    tracks: [],
    track: track(),
    cues: [
      { start: 0, duration: 2, text: "hello there" },
      { start: 30, duration: 2, text: "second thought" }
    ]
  }

  test("text output carries no timing metadata", () => {
    const out = format(transcript, { format: "text" })
    expect(out).toBe("hello there\n\nsecond thought")
    expect(out).not.toContain("-->")
    expect(out).not.toContain("[0:00]")
  })

  test("ts output stamps each paragraph", () => {
    expect(format(transcript, { format: "ts" })).toContain("[0:30] second thought")
  })

  test("md output links to the right second", () => {
    expect(format(transcript, { format: "md" })).toContain(
      "https://youtu.be/dQw4w9WgXcQ?t=30"
    )
  })

  test("srt numbers cues from one", () => {
    const out = format(transcript, { format: "srt" })
    expect(out.startsWith("1\n00:00:00,000 --> 00:00:02,000\nhello there")).toBe(true)
  })

  test("vtt starts with the required magic line", () => {
    expect(format(transcript, { format: "vtt" }).startsWith("WEBVTT\n\n")).toBe(true)
  })

  test("json round-trips the cues", () => {
    const parsed = JSON.parse(format(transcript, { format: "json" }))
    expect(parsed.cues).toHaveLength(2)
    expect(parsed.language).toBe("en")
  })

  test("text is cheaper than srt for the same content", () => {
    const text = estimateTokens(format(transcript, { format: "text" }))
    const srt = estimateTokens(format(transcript, { format: "srt" }))
    expect(text).toBeLessThan(srt)
  })
})

describe("errors", () => {
  test("a bad URL fails with InvalidUrl before any network call", async () => {
    const result = await Effect.runPromise(
      Effect.result(getTranscript("not a youtube url"))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("InvalidUrl")
      expect(explain(result.failure)).toContain("Not a YouTube video")
    }
  })

  test("every error tag has a human-readable message", () => {
    const samples = [
      { _tag: "InvalidUrl", input: "x" },
      { _tag: "VideoUnavailable", reason: "private" },
      { _tag: "NoCaptions", videoId: "x" },
      { _tag: "LanguageNotFound", requested: "zz", available: ["en"] },
      { _tag: "RateLimited" },
      { _tag: "CaptionsGated" },
      { _tag: "NetworkError", cause: "boom" }
    ] as const
    for (const sample of samples) {
      const message = explain(sample as never)
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toContain("undefined")
    }
  })
})
