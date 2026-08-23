/**
 * Colour maths.
 *
 * Themes are authored as hex strings but the renderer needs to blend, dim,
 * lighten and contrast-check them. We convert through OKLab, a perceptually
 * uniform space, because naive RGB interpolation produces muddy midpoints and
 * unreadable dimmed text.
 */

import type { Rgb } from "./ansi.js"

export interface Hsl {
  readonly h: number
  readonly s: number
  readonly l: number
}

export interface OkLab {
  readonly l: number
  readonly a: number
  readonly b: number
}

function clamp(value: number, min = 0, max = 1): number {
  return value < min ? min : value > max ? max : value
}

function clamp255(value: number): number {
  return Math.round(clamp(value, 0, 255))
}

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` and named colours. */
export function parseColor(input: string): Rgb | undefined {
  const value = input.trim().toLowerCase()
  if (value === "" || value === "none" || value === "transparent") return undefined

  const named = NAMED_COLORS[value]
  if (named) return named

  if (value.startsWith("#")) {
    const hex = value.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt((hex[0] as string).repeat(2), 16)
      const g = parseInt((hex[1] as string).repeat(2), 16)
      const b = parseInt((hex[2] as string).repeat(2), 16)
      return { r, g, b }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      }
    }
    return undefined
  }

  const rgbMatch = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value)
  if (rgbMatch) {
    return {
      r: clamp255(Number(rgbMatch[1])),
      g: clamp255(Number(rgbMatch[2])),
      b: clamp255(Number(rgbMatch[3])),
    }
  }

  const hslMatch = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(value)
  if (hslMatch) {
    return hslToRgb({
      h: Number(hslMatch[1]),
      s: Number(hslMatch[2]) / 100,
      l: Number(hslMatch[3]) / 100,
    })
  }

  return undefined
}

export function toHex(color: Rgb): string {
  const part = (value: number) => clamp255(value).toString(16).padStart(2, "0")
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

export function rgbToHsl(color: Rgb): Hsl {
  const r = color.r / 255
  const g = color.g / 255
  const b = color.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s, l }
}

export function hslToRgb(color: Hsl): Rgb {
  const h = ((color.h % 360) + 360) % 360 / 360
  const s = clamp(color.s)
  const l = clamp(color.l)
  if (s === 0) {
    const value = clamp255(l * 255)
    return { r: value, g: value, b: value }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let value = t
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return {
    r: clamp255(channel(h + 1 / 3) * 255),
    g: clamp255(channel(h) * 255),
    b: clamp255(channel(h - 1 / 3) * 255),
  }
}

function srgbToLinear(value: number): number {
  const v = value / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return clamp255(v * 255)
}

/** sRGB → OKLab. */
export function rgbToOkLab(color: Rgb): OkLab {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return {
    l: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  }
}

/** OKLab → sRGB. */
export function okLabToRgb(color: OkLab): Rgb {
  const l_ = color.l + 0.3963377774 * color.a + 0.2158037573 * color.b
  const m_ = color.l - 0.1055613458 * color.a - 0.0638541728 * color.b
  const s_ = color.l - 0.0894841775 * color.a - 1.291485548 * color.b

  const l = l_ * l_ * l_
  const m = m_ * m_ * m_
  const s = s_ * s_ * s_

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

/** Perceptually uniform blend. `amount` 0 returns `a`, 1 returns `b`. */
export function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = clamp(amount)
  const labA = rgbToOkLab(a)
  const labB = rgbToOkLab(b)
  return okLabToRgb({
    l: labA.l + (labB.l - labA.l) * t,
    a: labA.a + (labB.a - labA.a) * t,
    b: labA.b + (labB.b - labA.b) * t,
  })
}

/** Lightens toward white in OKLab space. */
export function lighten(color: Rgb, amount: number): Rgb {
  const lab = rgbToOkLab(color)
  return okLabToRgb({ ...lab, l: clamp(lab.l + amount) })
}

export function darken(color: Rgb, amount: number): Rgb {
  const lab = rgbToOkLab(color)
  return okLabToRgb({ ...lab, l: clamp(lab.l - amount) })
}

/** Reduces chroma, keeping lightness — the right way to "dim" UI text. */
export function desaturate(color: Rgb, amount: number): Rgb {
  const lab = rgbToOkLab(color)
  const factor = clamp(1 - amount)
  return okLabToRgb({ l: lab.l, a: lab.a * factor, b: lab.b * factor })
}

export function saturate(color: Rgb, amount: number): Rgb {
  const lab = rgbToOkLab(color)
  const factor = 1 + amount
  return okLabToRgb({ l: lab.l, a: lab.a * factor, b: lab.b * factor })
}

/** WCAG relative luminance. */
export function luminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  )
}

/** WCAG contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export function isDark(color: Rgb): boolean {
  return luminance(color) < 0.18
}

/** Picks whichever of two foregrounds contrasts better with `background`. */
export function pickReadable(background: Rgb, light: Rgb, dark: Rgb): Rgb {
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark
}

/**
 * Nudges `foreground` until it reaches `target` contrast against `background`.
 * Used so user themes stay legible even when authored carelessly.
 */
export function ensureContrast(foreground: Rgb, background: Rgb, target = 4.5): Rgb {
  if (contrastRatio(foreground, background) >= target) return foreground
  const goLighter = luminance(background) < 0.5
  let current = foreground
  for (let step = 0; step < 40; step++) {
    current = goLighter ? lighten(current, 0.025) : darken(current, 0.025)
    if (contrastRatio(current, background) >= target) return current
  }
  return goLighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
}

/** Blends a colour over a background at the given alpha. */
export function alphaOver(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  const t = clamp(alpha)
  return {
    r: clamp255(foreground.r * t + background.r * (1 - t)),
    g: clamp255(foreground.g * t + background.g * (1 - t)),
    b: clamp255(foreground.b * t + background.b * (1 - t)),
  }
}

/** Generates a harmonious accent ramp from a single seed colour. */
export function generateRamp(seed: Rgb, steps = 9): Rgb[] {
  const lab = rgbToOkLab(seed)
  const out: Rgb[] = []
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1)
    // Sweep lightness from near-black to near-white, tapering chroma at the ends.
    const l = 0.12 + t * 0.8
    const chromaScale = 1 - Math.abs(t - 0.5) * 1.2
    out.push(okLabToRgb({ l, a: lab.a * chromaScale, b: lab.b * chromaScale }))
  }
  return out
}

/** Deterministic pleasant colour from a string, for author/session badges. */
export function colorFromString(input: string): Rgb {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const hue = (hash >>> 0) % 360
  return hslToRgb({ h: hue, s: 0.62, l: 0.58 })
}

/** Interpolates across a multi-stop gradient; used by progress bars. */
export function gradient(stops: readonly Rgb[], t: number): Rgb {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 }
  if (stops.length === 1) return stops[0] as Rgb
  const position = clamp(t) * (stops.length - 1)
  const index = Math.floor(position)
  const next = Math.min(index + 1, stops.length - 1)
  return mix(stops[index] as Rgb, stops[next] as Rgb, position - index)
}

const NAMED_COLORS: Record<string, Rgb> = {
  black: { r: 0, g: 0, b: 0 },
  white: { r: 255, g: 255, b: 255 },
  red: { r: 255, g: 0, b: 0 },
  green: { r: 0, g: 128, b: 0 },
  blue: { r: 0, g: 0, b: 255 },
  yellow: { r: 255, g: 255, b: 0 },
  cyan: { r: 0, g: 255, b: 255 },
  magenta: { r: 255, g: 0, b: 255 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  orange: { r: 255, g: 165, b: 0 },
  purple: { r: 128, g: 0, b: 128 },
  pink: { r: 255, g: 192, b: 203 },
  brown: { r: 165, g: 42, b: 42 },
  navy: { r: 0, g: 0, b: 128 },
  teal: { r: 0, g: 128, b: 128 },
  olive: { r: 128, g: 128, b: 0 },
  maroon: { r: 128, g: 0, b: 0 },
  lime: { r: 0, g: 255, b: 0 },
  silver: { r: 192, g: 192, b: 192 },
  gold: { r: 255, g: 215, b: 0 },
  indigo: { r: 75, g: 0, b: 130 },
  violet: { r: 238, g: 130, b: 238 },
  turquoise: { r: 64, g: 224, b: 208 },
  salmon: { r: 250, g: 128, b: 114 },
  coral: { r: 255, g: 127, b: 80 },
  crimson: { r: 220, g: 20, b: 60 },
  khaki: { r: 240, g: 230, b: 140 },
  lavender: { r: 230, g: 230, b: 250 },
  plum: { r: 221, g: 160, b: 221 },
  slate: { r: 112, g: 128, b: 144 },
}

/** The 256-colour xterm palette, needed to interpret terminal responses. */
export function xterm256ToRgb(index: number): Rgb {
  if (index < 16) {
    const base = [
      [0, 0, 0],
      [128, 0, 0],
      [0, 128, 0],
      [128, 128, 0],
      [0, 0, 128],
      [128, 0, 128],
      [0, 128, 128],
      [192, 192, 192],
      [128, 128, 128],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ][index] as number[]
    return { r: base[0] as number, g: base[1] as number, b: base[2] as number }
  }
  if (index < 232) {
    const offset = index - 16
    const levels = [0, 95, 135, 175, 215, 255]
    return {
      r: levels[Math.floor(offset / 36)] as number,
      g: levels[Math.floor((offset % 36) / 6)] as number,
      b: levels[offset % 6] as number,
    }
  }
  const grey = 8 + (index - 232) * 10
  return { r: grey, g: grey, b: grey }
}
