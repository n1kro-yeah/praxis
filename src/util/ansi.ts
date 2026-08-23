/**
 * ANSI escape sequence construction and parsing.
 *
 * The TUI writes raw escape sequences: we need precise control over cursor
 * placement, colour depth negotiation, alternate screen buffers, mouse
 * reporting, bracketed paste and synchronized output. Every sequence used by
 * the renderer is defined here so that terminal quirks live in one file.
 */

import { Flag } from "../flag.js"
import { stringWidth } from "./wcwidth.js"

export const ESC = "\u001b"
export const CSI = `${ESC}[`
export const OSC = `${ESC}]`
export const ST = `${ESC}\\`
export const BEL = "\u0007"

export type ColorDepth = 1 | 4 | 8 | 24

/** Detects colour support from the environment; honours NO_COLOR/FORCE_COLOR. */
export function detectColorDepth(stream: { isTTY?: boolean } = process.stdout): ColorDepth {
  if (Flag.noColor()) return 1
  if (Flag.truecolor()) return 24
  const env = process.env
  if (env.FORCE_COLOR === "0") return 1
  if (Flag.forceColor() || env.FORCE_COLOR) {
    const level = Number(env.FORCE_COLOR)
    if (Number.isFinite(level)) {
      if (level >= 3) return 24
      if (level === 2) return 8
      if (level >= 1) return 4
    }
    return 24
  }
  if (!stream.isTTY) return 1
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 24
  const term = env.TERM ?? ""
  const termProgram = env.TERM_PROGRAM ?? ""
  if (/^(iTerm|WezTerm|vscode|Hyper|ghostty|kitty|Apple_Terminal|rio|Warp)/i.test(termProgram)) {
    return termProgram === "Apple_Terminal" ? 8 : 24
  }
  if (env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR) return 24
  if (env.WT_SESSION) return 24
  if (/-truecolor|direct/i.test(term)) return 24
  if (/-256(color)?$/i.test(term)) return 8
  if (/^(screen|xterm|vt100|vt220|rxvt|linux|ansi|cygwin|konsole|tmux)/i.test(term)) return 4
  if (term === "dumb") return 1
  return 4
}

/* ------------------------------------------------------------------ */
/* Cursor and screen control                                           */
/* ------------------------------------------------------------------ */

export const Cursor = {
  to: (row: number, column: number) => `${CSI}${row + 1};${column + 1}H`,
  toColumn: (column: number) => `${CSI}${column + 1}G`,
  up: (n = 1) => (n > 0 ? `${CSI}${n}A` : ""),
  down: (n = 1) => (n > 0 ? `${CSI}${n}B` : ""),
  forward: (n = 1) => (n > 0 ? `${CSI}${n}C` : ""),
  back: (n = 1) => (n > 0 ? `${CSI}${n}D` : ""),
  nextLine: (n = 1) => `${CSI}${n}E`,
  prevLine: (n = 1) => `${CSI}${n}F`,
  save: `${ESC}7`,
  restore: `${ESC}8`,
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  /** DECSCUSR: 1 blinking block, 3 blinking underline, 5 blinking bar. */
  shape: (style: 0 | 1 | 2 | 3 | 4 | 5 | 6) => `${CSI}${style} q`,
  queryPosition: `${CSI}6n`,
} as const

export const Screen = {
  clear: `${CSI}2J${CSI}H`,
  clearBelow: `${CSI}0J`,
  clearAbove: `${CSI}1J`,
  clearLine: `${CSI}2K`,
  clearLineRight: `${CSI}0K`,
  clearLineLeft: `${CSI}1K`,
  clearScrollback: `${CSI}3J`,
  enterAlt: `${CSI}?1049h`,
  exitAlt: `${CSI}?1049l`,
  enableWrap: `${CSI}?7h`,
  disableWrap: `${CSI}?7l`,
  scrollUp: (n = 1) => `${CSI}${n}S`,
  scrollDown: (n = 1) => `${CSI}${n}T`,
  setScrollRegion: (top: number, bottom: number) => `${CSI}${top + 1};${bottom + 1}r`,
  resetScrollRegion: `${CSI}r`,
  insertLines: (n = 1) => `${CSI}${n}L`,
  deleteLines: (n = 1) => `${CSI}${n}M`,
  /** DEC 2026 synchronized output; prevents tearing on large repaints. */
  beginSync: `${CSI}?2026h`,
  endSync: `${CSI}?2026l`,
} as const

export const Mode = {
  enableMouse: `${CSI}?1000h${CSI}?1002h${CSI}?1006h${CSI}?1015h`,
  disableMouse: `${CSI}?1015l${CSI}?1006l${CSI}?1002l${CSI}?1000l`,
  enableMouseMove: `${CSI}?1003h`,
  disableMouseMove: `${CSI}?1003l`,
  enableFocus: `${CSI}?1004h`,
  disableFocus: `${CSI}?1004l`,
  enableBracketedPaste: `${CSI}?2004h`,
  disableBracketedPaste: `${CSI}?2004l`,
  /** Kitty keyboard protocol: disambiguate escape codes + report event types. */
  enableKittyKeyboard: `${CSI}>1u`,
  disableKittyKeyboard: `${CSI}<u`,
  queryKittyKeyboard: `${CSI}?u`,
  queryPrimaryDeviceAttributes: `${CSI}c`,
  queryTerminalName: `${CSI}>q`,
} as const

export const Osc = {
  title: (text: string) => `${OSC}0;${sanitizeOsc(text)}${BEL}`,
  /** OSC 52: copy to the *host* clipboard, works over SSH. */
  clipboard: (text: string) =>
    `${OSC}52;c;${Buffer.from(text, "utf8").toString("base64")}${ST}`,
  /** OSC 8: hyperlink. */
  link: (url: string, label: string) => `${OSC}8;;${sanitizeOsc(url)}${ST}${label}${OSC}8;;${ST}`,
  /** OSC 9: desktop notification (supported by iTerm2, kitty, WezTerm). */
  notify: (text: string) => `${OSC}9;${sanitizeOsc(text)}${BEL}`,
  /** OSC 777: rxvt-unicode style notification with a title. */
  notifyTitled: (title: string, body: string) =>
    `${OSC}777;notify;${sanitizeOsc(title)};${sanitizeOsc(body)}${BEL}`,
  /** OSC 11: query the background colour so themes can adapt. */
  queryBackground: `${OSC}11;?${ST}`,
  queryForeground: `${OSC}10;?${ST}`,
} as const

function sanitizeOsc(input: string): string {
  // Strip control characters that would terminate the sequence early.
  return input.replace(/[\u0000-\u001f\u007f]/g, " ")
}

/* ------------------------------------------------------------------ */
/* SGR styling                                                         */
/* ------------------------------------------------------------------ */

export const Sgr = {
  reset: `${CSI}0m`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  underline: `${CSI}4m`,
  blink: `${CSI}5m`,
  inverse: `${CSI}7m`,
  hidden: `${CSI}8m`,
  strikethrough: `${CSI}9m`,
  doubleUnderline: `${CSI}21m`,
  noBold: `${CSI}22m`,
  noItalic: `${CSI}23m`,
  noUnderline: `${CSI}24m`,
  noBlink: `${CSI}25m`,
  noInverse: `${CSI}27m`,
  noStrikethrough: `${CSI}29m`,
  defaultFg: `${CSI}39m`,
  defaultBg: `${CSI}49m`,
  curlyUnderline: `${CSI}4:3m`,
  underlineColor: (r: number, g: number, b: number) => `${CSI}58;2;${r};${g};${b}m`,
  resetUnderlineColor: `${CSI}59m`,
} as const

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n)
}

/** Converts RGB into the nearest xterm-256 palette index. */
export function rgbTo256(color: Rgb): number {
  const { r, g, b } = color
  // Greyscale ramp gives better results for near-neutral colours.
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const cube = (v: number) => Math.round((clamp255(v) / 255) * 5)
  return 16 + 36 * cube(r) + 6 * cube(g) + cube(b)
}

const BASIC_PALETTE: Array<{ index: number; rgb: Rgb }> = [
  { index: 0, rgb: { r: 0, g: 0, b: 0 } },
  { index: 1, rgb: { r: 187, g: 0, b: 0 } },
  { index: 2, rgb: { r: 0, g: 187, b: 0 } },
  { index: 3, rgb: { r: 187, g: 187, b: 0 } },
  { index: 4, rgb: { r: 0, g: 0, b: 187 } },
  { index: 5, rgb: { r: 187, g: 0, b: 187 } },
  { index: 6, rgb: { r: 0, g: 187, b: 187 } },
  { index: 7, rgb: { r: 187, g: 187, b: 187 } },
  { index: 8, rgb: { r: 85, g: 85, b: 85 } },
  { index: 9, rgb: { r: 255, g: 85, b: 85 } },
  { index: 10, rgb: { r: 85, g: 255, b: 85 } },
  { index: 11, rgb: { r: 255, g: 255, b: 85 } },
  { index: 12, rgb: { r: 85, g: 85, b: 255 } },
  { index: 13, rgb: { r: 255, g: 85, b: 255 } },
  { index: 14, rgb: { r: 85, g: 255, b: 255 } },
  { index: 15, rgb: { r: 255, g: 255, b: 255 } },
]

export function rgbTo16(color: Rgb): number {
  let best = 0
  let bestDistance = Infinity
  for (const entry of BASIC_PALETTE) {
    const dr = entry.rgb.r - color.r
    const dg = entry.rgb.g - color.g
    const db = entry.rgb.b - color.b
    const distance = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114
    if (distance < bestDistance) {
      bestDistance = distance
      best = entry.index
    }
  }
  return best
}

/** Emits the correct foreground sequence for the negotiated colour depth. */
export function fg(color: Rgb, depth: ColorDepth): string {
  if (depth === 1) return ""
  if (depth === 24) return `${CSI}38;2;${clamp255(color.r)};${clamp255(color.g)};${clamp255(color.b)}m`
  if (depth === 8) return `${CSI}38;5;${rgbTo256(color)}m`
  const index = rgbTo16(color)
  return index < 8 ? `${CSI}${30 + index}m` : `${CSI}${90 + index - 8}m`
}

export function bg(color: Rgb, depth: ColorDepth): string {
  if (depth === 1) return ""
  if (depth === 24) return `${CSI}48;2;${clamp255(color.r)};${clamp255(color.g)};${clamp255(color.b)}m`
  if (depth === 8) return `${CSI}48;5;${rgbTo256(color)}m`
  const index = rgbTo16(color)
  return index < 8 ? `${CSI}${40 + index}m` : `${CSI}${100 + index - 8}m`
}

/* ------------------------------------------------------------------ */
/* Stripping and measuring                                             */
/* ------------------------------------------------------------------ */

// Matches CSI, OSC, DCS and single-character escapes.
const ANSI_PATTERN =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?(?:\u0007|\u001b\u005c|\u009c))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "")
}

export function hasAnsi(input: string): boolean {
  ANSI_PATTERN.lastIndex = 0
  return ANSI_PATTERN.test(input)
}

/** Visible width, ignoring escape sequences. */
export function visibleWidth(input: string): number {
  return stringWidth(stripAnsi(input))
}

/**
 * Truncates a styled string to `maxWidth` visible cells, preserving escape
 * sequences and appending a reset so styling never bleeds.
 */
export function truncateStyled(input: string, maxWidth: number, ellipsis = "\u2026"): string {
  if (visibleWidth(input) <= maxWidth) return input
  const budget = Math.max(0, maxWidth - stringWidth(ellipsis))
  let out = ""
  let width = 0
  let index = 0
  let sawStyle = false

  while (index < input.length) {
    if (input[index] === ESC) {
      ANSI_PATTERN.lastIndex = index
      const match = ANSI_PATTERN.exec(input)
      if (match && match.index === index) {
        out += match[0]
        index += match[0].length
        sawStyle = true
        continue
      }
    }
    const codePoint = input.codePointAt(index)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    const charWidth = stringWidth(char)
    if (width + charWidth > budget) break
    out += char
    width += charWidth
    index += char.length
  }
  return out + ellipsis + (sawStyle ? Sgr.reset : "")
}

/**
 * Wraps a styled string to a column width. Escape sequences are carried across
 * line boundaries so colours survive wrapping.
 */
export function wrapStyled(input: string, width: number, indent = ""): string[] {
  if (width <= 0) return [input]
  const lines: string[] = []
  for (const rawLine of input.split("\n")) {
    if (visibleWidth(rawLine) <= width) {
      lines.push(rawLine)
      continue
    }
    let current = ""
    let currentWidth = 0
    let activeStyles = ""
    const words = rawLine.split(/(\s+)/)
    const flush = () => {
      lines.push(current)
      current = indent + activeStyles
      currentWidth = stringWidth(indent)
    }
    for (const word of words) {
      const wordWidth = visibleWidth(word)
      if (currentWidth + wordWidth > width && currentWidth > stringWidth(indent)) {
        flush()
        if (/^\s+$/.test(word)) continue
      }
      // Hard-break words longer than the whole line.
      if (wordWidth > width) {
        let remaining = word
        while (visibleWidth(remaining) > width) {
          const head = truncateStyled(remaining, width, "")
          lines.push(current + head)
          remaining = remaining.slice(head.length)
          current = indent
          currentWidth = stringWidth(indent)
        }
        current += remaining
        currentWidth += visibleWidth(remaining)
        continue
      }
      current += word
      currentWidth += wordWidth
      const styleMatches = word.match(ANSI_PATTERN)
      if (styleMatches) {
        for (const style of styleMatches) {
          activeStyles = style === Sgr.reset ? "" : activeStyles + style
        }
      }
    }
    if (current.trim() !== "" || lines.length === 0) lines.push(current)
  }
  return lines
}

/** Removes styling but keeps OSC 8 hyperlink labels. */
export function flattenLinks(input: string): string {
  return input.replace(/\u001b]8;;.*?(?:\u0007|\u001b\\)(.*?)\u001b]8;;(?:\u0007|\u001b\\)/g, "$1")
}

/** Escapes text so it cannot inject escape sequences into the terminal. */
export function neutralize(input: string): string {
  return input.replace(/\u001b/g, "\u241b").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "\ufffd")
}
