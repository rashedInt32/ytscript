/**
 * Output formats.
 *
 * `text` is the default because it is the one a language model reads best: no
 * cue numbers, no timestamps, just prose broken where the speaker paused.
 * A typical SRT spends roughly a third of its characters on timing metadata
 * that a model does not need, and that is a third of your context window.
 *
 * These are pure functions on purpose. Nothing here touches the network or the
 * process, so it is all trivially testable.
 */
import type { Cue, Transcript } from "./Youtube.ts"

/** A gap this long between cues reads as a paragraph break. */
const PAUSE_SECONDS = 2.5
/** Force a break in continuous speech so paragraphs stay scannable. */
const MAX_PARAGRAPH_CHARS = 700

export const FORMATS = ["text", "ts", "md", "srt", "vtt", "json"] as const
export type FormatName = (typeof FORMATS)[number]

export const isFormatName = (value: string): value is FormatName =>
  (FORMATS as ReadonlyArray<string>).includes(value)

export interface FormatOptions {
  readonly format?: FormatName | undefined
  readonly wrapWidth?: number | undefined
}

export interface Paragraph {
  readonly start: number
  readonly text: string
}

export const formatTimestamp = (
  seconds: number,
  options: { readonly alwaysHours?: boolean } = {}
): string => {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return hours > 0 || options.alwaysHours === true
    ? `${pad(hours)}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`
}

const srtTime = (seconds: number): string => {
  const ms = Math.floor((seconds % 1) * 1000)
  return `${formatTimestamp(seconds, { alwaysHours: true })},${String(ms).padStart(3, "0")}`
}

const vttTime = (seconds: number): string => {
  const ms = Math.floor((seconds % 1) * 1000)
  return `${formatTimestamp(seconds, { alwaysHours: true })}.${String(ms).padStart(3, "0")}`
}

/** Groups cues into paragraphs on speaker pauses. */
export const toParagraphs = (cues: ReadonlyArray<Cue>): ReadonlyArray<Paragraph> => {
  const paragraphs: Array<Paragraph> = []
  let current: { start: number; parts: Array<string> } | null = null
  let previousEnd: number | null = null

  for (const cue of cues) {
    const gap = previousEnd === null ? 0 : cue.start - previousEnd
    const tooLong =
      current !== null && current.parts.join(" ").length >= MAX_PARAGRAPH_CHARS

    if (current !== null && (gap >= PAUSE_SECONDS || tooLong)) {
      paragraphs.push({ start: current.start, text: current.parts.join(" ") })
      current = null
    }
    if (current === null) current = { start: cue.start, parts: [] }
    current.parts.push(cue.text)
    previousEnd = cue.start + cue.duration
  }

  if (current !== null) {
    paragraphs.push({ start: current.start, text: current.parts.join(" ") })
  }
  return paragraphs
}

export const wrap = (text: string, width: number | undefined): string => {
  if (width === undefined || width <= 0) return text
  // Preserve the caller's own line breaks; only fill within each of them.
  if (text.includes("\n")) {
    return text
      .split("\n")
      .map((line) => wrap(line, width))
      .join("\n")
  }
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line)
      line = word
    } else {
      line = line === "" ? word : `${line} ${word}`
    }
  }
  if (line !== "") lines.push(line)
  return lines.join("\n")
}

export const buildHeader = (transcript: Transcript): string => {
  const duration = formatTimestamp(transcript.durationSeconds)
  const kind = transcript.track.isGenerated ? "auto-generated" : "human-written"
  const lines = [
    `# ${transcript.title}`,
    `Channel: ${transcript.author} | Duration: ${duration} | Captions: ${transcript.track.languageCode} (${kind})`
  ]
  // The built-in sample has no YouTube page to point at.
  if (transcript.client !== "DEMO") {
    lines.push(`Source: https://www.youtube.com/watch?v=${transcript.videoId}`)
  }
  return lines.join("\n")
}

const formatters: Record<
  FormatName,
  (transcript: Transcript, options: FormatOptions) => string
> = {
  text: (transcript, options) =>
    toParagraphs(transcript.cues)
      .map((p) => wrap(p.text, options.wrapWidth))
      .join("\n\n"),

  ts: (transcript, options) =>
    toParagraphs(transcript.cues)
      .map((p) => {
        const stamp = `[${formatTimestamp(p.start)}]`
        const indent = " ".repeat(stamp.length + 1)
        const body = wrap(p.text, options.wrapWidth).replace(/\n/g, `\n${indent}`)
        return `${stamp} ${body}`
      })
      .join("\n\n"),

  md: (transcript, options) =>
    toParagraphs(transcript.cues)
      .map((p) => {
        const url = `https://youtu.be/${transcript.videoId}?t=${Math.floor(p.start)}`
        const link = `**[${formatTimestamp(p.start)}](${url})**`
        return `${link} ${wrap(p.text, options.wrapWidth)}`
      })
      .join("\n\n"),

  srt: (transcript) =>
    transcript.cues
      .map((cue, i) => {
        const end = cue.start + (cue.duration || 2)
        return `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(end)}\n${cue.text}`
      })
      .join("\n\n"),

  vtt: (transcript) => {
    const body = transcript.cues
      .map((cue) => {
        const end = cue.start + (cue.duration || 2)
        return `${vttTime(cue.start)} --> ${vttTime(end)}\n${cue.text}`
      })
      .join("\n\n")
    return `WEBVTT\n\n${body}`
  },

  json: (transcript) =>
    JSON.stringify(
      {
        videoId: transcript.videoId,
        title: transcript.title,
        author: transcript.author,
        durationSeconds: transcript.durationSeconds,
        language: transcript.track.languageCode,
        isGenerated: transcript.track.isGenerated,
        cues: transcript.cues
      },
      null,
      2
    )
}

export const format = (
  transcript: Transcript,
  options: FormatOptions = {}
): string => formatters[options.format ?? "text"](transcript, options)

/** Rough token count. Good enough to decide whether a paste will fit. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/** Splits long output so each piece fits a context window. */
export const chunk = (text: string, maxTokens: number): ReadonlyArray<string> => {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return [text]

  const parts: Array<string> = []
  let current = ""

  for (const block of text.split("\n\n")) {
    if (current !== "" && current.length + block.length + 2 > maxChars) {
      parts.push(current)
      current = block
    } else {
      current = current === "" ? block : `${current}\n\n${block}`
    }
  }
  if (current !== "") parts.push(current)
  return parts
}
