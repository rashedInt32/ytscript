/**
 * YouTube caption retrieval.
 *
 * Why these particular clients: the `WEB` client stamps caption URLs with
 * `exp=xpo,xpe`, which gates them behind a Proof-of-Origin token. Those URLs
 * return HTTP 200 with an empty body unless a real browser has run BotGuard
 * first. `ANDROID_VR` and `IOS` hand back ungated URLs, so no token, login,
 * browser, or proxy is required. If YouTube closes that path, the `CLIENTS`
 * array below is the only thing that needs to change.
 */
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"

const PLAYER_ENDPOINT =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false"

export class InvalidUrl extends Data.TaggedError("InvalidUrl")<{
  readonly input: string
}> {}

export class VideoUnavailable extends Data.TaggedError("VideoUnavailable")<{
  readonly reason: string
}> {}

export class NoCaptions extends Data.TaggedError("NoCaptions")<{
  readonly videoId: string
}> {}

export class LanguageNotFound extends Data.TaggedError("LanguageNotFound")<{
  readonly requested: string
  readonly available: ReadonlyArray<string>
}> {}

export class RateLimited extends Data.TaggedError("RateLimited")<{}> {}

/** The ungated client path stopped working. See the note at the top of this file. */
export class CaptionsGated extends Data.TaggedError("CaptionsGated")<{}> {}

export class NetworkError extends Data.TaggedError("NetworkError")<{
  readonly cause: unknown
}> {}

export type TranscriptError =
  | InvalidUrl
  | VideoUnavailable
  | NoCaptions
  | LanguageNotFound
  | RateLimited
  | CaptionsGated
  | NetworkError

export interface CaptionTrack {
  readonly languageCode: string
  readonly name: string
  readonly isGenerated: boolean
  readonly isDefault: boolean
  readonly url: string
}

export interface Cue {
  readonly start: number
  readonly duration: number
  readonly text: string
}

export interface VideoInfo {
  readonly videoId: string
  readonly client: string
  readonly title: string
  readonly author: string
  readonly durationSeconds: number
  readonly tracks: ReadonlyArray<CaptionTrack>
}

export interface Transcript extends VideoInfo {
  readonly track: CaptionTrack
  readonly cues: ReadonlyArray<Cue>
}

interface ClientEntry {
  readonly name: string
  readonly userAgent: string
  readonly client: Record<string, string | number>
}

const CLIENTS: ReadonlyArray<ClientEntry> = [
  {
    name: "ANDROID_VR",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip",
    client: {
      clientName: "ANDROID_VR",
      clientVersion: "1.62.27",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      osName: "Android",
      osVersion: "12L"
    }
  },
  {
    name: "IOS",
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
    client: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82"
    }
  }
]

/** Accepts a bare id, or any of the URL shapes YouTube uses. */
export const parseVideoId = (input: string | null | undefined): string | null => {
  const raw = String(input ?? "").trim()
  if (raw === "") return null
  if (/^[\w-]{11}$/.test(raw)) return raw

  let url: URL
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`)
  } catch {
    return null
  }

  const host = url.hostname.replace(/^www\./, "")
  if (host === "youtu.be") return idOrNull(url.pathname.slice(1))
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return null

  const v = url.searchParams.get("v")
  if (v !== null) return idOrNull(v)

  const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)
  return match ? idOrNull(match[1]!) : null
}

const idOrNull = (value: string): string | null =>
  /^[\w-]{11}$/.test(value) ? value : null

const request = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: (signal) => fetch(url, { ...init, signal }),
    catch: (cause) => new NetworkError({ cause })
  })

const callPlayer = (videoId: string, entry: ClientEntry) =>
  Effect.gen(function* () {
    const response = yield* request(PLAYER_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": entry.userAgent,
        "Accept-Language": "en-US,en"
      },
      body: JSON.stringify({
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        context: { client: { ...entry.client, hl: "en", gl: "US" } }
      })
    })

    if (response.status === 429) return yield* new RateLimited()
    if (!response.ok) {
      return yield* new NetworkError({ cause: `player HTTP ${response.status}` })
    }

    return (yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (cause) => new NetworkError({ cause })
    })) as PlayerResponse
  })

/**
 * Which track the video itself considers primary.
 *
 * A heavily translated video lists its languages alphabetically, so "first
 * track" can easily be Arabic on an English video. YouTube records the real
 * answer against the default audio track, so ask there first.
 */
const defaultTrackIndex = (renderer: CaptionsRenderer): number => {
  const audioTracks = renderer.audioTracks ?? []
  const audioIndex = renderer.defaultAudioTrackIndex ?? 0
  const fromAudio = audioTracks[audioIndex]?.defaultCaptionTrackIndex
  if (Number.isInteger(fromAudio)) return fromAudio as number
  if (Number.isInteger(renderer.defaultCaptionTrackIndex)) {
    return renderer.defaultCaptionTrackIndex as number
  }
  return -1
}

/** Tries each client in turn and keeps the first that yields caption tracks. */
export const fetchVideoInfo = (
  videoId: string
): Effect.Effect<VideoInfo, TranscriptError> =>
  Effect.gen(function* () {
    let lastFailure: string | null = null
    let lastError: TranscriptError | null = null

    for (const entry of CLIENTS) {
      // One client throttling or erroring must not abort the fallback chain.
      // The whole point of the list is that the next entry may still work.
      const attempt = yield* Effect.result(callPlayer(videoId, entry))
      if (attempt._tag === "Failure") {
        lastError = attempt.failure
        continue
      }
      const data = attempt.success

      const status = data.playabilityStatus?.status
      if (status !== "OK") {
        lastFailure = data.playabilityStatus?.reason ?? status ?? "unknown"
        continue
      }

      const renderer = data.captions?.playerCaptionsTracklistRenderer
      const rawTracks = renderer?.captionTracks ?? []
      if (renderer === undefined || rawTracks.length === 0) continue

      const preferred = defaultTrackIndex(renderer)
      const details = data.videoDetails ?? {}

      return {
        videoId,
        client: entry.name,
        title: details.title ?? "Untitled",
        author: details.author ?? "Unknown",
        durationSeconds: Number(details.lengthSeconds ?? 0),
        tracks: rawTracks.map((track, index) => ({
          languageCode: track.languageCode,
          name:
            track.name?.simpleText ??
            track.name?.runs?.[0]?.text ??
            track.languageCode,
          isGenerated: track.kind === "asr",
          isDefault: index === preferred,
          url: track.baseUrl
        }))
      }
    }

    // A real answer from YouTube beats a transport failure when reporting why.
    if (lastFailure !== null) {
      return yield* new VideoUnavailable({ reason: lastFailure })
    }
    if (lastError !== null) return yield* lastError
    return yield* new NoCaptions({ videoId })
  })

/**
 * Picks the best track for `lang`. Prefers human-written over auto-generated,
 * and an exact language match over a regional variant.
 */
export const selectTrack = (
  tracks: ReadonlyArray<CaptionTrack>,
  lang?: string | undefined
): CaptionTrack | null => {
  if (lang === undefined || lang === "") {
    return (
      tracks.find((t) => t.isDefault) ??
      tracks.find((t) => !t.isGenerated) ??
      tracks[0] ??
      null
    )
  }

  const want = lang.toLowerCase()
  const base = want.split("-")[0]
  const ranked: ReadonlyArray<(t: CaptionTrack) => boolean> = [
    (t) => t.languageCode.toLowerCase() === want && !t.isGenerated,
    (t) => t.languageCode.toLowerCase() === want,
    (t) => t.languageCode.toLowerCase().split("-")[0] === base && !t.isGenerated,
    (t) => t.languageCode.toLowerCase().split("-")[0] === base
  ]

  for (const matches of ranked) {
    const hit = tracks.find(matches)
    if (hit !== undefined) return hit
  }
  return null
}

/** Downloads one track as cues. `translateTo` uses YouTube's own translation. */
export const fetchCues = (
  track: CaptionTrack,
  translateTo?: string | undefined
): Effect.Effect<ReadonlyArray<Cue>, TranscriptError> =>
  Effect.gen(function* () {
    const url = new URL(track.url)
    url.searchParams.set("fmt", "json3")
    if (translateTo !== undefined && translateTo !== "") {
      url.searchParams.set("tlang", translateTo)
    }

    const response = yield* request(url.toString(), {
      headers: { "Accept-Language": "en-US,en" }
    })

    if (response.status === 429) return yield* new RateLimited()
    if (!response.ok) {
      return yield* new NetworkError({ cause: `caption HTTP ${response.status}` })
    }

    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) => new NetworkError({ cause })
    })

    // An empty 200 is YouTube's signature for a PO-token-gated URL.
    if (body.trim() === "") return yield* new CaptionsGated()

    const parsed = yield* Effect.try({
      try: () => JSON.parse(body) as CaptionResponse,
      catch: (cause) => new NetworkError({ cause })
    })

    const cues: Array<Cue> = []
    for (const event of parsed.events ?? []) {
      if (event.segs === undefined) continue
      const text = event.segs
        .map((seg) => seg.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (text === "") continue
      cues.push({
        start: (event.tStartMs ?? 0) / 1000,
        duration: (event.dDurationMs ?? 0) / 1000,
        text
      })
    }

    if (cues.length === 0) return yield* new CaptionsGated()
    return cues
  })

export interface GetTranscriptOptions {
  readonly lang?: string | undefined
  readonly translateTo?: string | undefined
  /** Retry through YouTube's throttling instead of failing immediately. */
  readonly retryRateLimit?: boolean | undefined
}

/**
 * Full pipeline: url -> info -> track -> cues.
 *
 * Rate limiting is the one failure worth retrying, and it is common enough
 * when transcribing several videos back to back that handling it here saves
 * every caller from writing the same loop.
 */
export const getTranscript = (
  input: string,
  options: GetTranscriptOptions = {}
): Effect.Effect<Transcript, TranscriptError> => {
  const program = Effect.gen(function* () {
    const videoId = parseVideoId(input)
    if (videoId === null) return yield* new InvalidUrl({ input })

    const info = yield* fetchVideoInfo(videoId)
    const track = selectTrack(info.tracks, options.lang)
    if (track === null) {
      return yield* new LanguageNotFound({
        requested: options.lang!,
        available: info.tracks.map((t) => t.languageCode)
      })
    }

    const cues = yield* fetchCues(track, options.translateTo)
    return { ...info, track, cues }
  })

  // Measured against live throttling: a 2s/4s/8s backoff gives up well before
  // YouTube lets you back in. 5s doubling across four attempts covers ~75s.
  return options.retryRateLimit === true
    ? Effect.retry(program, {
        while: (error: TranscriptError) => error._tag === "RateLimited",
        schedule: Schedule.exponential("5 seconds"),
        times: 4
      })
    : program
}

/** Human-readable text for any domain error. */
export const explain = (error: TranscriptError): string => {
  switch (error._tag) {
    case "InvalidUrl":
      return `Not a YouTube video: ${error.input}`
    case "VideoUnavailable":
      return `Video unavailable: ${error.reason}`
    case "NoCaptions":
      return "This video has no captions."
    case "LanguageNotFound":
      return `No "${error.requested}" captions. Available: ${error.available.join(", ")}`
    case "RateLimited":
      // No flag hint here: the app already retries, so the advice would be wrong.
      return "YouTube is rate limiting this IP. Wait a few minutes and try again."
    case "CaptionsGated":
      return "YouTube returned an empty caption body. The ungated client path may have changed."
    case "NetworkError":
      return `Network problem: ${String(error.cause)}`
  }
}

// Shapes of the slices of YouTube's response that we actually read.

interface PlayerResponse {
  readonly playabilityStatus?: { readonly status?: string; readonly reason?: string }
  readonly videoDetails?: {
    readonly title?: string
    readonly author?: string
    readonly lengthSeconds?: string
  }
  readonly captions?: { readonly playerCaptionsTracklistRenderer?: CaptionsRenderer }
}

interface CaptionsRenderer {
  readonly captionTracks?: ReadonlyArray<{
    readonly languageCode: string
    readonly baseUrl: string
    readonly kind?: string
    readonly name?: {
      readonly simpleText?: string
      readonly runs?: ReadonlyArray<{ readonly text: string }>
    }
  }>
  readonly audioTracks?: ReadonlyArray<{
    readonly defaultCaptionTrackIndex?: number
  }>
  readonly defaultAudioTrackIndex?: number
  readonly defaultCaptionTrackIndex?: number
}

interface CaptionResponse {
  readonly events?: ReadonlyArray<{
    readonly tStartMs?: number
    readonly dDurationMs?: number
    readonly segs?: ReadonlyArray<{ readonly utf8?: string }>
  }>
}
