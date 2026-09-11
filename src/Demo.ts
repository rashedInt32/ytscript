/**
 * A built-in sample transcript.
 *
 * `ytt demo` exercises the whole flow — reader, search, timestamps, copy, and
 * the ask-ai panel — without touching YouTube. That matters because the
 * caption endpoint throttles hard, and being rate limited should never stop
 * you from working on the app itself.
 *
 * The gaps between cues are deliberate: several exceed the paragraph-break
 * threshold, so the grouping logic gets exercised too.
 */
import type { Cue, Transcript } from "./Youtube.ts"

const cue = (start: number, duration: number, text: string): Cue => ({
  start,
  duration,
  text
})

const CUES: ReadonlyArray<Cue> = [
  cue(2, 4, "Right, let's get started."),
  cue(6.2, 5, "I want to talk about why most internal tools die within a year."),

  cue(14, 4.5, "The first reason is that they solve a problem nobody re-checked."),
  cue(18.8, 5, "Someone felt the pain in March, built the thing in June,"),
  cue(24, 4, "and by then the team had already worked around it."),

  cue(32, 5, "The second reason is authentication."),
  cue(37.4, 5.5, "You add login because it seems responsible, and now you own accounts,"),
  cue(43.2, 4.5, "password resets, session storage, and a support burden."),
  cue(48, 4, "Nine times out of ten the tool did not need to know who you are."),

  cue(56, 4.5, "The third reason is that it runs on someone else's machine."),
  cue(60.8, 5, "A server means a bill, and a bill means somebody eventually asks"),
  cue(66, 4.5, "whether forty dollars a month is worth it. It never survives that question."),

  cue(74, 5, "So here is what I would do differently, and this is the actual advice."),
  cue(79.4, 4.5, "Run it on the user's machine. Their laptop is free and already trusted."),
  cue(84.2, 5, "Ship a command line tool before you ship a web app."),
  cue(89.5, 4.5, "You will learn what people actually want in about a week."),

  cue(97, 5, "Second, do not add accounts until someone asks for them twice."),
  cue(102.4, 5, "Not once. Twice. The first ask is usually a habit, not a need."),

  cue(110, 4.5, "Third, write down what breaks when the vendor changes something,"),
  cue(115, 5, "because they will, and the person fixing it will not be you."),
  cue(120.5, 4, "Put it in the readme, not in your head."),

  cue(128, 4.5, "One more thing, and then I will take questions."),
  cue(133, 5.5, "Measure the thing before you optimise it. I have watched three teams"),
  cue(139, 5, "spend a quarter on caching that saved eleven milliseconds."),
  cue(144.4, 4, "Nobody measured first. Everybody was certain."),

  cue(152, 4, "That's it. Build small, own less, write it down.")
]

export const DEMO_ID = "demo"

export const DEMO_TRANSCRIPT: Transcript = {
  videoId: DEMO_ID,
  client: "DEMO",
  title: "Why internal tools die (sample transcript)",
  author: "yt-transcript demo",
  durationSeconds: 158,
  tracks: [
    {
      languageCode: "en",
      name: "English",
      isGenerated: false,
      isDefault: true,
      url: "demo://captions/en"
    },
    {
      languageCode: "es",
      name: "Spanish",
      isGenerated: false,
      isDefault: false,
      url: "demo://captions/es"
    }
  ],
  track: {
    languageCode: "en",
    name: "English",
    isGenerated: false,
    isDefault: true,
    url: "demo://captions/en"
  },
  cues: CUES
}

/** True for the handful of spellings someone might reasonably type. */
export const isDemoTarget = (input: string): boolean =>
  ["demo", "test", "sample"].includes(input.trim().toLowerCase())
