/**
 * Terminal animation.
 *
 * A terminal agent spends most of its time waiting on a model or a tool, and the
 * quality of that waiting experience is a surprisingly large part of how the tool
 * feels. A frozen screen reads as "crashed"; a moving one reads as "working".
 *
 * The whole subsystem is built on three ideas:
 *
 *  1. **One clock.** Every animated element derives its frame from a single
 *    monotonic timestamp rather than owning a timer. Independent timers drift
 *    apart, and twenty of them wake the event loop twenty times as often. One
 *    ticker at a fixed interval drives everything and stops entirely when nothing
 *    is animating.
 *  2. **Frames are pure functions of time.** `frame(elapsed)` rather than
 *    `next()`. That makes animation stateless, resumable after a resize, and
 *    trivially correct when the render loop skips a beat under load.
 *  3. **Degrade honestly.** Not every terminal renders Braille, not every user
 *    wants motion, and a CI log should contain no escape codes at all. Each
 *    spinner declares an ASCII fallback and the whole system can be switched off,
 *    in which case animated elements render a sensible static frame rather than
 *    disappearing.
 *
 * Nothing here writes to the terminal. Animations produce strings; the renderer
 * decides what to do with them. That separation is what lets the same spinner
 * appear in the TUI, in `run` mode, and in a plain log line.
 */

import { stringWidth } from "../util/wcwidth.js"

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

/**
 * Monotonic milliseconds.
 *
 * `performance.now` rather than `Date.now` because the wall clock can jump
 * backwards (NTP, daylight saving, a suspended laptop) and an animation that
 * jumps backwards looks broken.
 */
export function now(): number {
  return performance.now()
}

export type TickListener = (elapsed: number) => void

/**
 * The shared animation clock.
 *
 * Starts on the first subscriber and stops on the last, so an idle TUI does not
 * wake the event loop at all. The timer is unref'd: a pending animation frame
 * must never keep the process alive after the user quits.
 */
class Ticker {
  private listeners = new Set<TickListener>()
  private timer: NodeJS.Timeout | undefined
  private started = 0
  private intervalMs = 80

  /** Frame interval. 80 ms is about 12 fps, which reads as smooth for glyph animation. */
  setInterval(ms: number): void {
    this.intervalMs = Math.max(16, Math.min(1_000, ms))
    if (this.timer) {
      this.stop()
      this.start()
    }
  }

  subscribe(listener: TickListener): () => void {
    this.listeners.add(listener)
    this.start()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private start(): void {
    if (this.timer) return
    this.started = now()
    this.timer = setInterval(() => {
      const elapsed = now() - this.started
      for (const listener of this.listeners) {
        try {
          listener(elapsed)
        } catch {
          // A throwing listener must not stop every other animation.
        }
      }
    }, this.intervalMs)
    this.timer.unref?.()
  }

  private stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  get running(): boolean {
    return this.timer !== undefined
  }
}

export const ticker = new Ticker()

/* ------------------------------------------------------------------ */
/* Global switches                                                     */
/* ------------------------------------------------------------------ */

let animationsEnabled = true
let unicodeEnabled = true

/**
 * Turns motion off.
 *
 * Respected for accessibility (`prefers-reduced-motion` has no terminal
 * equivalent, so this is a setting), for CI, and for any non-TTY output where
 * repeated redraws would produce thousands of junk lines in a log file.
 */
export function setAnimationsEnabled(enabled: boolean): void {
  animationsEnabled = enabled
}

export function animationsAreEnabled(): boolean {
  return animationsEnabled
}

/**
 * Declares whether the terminal can render the fancy glyphs.
 *
 * Braille and block-drawing characters are widely but not universally supported;
 * Windows consoles without a suitable font render them as boxes, which looks far
 * worse than plain ASCII.
 */
export function setUnicodeEnabled(enabled: boolean): void {
  unicodeEnabled = enabled
}

/* ------------------------------------------------------------------ */
/* Spinners                                                            */
/* ------------------------------------------------------------------ */

export interface SpinnerDefinition {
  readonly name: string
  readonly frames: readonly string[]
  /** Milliseconds per frame. */
  readonly interval: number
  /** Frames used when the terminal cannot render the primary set. */
  readonly ascii?: readonly string[]
  /** Display width of a frame, for layout. All frames must be the same width. */
  readonly width?: number
}

/**
 * The spinner catalogue.
 *
 * More than strictly necessary, deliberately. The spinner is the single most
 * visible piece of the interface and taste in it varies enormously; making it
 * configurable costs a table of strings and removes a whole category of
 * complaint. Each entry is chosen so that every frame has the same display width,
 * because a spinner that changes width makes the text after it jitter.
 */
export const SPINNERS: Record<string, SpinnerDefinition> = {
  /** The default. Dense, smooth, and universally recognised. */
  braille: {
    name: "braille",
    frames: ["\u280b", "\u2819", "\u2839", "\u2838", "\u283c", "\u2834", "\u2826", "\u2827", "\u2807", "\u280f"],
    interval: 80,
    ascii: ["-", "\\", "|", "/"],
    width: 1,
  },

  /** Slower Braille with a heavier pattern; reads as "thinking hard". */
  brailleHeavy: {
    name: "brailleHeavy",
    frames: ["\u28fe", "\u28fd", "\u28fb", "\u28bf", "\u287f", "\u28df", "\u28ef", "\u28f7"],
    interval: 90,
    ascii: ["-", "\\", "|", "/"],
    width: 1,
  },

  /** A dot travelling around a circle. Calm. */
  dots: {
    name: "dots",
    frames: ["\u2801", "\u2802", "\u2804", "\u2840", "\u2880", "\u2820", "\u2810", "\u2808"],
    interval: 100,
    ascii: [".", "o", "O", "o"],
    width: 1,
  },

  /** Vertical bar growing and shrinking. Good next to a progress figure. */
  bar: {
    name: "bar",
    frames: ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588", "\u2587", "\u2586", "\u2585", "\u2584", "\u2583", "\u2582"],
    interval: 70,
    ascii: ["_", "-", "=", "#", "=", "-"],
    width: 1,
  },

  /** Classic ASCII. Works absolutely everywhere. */
  line: {
    name: "line",
    frames: ["-", "\\", "|", "/"],
    interval: 110,
    width: 1,
  },

  /** Rotating half-circles. Slightly playful. */
  moon: {
    name: "moon",
    frames: ["\u25d0", "\u25d3", "\u25d1", "\u25d2"],
    interval: 120,
    ascii: ["(", "|", ")", "|"],
    width: 1,
  },

  /** Pulsing block, from faint to solid. Reads as a heartbeat. */
  pulse: {
    name: "pulse",
    frames: ["\u2591", "\u2592", "\u2593", "\u2588", "\u2593", "\u2592"],
    interval: 120,
    ascii: [".", ":", "*", "#", "*", ":"],
    width: 1,
  },

  /** A star opening and closing. Used for the "done" flourish. */
  bloom: {
    name: "bloom",
    frames: ["\u00b7", "\u2218", "\u25cb", "\u25cf", "\u2726", "\u2727", "\u2726", "\u25cf", "\u25cb", "\u2218"],
    interval: 100,
    ascii: [".", "o", "O", "*", "O", "o"],
    width: 1,
  },

  /** Four-arm pinwheel. Fast and mechanical. */
  pinwheel: {
    name: "pinwheel",
    frames: ["\u2534", "\u2524", "\u252c", "\u251c"],
    interval: 90,
    ascii: ["-", "|", "-", "|"],
    width: 1,
  },

  /** Arrow cycling through the compass. Suggests direction and progress. */
  arrow: {
    name: "arrow",
    frames: ["\u2190", "\u2196", "\u2191", "\u2197", "\u2192", "\u2198", "\u2193", "\u2199"],
    interval: 110,
    ascii: ["<", "^", ">", "v"],
    width: 1,
  },

  /** Growing triangle. Distinct from everything else, good for errors retrying. */
  triangle: {
    name: "triangle",
    frames: ["\u25e2", "\u25e3", "\u25e4", "\u25e5"],
    interval: 130,
    ascii: ["\\", "/", "\\", "/"],
    width: 1,
  },

  /** Bouncing ball inside brackets. Three cells wide. */
  bounce: {
    name: "bounce",
    frames: [
      "[\u2022  ]",
      "[ \u2022 ]",
      "[  \u2022]",
      "[ \u2022 ]",
    ],
    interval: 120,
    ascii: ["[o  ]", "[ o ]", "[  o]", "[ o ]"],
    width: 5,
  },

  /** Sequential dots, the least distracting option. */
  ellipsis: {
    name: "ellipsis",
    frames: ["   ", ".  ", ".. ", "..."],
    interval: 280,
    width: 3,
  },

  /** No motion at all. Selected automatically when animations are disabled. */
  static: {
    name: "static",
    frames: ["\u2022"],
    interval: 1_000,
    ascii: ["*"],
    width: 1,
  },
}

export const SPINNER_NAMES = Object.keys(SPINNERS)

/**
 * The frame of a spinner at a given moment.
 *
 * Pure. Given the same elapsed time it always returns the same glyph, which makes
 * a repaint after a resize produce exactly the frame that was already on screen
 * rather than jumping.
 */
export function spinnerFrame(name: string, elapsed: number): string {
  const definition = SPINNERS[name] ?? SPINNERS["braille"]!

  if (!animationsEnabled) {
    const frames = pickFrames(definition)
    return frames[0]!
  }

  const frames = pickFrames(definition)
  const index = Math.floor(elapsed / definition.interval) % frames.length
  return frames[index]!
}

function pickFrames(definition: SpinnerDefinition): readonly string[] {
  if (!unicodeEnabled && definition.ascii) return definition.ascii
  return definition.frames
}

/** Display width of a spinner, so callers can reserve space. */
export function spinnerWidth(name: string): number {
  const definition = SPINNERS[name] ?? SPINNERS["braille"]!
  return definition.width ?? stringWidth(definition.frames[0] ?? " ")
}

/* ------------------------------------------------------------------ */
/* Easing                                                              */
/* ------------------------------------------------------------------ */

export type Easing = (t: number) => number

/**
 * Easing functions, all mapping [0, 1] to [0, 1].
 *
 * Used for progress bars, panel transitions, and the shimmer sweep. Linear motion
 * looks mechanical; eased motion reads as intentional, and it costs one
 * multiplication.
 */
export const Ease: Record<string, Easing> = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => t * (2 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 + (t - 1) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  outExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  outBack: (t) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
  },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t
    const c4 = (2 * Math.PI) / 3
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  },
  outBounce: (t) => {
    const n1 = 7.5625
    const d1 = 2.75
    if (t < 1 / d1) return n1 * t * t
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375
    return n1 * (t -= 2.625 / d1) * t + 0.984375
  },
  /** Smooth in and out, the safe default for anything positional. */
  smooth: (t) => t * t * (3 - 2 * t),
}

/* ------------------------------------------------------------------ */
/* Tween                                                               */
/* ------------------------------------------------------------------ */

/**
 * A value animating from one number to another.
 *
 * Used for scroll position, panel width, and progress. Retargetable mid-flight:
 * `to()` restarts from wherever the value currently is, so a user scrolling
 * rapidly gets continuous motion rather than a series of jumps.
 */
export class Tween {
  private from: number
  private target: number
  private startedAt: number
  private durationMs: number
  private easing: Easing

  constructor(initial: number, options: { durationMs?: number; easing?: Easing } = {}) {
    this.from = initial
    this.target = initial
    this.startedAt = now()
    this.durationMs = options.durationMs ?? 180
    this.easing = options.easing ?? Ease["smooth"]!
  }

  to(value: number, options: { durationMs?: number; easing?: Easing } = {}): void {
    if (value === this.target) return
    // Start from the current interpolated value, not the previous target, so a
    // retarget mid-animation does not snap.
    this.from = this.value
    this.target = value
    this.startedAt = now()
    if (options.durationMs !== undefined) this.durationMs = options.durationMs
    if (options.easing) this.easing = options.easing
  }

  /** Jumps immediately, used on resize where interpolation would look wrong. */
  set(value: number): void {
    this.from = value
    this.target = value
    this.startedAt = 0
  }

  get value(): number {
    if (!animationsEnabled) return this.target
    const elapsed = now() - this.startedAt
    if (elapsed >= this.durationMs) return this.target
    const t = this.easing(Math.max(0, elapsed / this.durationMs))
    return this.from + (this.target - this.from) * t
  }

  get done(): boolean {
    return !animationsEnabled || now() - this.startedAt >= this.durationMs
  }

  get destination(): number {
    return this.target
  }
}

/* ------------------------------------------------------------------ */
/* Progress bars                                                       */
/* ------------------------------------------------------------------ */

export interface ProgressOptions {
  readonly width: number
  /** 0 to 1. Pass undefined for an indeterminate bar. */
  readonly value?: number
  readonly elapsed?: number
  readonly filled?: string
  readonly empty?: string
  /** Use partial block characters for sub-cell precision. */
  readonly smooth?: boolean
}

const PARTIAL_BLOCKS = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"]

/**
 * Renders a progress bar.
 *
 * Sub-cell rendering with partial block glyphs is not decoration: at a typical
 * bar width of 20 cells, whole-cell steps mean the bar only moves every five
 * percent, which reads as stuck. Eighth-blocks give forty times the resolution
 * for the same width.
 */
export function progressBar(options: ProgressOptions): string {
  const width = Math.max(1, options.width)

  if (options.value === undefined) {
    return indeterminateBar(width, options.elapsed ?? 0)
  }

  const clamped = Math.max(0, Math.min(1, options.value))
  const filledChar = options.filled ?? "\u2588"
  const emptyChar = options.empty ?? "\u2591"

  if (!options.smooth || !unicodeEnabled) {
    const filled = Math.round(clamped * width)
    return filledChar.repeat(filled) + emptyChar.repeat(width - filled)
  }

  const exact = clamped * width
  const whole = Math.floor(exact)
  const remainder = exact - whole
  const partialIndex = Math.floor(remainder * 8)
  const partial = partialIndex > 0 ? PARTIAL_BLOCKS[partialIndex]! : ""
  const used = whole + (partial === "" ? 0 : 1)

  return filledChar.repeat(whole) + partial + emptyChar.repeat(Math.max(0, width - used))
}

/**
 * An indeterminate bar: a lit segment sweeping back and forth.
 *
 * The sweep is eased rather than linear so it slows at the turns, which looks
 * like a physical object rather than a jumping rectangle.
 */
function indeterminateBar(width: number, elapsed: number): string {
  if (!animationsEnabled) return "\u2591".repeat(width)

  const periodMs = 1_600
  const phase = (elapsed % periodMs) / periodMs
  // Triangle wave, then eased, so the highlight decelerates at each end.
  const triangle = phase < 0.5 ? phase * 2 : (1 - phase) * 2
  const eased = Ease["inOutQuad"]!(triangle)

  const segment = Math.max(2, Math.floor(width * 0.25))
  const start = Math.floor(eased * (width - segment))

  const cells: string[] = []
  for (let index = 0; index < width; index++) {
    if (index >= start && index < start + segment) {
      // Taper the ends of the lit segment so it looks like a glow.
      const edge = index === start || index === start + segment - 1
      cells.push(edge ? "\u2593" : "\u2588")
    } else {
      cells.push("\u2591")
    }
  }

  return cells.join("")
}

/* ------------------------------------------------------------------ */
/* Text effects                                                        */
/* ------------------------------------------------------------------ */

/**
 * A shimmer sweeping across text.
 *
 * Returns per-character intensities from 0 to 1 rather than coloured output,
 * because the caller owns the palette. Used on the "Working" label so that a long
 * silent wait still has something alive on screen without being distracting.
 */
export function shimmer(length: number, elapsed: number, options: { periodMs?: number; widthCells?: number } = {}): number[] {
  const period = options.periodMs ?? 2_200
  const band = options.widthCells ?? Math.max(4, Math.floor(length * 0.4))

  if (!animationsEnabled) return new Array(length).fill(0.5)

  // The sweep starts off the left edge and finishes off the right, so the band
  // enters and leaves rather than appearing in the middle.
  const phase = (elapsed % period) / period
  const centre = -band + phase * (length + band * 2)

  const intensities: number[] = []
  for (let index = 0; index < length; index++) {
    const distance = Math.abs(index - centre)
    const t = Math.max(0, 1 - distance / band)
    intensities.push(Ease["smooth"]!(t))
  }

  return intensities
}

/**
 * A typewriter reveal.
 *
 * Not used for streamed model output \u2014 that arrives at its own pace and adding
 * artificial delay would be dishonest. Used for the welcome banner and for
 * pre-written text where the reveal marks a transition.
 */
export function typewriter(text: string, elapsed: number, charsPerSecond = 120): string {
  if (!animationsEnabled) return text
  const visible = Math.floor((elapsed / 1_000) * charsPerSecond)
  return visible >= text.length ? text : text.slice(0, visible)
}

/**
 * A blinking cursor.
 *
 * Half-second on, half-second off is the terminal convention; matching it makes
 * the rendered cursor indistinguishable from a real one.
 */
export function cursorVisible(elapsed: number, periodMs = 1_000): boolean {
  if (!animationsEnabled) return true
  return elapsed % periodMs < periodMs / 2
}

/**
 * Ellipsis that grows and resets.
 *
 * Padded to a constant width so the text after it does not shift, which is the
 * mistake that makes naive "Loading..." animations jitter.
 */
export function animatedEllipsis(elapsed: number, max = 3, periodMs = 400): string {
  if (!animationsEnabled) return ".".repeat(max)
  const count = Math.floor(elapsed / periodMs) % (max + 1)
  return ".".repeat(count).padEnd(max, " ")
}

/* ------------------------------------------------------------------ */
/* Elapsed time                                                        */
/* ------------------------------------------------------------------ */

/**
 * Formats a duration compactly for the status line.
 *
 * The units change as the number grows so the string stays short: a run that has
 * been going for two hours must not push the rest of the status bar off screen.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${Math.floor(ms)}ms`

  const seconds = ms / 1_000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.floor(seconds)}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  if (minutes < 60) return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`

  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

/* ------------------------------------------------------------------ */
/* Working indicator                                                   */
/* ------------------------------------------------------------------ */

export interface WorkingState {
  readonly spinner: string
  readonly label: string
  readonly elapsedMs: number
  readonly tokens?: number
  readonly tool?: string
  readonly hint?: string
}

/**
 * Rotating labels shown while the model is working.
 *
 * Purely cosmetic, and deliberately so. A long wait with a static "Thinking"
 * feels much longer than the same wait with something that changes; the label
 * rotating every few seconds is the cheapest possible reassurance that the
 * process is alive. Kept short and unobtrusive.
 */
export const WORKING_LABELS = [
  "Working",
  "Thinking",
  "Reasoning",
  "Considering",
  "Planning",
  "Analysing",
  "Composing",
  "Deliberating",
  "Reflecting",
  "Weighing options",
  "Connecting dots",
  "Tracing the logic",
  "Reading between lines",
  "Chasing the thread",
  "Turning it over",
  "Sizing it up",
]

/**
 * Picks a label, rotating slowly.
 *
 * The rotation is seeded per invocation so two concurrent sessions do not show
 * the same word at the same time, which would look like a bug.
 */
export function workingLabel(elapsed: number, seed = 0, periodMs = 6_000): string {
  if (!animationsEnabled) return WORKING_LABELS[0]!
  const index = (Math.floor(elapsed / periodMs) + seed) % WORKING_LABELS.length
  return WORKING_LABELS[index]!
}

/**
 * Renders the whole working line, unstyled.
 *
 * Segments are ordered by how often they change, least first, so the eye is not
 * dragged around: spinner, label, tool, elapsed, tokens. The caller applies
 * colour.
 */
export function renderWorking(state: WorkingState, elapsed: number): string {
  const parts: string[] = [spinnerFrame(state.spinner, elapsed), state.label]

  if (state.tool) parts.push(`\u00b7 ${state.tool}`)

  parts.push(`\u00b7 ${formatElapsed(state.elapsedMs)}`)

  if (state.tokens !== undefined && state.tokens > 0) {
    parts.push(`\u00b7 ${formatTokens(state.tokens)} tokens`)
  }

  if (state.hint) parts.push(`\u00b7 ${state.hint}`)

  return parts.join(" ")
}

function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export type TransitionKind = "none" | "fade" | "slide-up" | "slide-down" | "expand"

export interface TransitionState {
  readonly kind: TransitionKind
  readonly startedAt: number
  readonly durationMs: number
  readonly reverse: boolean
}

/**
 * Progress of a transition, from 0 to 1.
 *
 * Panels opening and closing use this. The value is clamped and eased, and
 * returns 1 immediately when animations are off, which makes every call site
 * work unchanged in reduced-motion mode.
 */
export function transitionProgress(state: TransitionState): number {
  if (!animationsEnabled) return 1
  const elapsed = now() - state.startedAt
  const raw = Math.max(0, Math.min(1, elapsed / state.durationMs))
  const eased = Ease["outCubic"]!(raw)
  return state.reverse ? 1 - eased : eased
}

export function transitionDone(state: TransitionState): boolean {
  return !animationsEnabled || now() - state.startedAt >= state.durationMs
}

/**
 * Fades text by substituting progressively lighter block characters.
 *
 * A genuine alpha fade is impossible in a terminal, but stepping through the
 * shade glyphs approximates one closely enough that a panel dismissal reads as a
 * fade rather than a disappearance.
 */
export function fadeText(text: string, alpha: number): string {
  if (!animationsEnabled || alpha >= 0.95) return text
  if (alpha <= 0.05) return " ".repeat(stringWidth(text))

  // Below the halfway point, replace glyphs with shades rather than dimming,
  // because dim-on-dim is invisible in many terminals.
  if (alpha < 0.4) {
    const shade = alpha < 0.2 ? "\u2591" : "\u2592"
    return [...text].map((character) => (character === " " ? " " : shade)).join("")
  }

  return text
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */

const SPARK_GLYPHS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"]

/**
 * A sparkline for token throughput.
 *
 * Shown in the status bar during long generations. It answers the question a
 * spinner cannot: not just "is it alive" but "is it going at a normal speed",
 * which is how a user notices a degraded provider.
 */
export function sparkline(values: readonly number[], width: number): string {
  if (values.length === 0 || width <= 0) return ""

  const sampled = resample(values, width)
  const max = Math.max(...sampled, 1)

  return sampled
    .map((value) => {
      const index = Math.min(
        SPARK_GLYPHS.length - 1,
        Math.floor((value / max) * SPARK_GLYPHS.length),
      )
      return SPARK_GLYPHS[Math.max(0, index)]!
    })
    .join("")
}

/** Averages a series down to a fixed number of buckets. */
function resample(values: readonly number[], width: number): number[] {
  if (values.length <= width) return [...values]

  const result: number[] = []
  const bucketSize = values.length / width

  for (let index = 0; index < width; index++) {
    const start = Math.floor(index * bucketSize)
    const end = Math.floor((index + 1) * bucketSize)
    let sum = 0
    let count = 0
    for (let inner = start; inner < end && inner < values.length; inner++) {
      sum += values[inner]!
      count++
    }
    result.push(count > 0 ? sum / count : 0)
  }

  return result
}

/* ------------------------------------------------------------------ */
/* Rate tracking                                                       */
/* ------------------------------------------------------------------ */

/**
 * Tracks a rate over a sliding window.
 *
 * Feeds the sparkline and the tokens-per-second figure. A sliding window rather
 * than a running average because the interesting signal is the recent rate: a
 * generation that has slowed to a crawl should show a low number immediately, not
 * a high one dragged up by a fast start.
 */
export class RateTracker {
  private samples: Array<{ at: number; value: number }> = []
  private readonly windowMs: number

  constructor(windowMs = 10_000) {
    this.windowMs = windowMs
  }

  add(value: number): void {
    const timestamp = now()
    this.samples.push({ at: timestamp, value })
    const cutoff = timestamp - this.windowMs
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) {
      this.samples.shift()
    }
  }

  /** Units per second over the window. */
  get rate(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0]!
    const last = this.samples[this.samples.length - 1]!
    const seconds = (last.at - first.at) / 1_000
    if (seconds <= 0) return 0
    const total = this.samples.reduce((sum, sample) => sum + sample.value, 0)
    return total / seconds
  }

  /** Bucketed history for the sparkline. */
  history(buckets: number): number[] {
    if (this.samples.length === 0) return []
    const timestamp = now()
    const start = timestamp - this.windowMs
    const bucketMs = this.windowMs / buckets
    const result = new Array(buckets).fill(0)

    for (const sample of this.samples) {
      const index = Math.min(buckets - 1, Math.floor((sample.at - start) / bucketMs))
      if (index >= 0) result[index] += sample.value
    }

    return result
  }

  reset(): void {
    this.samples = []
  }
}

/* ------------------------------------------------------------------ */
/* Toast timing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Opacity curve for a transient notification.
 *
 * Fast in, hold, slow out. The asymmetry matters: a toast should appear
 * immediately so it is not missed, and leave gradually so the eye is not startled
 * by something vanishing.
 */
export function toastAlpha(elapsed: number, totalMs: number): number {
  const fadeIn = 150
  const fadeOut = 400

  if (elapsed < fadeIn) return Ease["outQuad"]!(elapsed / fadeIn)
  if (elapsed > totalMs - fadeOut) {
    const remaining = Math.max(0, totalMs - elapsed)
    return Ease["inQuad"]!(remaining / fadeOut)
  }
  return 1
}
