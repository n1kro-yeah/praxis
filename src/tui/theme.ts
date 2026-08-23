/**
 * Theming.
 *
 * A terminal UI has an unusually hostile colour environment: the background might
 * be anything, the palette is user-defined, and the same hex value that is
 * readable on one setup is invisible on another. So the theme system is built
 * around a few rules learned the hard way:
 *
 *  - **Every colour is a role, not a value.** Code refers to `theme.error`, never
 *    to red. That is what lets one JSON file restyle the entire interface.
 *  - **A colour can carry a dark and a light variant.** One theme file covers both
 *    terminal backgrounds; picking between them at render time avoids maintaining
 *    two near-identical files that drift apart.
 *  - **ANSI indices are first-class.** A theme built from indices 0-15 inherits
 *    the user's own palette and therefore matches every other program on their
 *    machine. That is the point of the `system` theme.
 *  - **`none` means "do not paint".** Not black \u2014 genuinely no escape code, so the
 *    terminal's own background shows through, including transparency.
 *  - **References let a theme be short.** `"info": "primary"` means a five-colour
 *    theme is five lines rather than fifty.
 *
 * Themes load from built-ins, then the user config directory, then the project.
 * Later wins, so a project can ship a house style without anyone installing it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"

import { logger } from "../util/log.js"
import { parseJsonc } from "../util/jsonc.js"
import { Paths } from "../global.js"
import { blend, hexToRgb, luminance, rgbToAnsi256, rgbToHex, type Rgb } from "../util/color.js"

const log = logger("tui.theme")

/* ------------------------------------------------------------------ */
/* Colour values                                                       */
/* ------------------------------------------------------------------ */

/**
 * A colour as written in a theme file.
 *
 * The union is wide because each form solves a different problem: hex for exact
 * brand colours, an index for palette inheritance, a variant pair for dual-mode
 * themes, a reference for brevity, and `none` for transparency.
 */
export type ThemeColorValue =
  | string
  | number
  | { dark: ThemeColorValue; light: ThemeColorValue }

/** A colour after resolution: either paint it, or do not. */
export type Color = { kind: "rgb"; rgb: Rgb } | { kind: "ansi"; index: number } | { kind: "none" }

export const NO_COLOR: Color = { kind: "none" }

/* ------------------------------------------------------------------ */
/* Roles                                                               */
/* ------------------------------------------------------------------ */

/**
 * Every colour the interface can ask for.
 *
 * Long, deliberately. A short list forces reuse of one role for two purposes, and
 * then a theme author cannot distinguish them: if "deleted line in a diff" and
 * "error message" share a role, no theme can make the diff subtle while keeping
 * errors loud.
 */
export interface Theme {
  readonly name: string
  readonly description?: string
  readonly author?: string

  /* Base surfaces */
  readonly background: Color
  readonly backgroundPanel: Color
  readonly backgroundElement: Color
  readonly backgroundHover: Color
  readonly backgroundActive: Color

  /* Text */
  readonly text: Color
  readonly textMuted: Color
  readonly textSubtle: Color
  readonly textInverse: Color

  /* Brand */
  readonly primary: Color
  readonly secondary: Color
  readonly accent: Color

  /* Status */
  readonly success: Color
  readonly warning: Color
  readonly error: Color
  readonly info: Color

  /* Structure */
  readonly border: Color
  readonly borderActive: Color
  readonly borderSubtle: Color
  readonly divider: Color

  /* Diffs: foreground and background kept separate so a theme can tint the row
     without recolouring the code on it. */
  readonly diffAdded: Color
  readonly diffRemoved: Color
  readonly diffContext: Color
  readonly diffAddedBg: Color
  readonly diffRemovedBg: Color
  readonly diffHighlightAdded: Color
  readonly diffHighlightRemoved: Color
  readonly diffLineNumber: Color
  readonly diffHunkHeader: Color

  /* Syntax */
  readonly syntaxKeyword: Color
  readonly syntaxString: Color
  readonly syntaxNumber: Color
  readonly syntaxComment: Color
  readonly syntaxFunction: Color
  readonly syntaxType: Color
  readonly syntaxVariable: Color
  readonly syntaxOperator: Color
  readonly syntaxPunctuation: Color
  readonly syntaxConstant: Color
  readonly syntaxTag: Color
  readonly syntaxAttribute: Color
  readonly syntaxProperty: Color
  readonly syntaxRegex: Color
  readonly syntaxEscape: Color

  /* Markdown */
  readonly markdownHeading: Color
  readonly markdownLink: Color
  readonly markdownCode: Color
  readonly markdownCodeBg: Color
  readonly markdownQuote: Color
  readonly markdownListMarker: Color
  readonly markdownEmphasis: Color
  readonly markdownStrong: Color
  readonly markdownRule: Color

  /* Chrome */
  readonly statusBarBg: Color
  readonly statusBarText: Color
  readonly selectionBg: Color
  readonly selectionText: Color
  readonly cursor: Color
  readonly scrollbar: Color
  readonly scrollbarThumb: Color
  readonly spinner: Color
  readonly badge: Color
  readonly badgeText: Color

  /* Roles */
  readonly userMessage: Color
  readonly assistantMessage: Color
  readonly toolName: Color
  readonly toolResult: Color
  readonly toolError: Color
  readonly reasoning: Color
  readonly permissionPrompt: Color

  /* Agents. Themes rarely set these; they exist so agent badges keep their
     identity while still coming from the palette. */
  readonly agentBuild: Color
  readonly agentPlan: Color
  readonly agentGeneral: Color
  readonly agentExplore: Color
  readonly agentReview: Color
}

export type ThemeRole = keyof Omit<Theme, "name" | "description" | "author">

/* ------------------------------------------------------------------ */
/* File format                                                         */
/* ------------------------------------------------------------------ */

export interface ThemeFile {
  $schema?: string
  name?: string
  description?: string
  author?: string
  /** Named colours, referenceable from `theme`. */
  defs?: Record<string, ThemeColorValue>
  /** Role assignments. Values may be literals or names from `defs`. */
  theme?: Record<string, ThemeColorValue>
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

export type Appearance = "dark" | "light"

/**
 * Turns a written colour into a resolved one.
 *
 * Reference resolution is depth-limited rather than cycle-detected: a cycle in a
 * hand-written theme is a typo, and stopping after a few hops gives a usable
 * colour instead of a crash on startup.
 */
function resolveValue(
  value: ThemeColorValue | undefined,
  defs: Record<string, ThemeColorValue>,
  appearance: Appearance,
  depth = 0,
): Color {
  if (value === undefined || depth > 8) return NO_COLOR

  if (typeof value === "number") {
    if (value < 0 || value > 255) return NO_COLOR
    return { kind: "ansi", index: Math.floor(value) }
  }

  if (typeof value === "object" && value !== null && "dark" in value) {
    return resolveValue(appearance === "dark" ? value.dark : value.light, defs, appearance, depth + 1)
  }

  if (typeof value !== "string") return NO_COLOR

  const text = value.trim()

  if (text === "" || text.toLowerCase() === "none" || text.toLowerCase() === "transparent") {
    return NO_COLOR
  }

  if (text.startsWith("#")) {
    const rgb = hexToRgb(text)
    return rgb ? { kind: "rgb", rgb } : NO_COLOR
  }

  // A bare number in a string, which JSON authors write by accident constantly.
  if (/^\d{1,3}$/.test(text)) {
    const index = Number.parseInt(text, 10)
    if (index >= 0 && index <= 255) return { kind: "ansi", index }
  }

  // `ansi:4` or `ansi(4)`, for authors who want to be explicit.
  const ansiMatch = text.match(/^ansi[:(]\s*(\d{1,3})\s*\)?$/i)
  if (ansiMatch) {
    const index = Number.parseInt(ansiMatch[1]!, 10)
    if (index >= 0 && index <= 255) return { kind: "ansi", index }
  }

  // Adjustments, so a theme can derive a hover state without a second hex value:
  // `lighten(primary, 20)`, `mix(primary, background, 50)`.
  const functional = text.match(/^(lighten|darken|mix|alpha)\(([^)]*)\)$/i)
  if (functional) {
    return resolveFunction(functional[1]!.toLowerCase(), functional[2]!, defs, appearance, depth)
  }

  const referenced = defs[text]
  if (referenced !== undefined) {
    return resolveValue(referenced, defs, appearance, depth + 1)
  }

  const named = CSS_COLORS[text.toLowerCase()]
  if (named) {
    const rgb = hexToRgb(named)
    if (rgb) return { kind: "rgb", rgb }
  }

  return NO_COLOR
}

function resolveFunction(
  name: string,
  argumentText: string,
  defs: Record<string, ThemeColorValue>,
  appearance: Appearance,
  depth: number,
): Color {
  const parts = argumentText.split(",").map((part) => part.trim())

  const base = resolveValue(parts[0], defs, appearance, depth + 1)
  if (base.kind !== "rgb") return base

  const amount = Number.parseFloat(parts[parts.length - 1] ?? "0") / 100

  switch (name) {
    case "lighten":
      return { kind: "rgb", rgb: blend(base.rgb, { r: 255, g: 255, b: 255 }, amount) }
    case "darken":
      return { kind: "rgb", rgb: blend(base.rgb, { r: 0, g: 0, b: 0 }, amount) }
    case "mix": {
      const other = resolveValue(parts[1], defs, appearance, depth + 1)
      if (other.kind !== "rgb") return base
      return { kind: "rgb", rgb: blend(base.rgb, other.rgb, amount) }
    }
    default:
      return base
  }
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fallbacks for roles a theme did not set.
 *
 * Every role maps to another role rather than to a literal, so an incomplete
 * theme still looks coherent: a theme setting only `primary` and `error` gets a
 * usable interface, because everything else derives from the handful of roles it
 * did set. Without this, partial themes would be a patchwork of defaults and
 * custom colours.
 */
const ROLE_FALLBACKS: Partial<Record<ThemeRole, ThemeRole>> = {
  backgroundPanel: "background",
  backgroundElement: "backgroundPanel",
  backgroundHover: "backgroundElement",
  backgroundActive: "backgroundHover",
  textSubtle: "textMuted",
  textInverse: "background",
  secondary: "primary",
  accent: "primary",
  info: "primary",
  borderActive: "primary",
  borderSubtle: "border",
  divider: "borderSubtle",
  diffContext: "textMuted",
  diffHighlightAdded: "diffAdded",
  diffHighlightRemoved: "diffRemoved",
  diffLineNumber: "textSubtle",
  diffHunkHeader: "info",
  syntaxVariable: "text",
  syntaxOperator: "text",
  syntaxPunctuation: "textMuted",
  syntaxConstant: "syntaxNumber",
  syntaxTag: "syntaxKeyword",
  syntaxAttribute: "syntaxFunction",
  syntaxProperty: "syntaxVariable",
  syntaxRegex: "syntaxString",
  syntaxEscape: "syntaxConstant",
  markdownHeading: "primary",
  markdownLink: "info",
  markdownCode: "syntaxString",
  markdownCodeBg: "backgroundElement",
  markdownQuote: "textMuted",
  markdownListMarker: "accent",
  markdownEmphasis: "text",
  markdownStrong: "text",
  markdownRule: "border",
  statusBarBg: "backgroundPanel",
  statusBarText: "textMuted",
  selectionBg: "backgroundActive",
  selectionText: "text",
  cursor: "primary",
  scrollbar: "borderSubtle",
  scrollbarThumb: "border",
  spinner: "primary",
  badge: "backgroundElement",
  badgeText: "text",
  userMessage: "text",
  assistantMessage: "text",
  toolName: "accent",
  toolResult: "textMuted",
  toolError: "error",
  reasoning: "textSubtle",
  permissionPrompt: "warning",
  agentBuild: "success",
  agentPlan: "info",
  agentGeneral: "secondary",
  agentExplore: "warning",
  agentReview: "accent",
}

const REQUIRED_ROLES: ThemeRole[] = [
  "background",
  "text",
  "textMuted",
  "primary",
  "success",
  "warning",
  "error",
  "border",
  "diffAdded",
  "diffRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "syntaxKeyword",
  "syntaxString",
  "syntaxNumber",
  "syntaxComment",
  "syntaxFunction",
  "syntaxType",
]

/**
 * Builds a usable theme from a file.
 *
 * Fallbacks are applied iteratively because they chain: `backgroundActive` falls
 * back to `backgroundHover`, which falls back to `backgroundElement`, and so on
 * to `background`. A single pass in the wrong order would leave holes.
 */
export function compileTheme(file: ThemeFile, appearance: Appearance, name: string): Theme {
  const defs = file.defs ?? {}
  const source = file.theme ?? {}

  const resolved = new Map<string, Color>()

  for (const [role, value] of Object.entries(source)) {
    resolved.set(role, resolveValue(value, defs, appearance))
  }

  for (let pass = 0; pass < 8; pass++) {
    let changed = false

    for (const [role, fallback] of Object.entries(ROLE_FALLBACKS)) {
      if (resolved.has(role)) continue
      const target = resolved.get(fallback as string)
      if (target) {
        resolved.set(role, target)
        changed = true
      }
    }

    if (!changed) break
  }

  const get = (role: ThemeRole): Color => resolved.get(role) ?? NO_COLOR

  return {
    name: file.name ?? name,
    description: file.description,
    author: file.author,

    background: get("background"),
    backgroundPanel: get("backgroundPanel"),
    backgroundElement: get("backgroundElement"),
    backgroundHover: get("backgroundHover"),
    backgroundActive: get("backgroundActive"),

    text: get("text"),
    textMuted: get("textMuted"),
    textSubtle: get("textSubtle"),
    textInverse: get("textInverse"),

    primary: get("primary"),
    secondary: get("secondary"),
    accent: get("accent"),

    success: get("success"),
    warning: get("warning"),
    error: get("error"),
    info: get("info"),

    border: get("border"),
    borderActive: get("borderActive"),
    borderSubtle: get("borderSubtle"),
    divider: get("divider"),

    diffAdded: get("diffAdded"),
    diffRemoved: get("diffRemoved"),
    diffContext: get("diffContext"),
    diffAddedBg: get("diffAddedBg"),
    diffRemovedBg: get("diffRemovedBg"),
    diffHighlightAdded: get("diffHighlightAdded"),
    diffHighlightRemoved: get("diffHighlightRemoved"),
    diffLineNumber: get("diffLineNumber"),
    diffHunkHeader: get("diffHunkHeader"),

    syntaxKeyword: get("syntaxKeyword"),
    syntaxString: get("syntaxString"),
    syntaxNumber: get("syntaxNumber"),
    syntaxComment: get("syntaxComment"),
    syntaxFunction: get("syntaxFunction"),
    syntaxType: get("syntaxType"),
    syntaxVariable: get("syntaxVariable"),
    syntaxOperator: get("syntaxOperator"),
    syntaxPunctuation: get("syntaxPunctuation"),
    syntaxConstant: get("syntaxConstant"),
    syntaxTag: get("syntaxTag"),
    syntaxAttribute: get("syntaxAttribute"),
    syntaxProperty: get("syntaxProperty"),
    syntaxRegex: get("syntaxRegex"),
    syntaxEscape: get("syntaxEscape"),

    markdownHeading: get("markdownHeading"),
    markdownLink: get("markdownLink"),
    markdownCode: get("markdownCode"),
    markdownCodeBg: get("markdownCodeBg"),
    markdownQuote: get("markdownQuote"),
    markdownListMarker: get("markdownListMarker"),
    markdownEmphasis: get("markdownEmphasis"),
    markdownStrong: get("markdownStrong"),
    markdownRule: get("markdownRule"),

    statusBarBg: get("statusBarBg"),
    statusBarText: get("statusBarText"),
    selectionBg: get("selectionBg"),
    selectionText: get("selectionText"),
    cursor: get("cursor"),
    scrollbar: get("scrollbar"),
    scrollbarThumb: get("scrollbarThumb"),
    spinner: get("spinner"),
    badge: get("badge"),
    badgeText: get("badgeText"),

    userMessage: get("userMessage"),
    assistantMessage: get("assistantMessage"),
    toolName: get("toolName"),
    toolResult: get("toolResult"),
    toolError: get("toolError"),
    reasoning: get("reasoning"),
    permissionPrompt: get("permissionPrompt"),

    agentBuild: get("agentBuild"),
    agentPlan: get("agentPlan"),
    agentGeneral: get("agentGeneral"),
    agentExplore: get("agentExplore"),
    agentReview: get("agentReview"),
  }
}

/* ------------------------------------------------------------------ */
/* Escape sequences                                                    */
/* ------------------------------------------------------------------ */

export type ColorDepth = "none" | "ansi16" | "ansi256" | "truecolor"

/**
 * Renders a colour as an SGR sequence.
 *
 * Degrades by quantising rather than dropping: a truecolour theme on a 256-colour
 * terminal is approximated, and on a 16-colour terminal reduced further. The
 * result is imperfect but recognisably the same theme, which is much better than
 * monochrome.
 */
export function colorSequence(color: Color, layer: "fg" | "bg", depth: ColorDepth): string {
  if (color.kind === "none" || depth === "none") return ""

  const base = layer === "fg" ? 38 : 48

  if (color.kind === "ansi") {
    // Indices 0-15 have dedicated short codes that respect the terminal palette,
    // which is exactly why a theme would use them.
    if (color.index < 8) {
      return `\u001b[${(layer === "fg" ? 30 : 40) + color.index}m`
    }
    if (color.index < 16) {
      return `\u001b[${(layer === "fg" ? 90 : 100) + (color.index - 8)}m`
    }
    if (depth === "ansi16") {
      return `\u001b[${(layer === "fg" ? 30 : 40) + (color.index % 8)}m`
    }
    return `\u001b[${base};5;${color.index}m`
  }

  const { r, g, b } = color.rgb

  if (depth === "truecolor") return `\u001b[${base};2;${r};${g};${b}m`
  if (depth === "ansi256") return `\u001b[${base};5;${rgbToAnsi256(color.rgb)}m`

  return `\u001b[${(layer === "fg" ? 30 : 40) + rgbToBasic(color.rgb)}m`
}

/** Nearest of the eight basic colours, by hue with a brightness check. */
function rgbToBasic(rgb: Rgb): number {
  const { r, g, b } = rgb
  const bright = Math.max(r, g, b) > 128
  const bit = (value: number) => (value > (bright ? 128 : 64) ? 1 : 0)
  return bit(r) | (bit(g) << 1) | (bit(b) << 2)
}

/* ------------------------------------------------------------------ */
/* Built-in themes                                                     */
/* ------------------------------------------------------------------ */

/**
 * The default theme.
 *
 * Uses `none` for the background so the terminal's own background, including a
 * transparent one, shows through. Painting a background would break every user
 * with a blurred or image background, and they are numerous.
 */
const PRAXIS_THEME: ThemeFile = {
  name: "praxis",
  description: "The default theme. Adapts to the terminal background.",
  defs: {
    ink: { dark: "#e6e6e6", light: "#1c1c1c" },
    muted: { dark: "#8a8a8a", light: "#6a6a6a" },
    subtle: { dark: "#5c5c5c", light: "#9a9a9a" },
    line: { dark: "#303030", light: "#d8d8d8" },
    panel: { dark: "#161616", light: "#f6f6f6" },
    element: { dark: "#1f1f1f", light: "#ececec" },
    cyan: { dark: "#4fb8cc", light: "#0f7f96" },
    green: { dark: "#7cc47c", light: "#2f7d32" },
    yellow: { dark: "#d4a24c", light: "#9a6b00" },
    red: { dark: "#d96a6a", light: "#b3261e" },
    purple: { dark: "#a58ad4", light: "#6a4bab" },
    blue: { dark: "#6f9fd8", light: "#1f5fa8" },
    orange: { dark: "#d2874f", light: "#a35a13" },
  },
  theme: {
    background: "none",
    backgroundPanel: "panel",
    backgroundElement: "element",
    backgroundHover: { dark: "#262626", light: "#e2e2e2" },
    backgroundActive: { dark: "#2f2f2f", light: "#d6d6d6" },

    text: "ink",
    textMuted: "muted",
    textSubtle: "subtle",
    textInverse: { dark: "#101010", light: "#fafafa" },

    primary: "cyan",
    secondary: "purple",
    accent: "orange",

    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",

    border: "line",
    borderSubtle: { dark: "#242424", light: "#e8e8e8" },

    diffAdded: "green",
    diffRemoved: "red",
    diffAddedBg: { dark: "#14261a", light: "#e6f4e6" },
    diffRemovedBg: { dark: "#2a1618", light: "#fbe9e7" },
    diffHighlightAdded: { dark: "#1f4429", light: "#c8e6c9" },
    diffHighlightRemoved: { dark: "#4a2226", light: "#ffcdd2" },

    syntaxKeyword: "purple",
    syntaxString: "green",
    syntaxNumber: "orange",
    syntaxComment: "subtle",
    syntaxFunction: "blue",
    syntaxType: "cyan",
    syntaxConstant: "orange",
    syntaxTag: "red",
    syntaxAttribute: "yellow",
  },
}

/**
 * A theme built entirely from ANSI indices.
 *
 * The important one for anyone with a carefully tuned terminal palette: because
 * it names indices rather than values, it looks like the rest of their system
 * automatically, in every colour scheme they ever switch to.
 */
const SYSTEM_THEME: ThemeFile = {
  name: "system",
  description: "Uses the terminal's own 16-colour palette.",
  theme: {
    background: "none",
    backgroundPanel: "none",
    backgroundElement: "none",
    backgroundHover: 8,
    backgroundActive: 8,

    text: "none",
    textMuted: 8,
    textSubtle: 8,
    textInverse: 0,

    primary: 6,
    secondary: 5,
    accent: 3,

    success: 2,
    warning: 3,
    error: 1,
    info: 4,

    border: 8,
    borderActive: 6,
    borderSubtle: 8,

    diffAdded: 2,
    diffRemoved: 1,
    diffAddedBg: "none",
    diffRemovedBg: "none",

    syntaxKeyword: 5,
    syntaxString: 2,
    syntaxNumber: 3,
    syntaxComment: 8,
    syntaxFunction: 4,
    syntaxType: 6,
    syntaxConstant: 3,
    syntaxTag: 1,
    syntaxAttribute: 3,
  },
}

/** Monochrome, for logs, pipes, and anyone who wants none of this. */
const PLAIN_THEME: ThemeFile = {
  name: "plain",
  description: "No colour at all.",
  theme: {
    background: "none",
    text: "none",
    textMuted: "none",
    primary: "none",
    success: "none",
    warning: "none",
    error: "none",
    border: "none",
    diffAdded: "none",
    diffRemoved: "none",
    diffAddedBg: "none",
    diffRemovedBg: "none",
    syntaxKeyword: "none",
    syntaxString: "none",
    syntaxNumber: "none",
    syntaxComment: "none",
    syntaxFunction: "none",
    syntaxType: "none",
  },
}

export const BUILTIN_THEMES: Record<string, ThemeFile> = {
  praxis: PRAXIS_THEME,
  system: SYSTEM_THEME,
  plain: PLAIN_THEME,
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const files = new Map<string, ThemeFile>()
let currentTheme: Theme | undefined
let currentAppearance: Appearance = "dark"
let currentName = "praxis"

const listeners = new Set<(theme: Theme) => void>()

/**
 * Loads every theme file that can be found.
 *
 * Directories are visited lowest to highest precedence and a later definition of
 * the same name simply replaces the earlier one, which is how a project ships a
 * house version of a well-known theme.
 */
export function loadThemes(cwd: string): void {
  files.clear()

  for (const [name, file] of Object.entries(BUILTIN_THEMES)) {
    files.set(name, file)
  }

  for (const [name, file] of Object.entries(EXTRA_THEMES)) {
    files.set(name, file)
  }

  for (const directory of [
    join(Paths.configDir, "themes"),
    join(Paths.configDir, "theme"),
    join(cwd, ".praxis", "themes"),
    join(cwd, ".praxis", "theme"),
  ]) {
    loadThemeDirectory(directory)
  }

  log.debug("themes loaded", { count: files.size })
}

function loadThemeDirectory(directory: string): void {
  if (!existsSync(directory)) return

  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json") && !entry.endsWith(".jsonc")) continue

    const path = join(directory, entry)

    try {
      const parsed = parseJsonc(readFileSync(path, "utf8")) as ThemeFile
      const name = parsed.name ?? basename(entry).replace(/\.jsonc?$/, "")
      files.set(name, parsed)
    } catch (error) {
      // Reported, not fatal. A typo in one theme file must not stop the UI.
      log.warn("theme file could not be parsed", { path, error: String(error) })
    }
  }
}

export function themeNames(): string[] {
  return [...files.keys()].sort()
}

export function themeExists(name: string): boolean {
  return files.has(name)
}

/**
 * Activates a theme.
 *
 * Recompiles rather than caching per name, because the same theme resolves
 * differently under a light and a dark terminal and the appearance can change
 * while running.
 */
export function setTheme(name: string, appearance?: Appearance): Theme {
  const file = files.get(name) ?? files.get("praxis") ?? PRAXIS_THEME

  currentName = files.has(name) ? name : "praxis"
  if (appearance) currentAppearance = appearance

  currentTheme = compileTheme(file, currentAppearance, currentName)

  for (const listener of listeners) {
    try {
      listener(currentTheme)
    } catch {
      // A listener throwing must not prevent the theme from changing.
    }
  }

  return currentTheme
}

export function setAppearance(appearance: Appearance): Theme {
  return setTheme(currentName, appearance)
}

export function theme(): Theme {
  if (!currentTheme) currentTheme = compileTheme(PRAXIS_THEME, currentAppearance, "praxis")
  return currentTheme
}

export function currentThemeName(): string {
  return currentName
}

export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/* ------------------------------------------------------------------ */
/* Appearance detection                                                */
/* ------------------------------------------------------------------ */

/**
 * Guesses whether the terminal is dark.
 *
 * `COLORFGBG` is the only widely-supported hint and it is absent more often than
 * present, so the fallback is dark: developer terminals are overwhelmingly dark,
 * and a light theme on a dark background is far more painful than the reverse.
 */
export function detectAppearance(env: Record<string, string | undefined>): Appearance {
  const explicit = env["PRAXIS_APPEARANCE"]?.toLowerCase()
  if (explicit === "light" || explicit === "dark") return explicit

  const colorFgBg = env["COLORFGBG"]
  if (colorFgBg) {
    const parts = colorFgBg.split(";")
    const background = Number.parseInt(parts[parts.length - 1] ?? "", 10)
    if (!Number.isNaN(background)) {
      // 0-6 and 8 are dark backgrounds by convention; 7 and 15 are light.
      return background === 7 || background === 15 ? "light" : "dark"
    }
  }

  if (env["TERM_PROGRAM"] === "Apple_Terminal" && env["__CFBundleIdentifier"]) {
    return "dark"
  }

  return "dark"
}

/**
 * Derives an appearance from a background colour reported by the terminal.
 *
 * Used with the OSC 11 query, which is the only reliable way to know. The
 * threshold sits at 0.4 rather than 0.5 because a mid-grey background reads as
 * dark in practice.
 */
export function appearanceFromBackground(hex: string): Appearance {
  const rgb = hexToRgb(hex)
  if (!rgb) return "dark"
  return luminance(rgb) > 0.4 ? "light" : "dark"
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ThemeIssue {
  readonly severity: "error" | "warning"
  readonly message: string
}

/**
 * Checks a theme and reports what is missing or unreadable.
 *
 * The contrast check is the valuable part. A theme author picking colours by eye
 * on their own terminal routinely produces comment or muted colours that vanish
 * on someone else's, and the ratio catches it before it ships.
 */
export function validateTheme(file: ThemeFile, appearance: Appearance = "dark"): ThemeIssue[] {
  const issues: ThemeIssue[] = []
  const defs = file.defs ?? {}
  const source = file.theme ?? {}

  for (const role of REQUIRED_ROLES) {
    if (!(role in source) && !(role in ROLE_FALLBACKS)) {
      issues.push({ severity: "warning", message: `Missing role "${role}".` })
    }
  }

  for (const [role, value] of Object.entries(source)) {
    const resolved = resolveValue(value, defs, appearance)
    if (resolved.kind === "none" && value !== "none" && value !== "") {
      issues.push({
        severity: "error",
        message: `Role "${role}" has an unrecognised value: ${JSON.stringify(value)}`,
      })
    }
  }

  const compiled = compileTheme(file, appearance, file.name ?? "theme")
  const background = compiled.background.kind === "rgb"
    ? compiled.background.rgb
    : appearance === "dark"
      ? { r: 0, g: 0, b: 0 }
      : { r: 255, g: 255, b: 255 }

  for (const role of ["text", "textMuted", "syntaxComment", "error", "warning"] as const) {
    const color = compiled[role]
    if (color.kind !== "rgb") continue

    const ratio = contrastRatio(color.rgb, background)
    if (ratio < 3) {
      issues.push({
        severity: "warning",
        message: `Role "${role}" has a contrast ratio of ${ratio.toFixed(1)}:1 against the background. Below 3:1 is hard to read; 4.5:1 is the accessible minimum for body text.`,
      })
    }
  }

  return issues
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const first = luminance(a) + 0.05
  const second = luminance(b) + 0.05
  return first > second ? first / second : second / first
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serialises the active theme as a file.
 *
 * Behind `/theme export`. Starting from the current theme is by far the easiest
 * way to author a new one, and it also documents every available role by example.
 */
export function exportTheme(name: string): string {
  const active = theme()
  const result: Record<string, string> = {}

  for (const [role, value] of Object.entries(active)) {
    if (role === "name" || role === "description" || role === "author") continue

    const color = value as Color
    if (color.kind === "none") result[role] = "none"
    else if (color.kind === "ansi") result[role] = String(color.index)
    else result[role] = rgbToHex(color.rgb)
  }

  return JSON.stringify(
    { $schema: "https://praxis.dev/theme.json", name, theme: result },
    null,
    2,
  )
}

/* ------------------------------------------------------------------ */
/* Named colours                                                       */
/* ------------------------------------------------------------------ */

/**
 * A small set of CSS colour names.
 *
 * Not the full list \u2014 the full list is 148 entries of which nobody uses more than
 * twenty, and it would be pure weight. These are the ones that show up in
 * hand-written themes.
 */
const CSS_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  navy: "#000080",
  teal: "#008080",
  olive: "#808000",
  maroon: "#800000",
  silver: "#c0c0c0",
  gold: "#ffd700",
  lime: "#00ff00",
  indigo: "#4b0082",
  violet: "#ee82ee",
  coral: "#ff7f50",
  salmon: "#fa8072",
  crimson: "#dc143c",
  turquoise: "#40e0d0",
  lavender: "#e6e6fa",
  beige: "#f5f5dc",
  ivory: "#fffff0",
}

/* ------------------------------------------------------------------ */
/* Additional built-ins                                                */
/* ------------------------------------------------------------------ */

/**
 * Ports of well-known editor themes.
 *
 * Shipping them matters more than it seems: the first thing many people do with a
 * new terminal tool is look for their usual colour scheme, and finding it absent
 * reads as unfinished. Each is defined once with dark and light variants where
 * the original has both.
 */
export const EXTRA_THEMES: Record<string, ThemeFile> = {
  tokyonight: {
    name: "tokyonight",
    description: "Tokyo Night.",
    defs: {
      bg: { dark: "#1a1b26", light: "#e1e2e7" },
      fg: { dark: "#c0caf5", light: "#3760bf" },
      comment: { dark: "#565f89", light: "#848cb5" },
      blue: { dark: "#7aa2f7", light: "#2e7de9" },
      cyan: { dark: "#7dcfff", light: "#007197" },
      green: { dark: "#9ece6a", light: "#587539" },
      magenta: { dark: "#bb9af7", light: "#9854f1" },
      orange: { dark: "#ff9e64", light: "#b15c00" },
      red: { dark: "#f7768e", light: "#f52a65" },
      yellow: { dark: "#e0af68", light: "#8c6c3e" },
    },
    theme: {
      background: "none",
      backgroundPanel: { dark: "#16161e", light: "#d5d6db" },
      backgroundElement: { dark: "#1f2335", light: "#c4c8da" },
      text: "fg",
      textMuted: "comment",
      primary: "blue",
      secondary: "magenta",
      accent: "cyan",
      success: "green",
      warning: "yellow",
      error: "red",
      info: "blue",
      border: { dark: "#292e42", light: "#a8aecb" },
      diffAdded: "green",
      diffRemoved: "red",
      diffAddedBg: { dark: "#20303b", light: "#d5e5d5" },
      diffRemovedBg: { dark: "#37222c", light: "#f0d5d5" },
      syntaxKeyword: "magenta",
      syntaxString: "green",
      syntaxNumber: "orange",
      syntaxComment: "comment",
      syntaxFunction: "blue",
      syntaxType: "cyan",
      syntaxConstant: "orange",
    },
  },

  gruvbox: {
    name: "gruvbox",
    description: "Gruvbox.",
    defs: {
      bg: { dark: "#282828", light: "#fbf1c7" },
      fg: { dark: "#ebdbb2", light: "#3c3836" },
      gray: { dark: "#928374", light: "#7c6f64" },
      red: { dark: "#fb4934", light: "#9d0006" },
      green: { dark: "#b8bb26", light: "#79740e" },
      yellow: { dark: "#fabd2f", light: "#b57614" },
      blue: { dark: "#83a598", light: "#076678" },
      purple: { dark: "#d3869b", light: "#8f3f71" },
      aqua: { dark: "#8ec07c", light: "#427b58" },
      orange: { dark: "#fe8019", light: "#af3a03" },
    },
    theme: {
      background: "none",
      backgroundPanel: { dark: "#1d2021", light: "#f2e5bc" },
      backgroundElement: { dark: "#3c3836", light: "#ebdbb2" },
      text: "fg",
      textMuted: "gray",
      primary: "aqua",
      secondary: "purple",
      accent: "orange",
      success: "green",
      warning: "yellow",
      error: "red",
      info: "blue",
      border: { dark: "#504945", light: "#d5c4a1" },
      diffAdded: "green",
      diffRemoved: "red",
      diffAddedBg: { dark: "#32361a", light: "#e8e5b5" },
      diffRemovedBg: { dark: "#3c1f1e", light: "#f2d5cb" },
      syntaxKeyword: "red",
      syntaxString: "green",
      syntaxNumber: "purple",
      syntaxComment: "gray",
      syntaxFunction: "green",
      syntaxType: "yellow",
      syntaxConstant: "purple",
    },
  },

  nord: {
    name: "nord",
    description: "Nord.",
    defs: {
      night0: "#2e3440",
      night3: "#4c566a",
      snow0: "#d8dee9",
      snow2: "#eceff4",
      frost1: "#88c0d0",
      frost2: "#81a1c1",
      frost3: "#5e81ac",
      aurora0: "#bf616a",
      aurora1: "#d08770",
      aurora2: "#ebcb8b",
      aurora3: "#a3be8c",
      aurora4: "#b48ead",
    },
    theme: {
      background: "none",
      backgroundPanel: "night0",
      backgroundElement: "#3b4252",
      text: "snow0",
      textMuted: "night3",
      primary: "frost1",
      secondary: "aurora4",
      accent: "frost2",
      success: "aurora3",
      warning: "aurora2",
      error: "aurora0",
      info: "frost3",
      border: "#434c5e",
      diffAdded: "aurora3",
      diffRemoved: "aurora0",
      diffAddedBg: "#333f2e",
      diffRemovedBg: "#42292e",
      syntaxKeyword: "frost2",
      syntaxString: "aurora3",
      syntaxNumber: "aurora4",
      syntaxComment: "night3",
      syntaxFunction: "frost1",
      syntaxType: "frost1",
      syntaxConstant: "aurora4",
    },
  },

  catppuccin: {
    name: "catppuccin",
    description: "Catppuccin Mocha and Latte.",
    defs: {
      base: { dark: "#1e1e2e", light: "#eff1f5" },
      mantle: { dark: "#181825", light: "#e6e9ef" },
      surface: { dark: "#313244", light: "#ccd0da" },
      textc: { dark: "#cdd6f4", light: "#4c4f69" },
      overlay: { dark: "#6c7086", light: "#9ca0b0" },
      blue: { dark: "#89b4fa", light: "#1e66f5" },
      lavender: { dark: "#b4befe", light: "#7287fd" },
      sapphire: { dark: "#74c7ec", light: "#209fb5" },
      green: { dark: "#a6e3a1", light: "#40a02b" },
      yellow: { dark: "#f9e2af", light: "#df8e1d" },
      peach: { dark: "#fab387", light: "#fe640b" },
      red: { dark: "#f38ba8", light: "#d20f39" },
      mauve: { dark: "#cba6f7", light: "#8839ef" },
    },
    theme: {
      background: "none",
      backgroundPanel: "mantle",
      backgroundElement: "surface",
      text: "textc",
      textMuted: "overlay",
      primary: "blue",
      secondary: "mauve",
      accent: "peach",
      success: "green",
      warning: "yellow",
      error: "red",
      info: "sapphire",
      border: "surface",
      diffAdded: "green",
      diffRemoved: "red",
      diffAddedBg: { dark: "#26332b", light: "#dcecd8" },
      diffRemovedBg: { dark: "#38242c", light: "#f5d9df" },
      syntaxKeyword: "mauve",
      syntaxString: "green",
      syntaxNumber: "peach",
      syntaxComment: "overlay",
      syntaxFunction: "blue",
      syntaxType: "yellow",
      syntaxConstant: "peach",
      syntaxTag: "lavender",
    },
  },

  "one-dark": {
    name: "one-dark",
    description: "Atom One Dark.",
    theme: {
      background: "none",
      backgroundPanel: "#21252b",
      backgroundElement: "#2c313a",
      text: "#abb2bf",
      textMuted: "#5c6370",
      primary: "#61afef",
      secondary: "#c678dd",
      accent: "#e5c07b",
      success: "#98c379",
      warning: "#e5c07b",
      error: "#e06c75",
      info: "#56b6c2",
      border: "#3e4451",
      diffAdded: "#98c379",
      diffRemoved: "#e06c75",
      diffAddedBg: "#23331f",
      diffRemovedBg: "#38222a",
      syntaxKeyword: "#c678dd",
      syntaxString: "#98c379",
      syntaxNumber: "#d19a66",
      syntaxComment: "#5c6370",
      syntaxFunction: "#61afef",
      syntaxType: "#e5c07b",
      syntaxConstant: "#d19a66",
    },
  },

  dracula: {
    name: "dracula",
    description: "Dracula.",
    theme: {
      background: "none",
      backgroundPanel: "#21222c",
      backgroundElement: "#343746",
      text: "#f8f8f2",
      textMuted: "#6272a4",
      primary: "#bd93f9",
      secondary: "#ff79c6",
      accent: "#8be9fd",
      success: "#50fa7b",
      warning: "#f1fa8c",
      error: "#ff5555",
      info: "#8be9fd",
      border: "#44475a",
      diffAdded: "#50fa7b",
      diffRemoved: "#ff5555",
      diffAddedBg: "#1f3326",
      diffRemovedBg: "#3d2124",
      syntaxKeyword: "#ff79c6",
      syntaxString: "#f1fa8c",
      syntaxNumber: "#bd93f9",
      syntaxComment: "#6272a4",
      syntaxFunction: "#50fa7b",
      syntaxType: "#8be9fd",
      syntaxConstant: "#bd93f9",
    },
  },

  everforest: {
    name: "everforest",
    description: "Everforest.",
    theme: {
      background: "none",
      backgroundPanel: "#2d353b",
      backgroundElement: "#343f44",
      text: "#d3c6aa",
      textMuted: "#859289",
      primary: "#a7c080",
      secondary: "#d699b6",
      accent: "#e69875",
      success: "#a7c080",
      warning: "#dbbc7f",
      error: "#e67e80",
      info: "#7fbbb3",
      border: "#475258",
      diffAdded: "#a7c080",
      diffRemoved: "#e67e80",
      diffAddedBg: "#333f2e",
      diffRemovedBg: "#42292e",
      syntaxKeyword: "#e67e80",
      syntaxString: "#a7c080",
      syntaxNumber: "#d699b6",
      syntaxComment: "#859289",
      syntaxFunction: "#a7c080",
      syntaxType: "#dbbc7f",
      syntaxConstant: "#d699b6",
    },
  },

  kanagawa: {
    name: "kanagawa",
    description: "Kanagawa.",
    theme: {
      background: "none",
      backgroundPanel: "#16161d",
      backgroundElement: "#223249",
      text: "#dcd7ba",
      textMuted: "#727169",
      primary: "#7e9cd8",
      secondary: "#957fb8",
      accent: "#ffa066",
      success: "#98bb6c",
      warning: "#e6c384",
      error: "#e82424",
      info: "#7fb4ca",
      border: "#54546d",
      diffAdded: "#98bb6c",
      diffRemoved: "#e82424",
      diffAddedBg: "#2b3328",
      diffRemovedBg: "#43242b",
      syntaxKeyword: "#957fb8",
      syntaxString: "#98bb6c",
      syntaxNumber: "#d27e99",
      syntaxComment: "#727169",
      syntaxFunction: "#7e9cd8",
      syntaxType: "#7aa89f",
      syntaxConstant: "#ffa066",
    },
  },

  ayu: {
    name: "ayu",
    description: "Ayu.",
    defs: {
      bg: { dark: "#0b0e14", light: "#fcfcfc" },
      fg: { dark: "#bfbdb6", light: "#5c6166" },
      muted: { dark: "#565b66", light: "#8a9199" },
      accent: { dark: "#e6b450", light: "#ffaa33" },
      blue: { dark: "#59c2ff", light: "#399ee6" },
      green: { dark: "#aad94c", light: "#6cbf43" },
      red: { dark: "#f07178", light: "#e65050" },
      orange: { dark: "#ffb454", light: "#fa8d3e" },
      purple: { dark: "#d2a6ff", light: "#a37acc" },
      cyan: { dark: "#95e6cb", light: "#4cbf99" },
    },
    theme: {
      background: "none",
      backgroundPanel: { dark: "#0d1017", light: "#f8f9fa" },
      backgroundElement: { dark: "#131721", light: "#f0f0f0" },
      text: "fg",
      textMuted: "muted",
      primary: "accent",
      secondary: "purple",
      accent: "orange",
      success: "green",
      warning: "orange",
      error: "red",
      info: "blue",
      border: { dark: "#1c212b", light: "#e7e8e9" },
      diffAdded: "green",
      diffRemoved: "red",
      diffAddedBg: { dark: "#1a2418", light: "#e8f2e0" },
      diffRemovedBg: { dark: "#2b1a1c", light: "#f7e0e0" },
      syntaxKeyword: "orange",
      syntaxString: "green",
      syntaxNumber: "purple",
      syntaxComment: "muted",
      syntaxFunction: "accent",
      syntaxType: "cyan",
      syntaxConstant: "purple",
    },
  },

  matrix: {
    name: "matrix",
    description: "Green on black.",
    theme: {
      background: "none",
      backgroundPanel: "#000a00",
      backgroundElement: "#001400",
      text: "#00cc33",
      textMuted: "#007a1f",
      textSubtle: "#004d14",
      primary: "#00ff41",
      secondary: "#33ff66",
      accent: "#66ff99",
      success: "#00ff41",
      warning: "#ccff00",
      error: "#ff3300",
      info: "#00cc99",
      border: "#00330d",
      diffAdded: "#00ff41",
      diffRemoved: "#ff3300",
      diffAddedBg: "#001a08",
      diffRemovedBg: "#1a0500",
      syntaxKeyword: "#00ff41",
      syntaxString: "#66ff99",
      syntaxNumber: "#ccff00",
      syntaxComment: "#004d14",
      syntaxFunction: "#33ff66",
      syntaxType: "#00cc99",
      syntaxConstant: "#ccff00",
    },
  },

  monokai: {
    name: "monokai",
    description: "Monokai.",
    theme: {
      background: "none",
      backgroundPanel: "#1e1f1c",
      backgroundElement: "#3e3d32",
      text: "#f8f8f2",
      textMuted: "#75715e",
      primary: "#66d9ef",
      secondary: "#ae81ff",
      accent: "#fd971f",
      success: "#a6e22e",
      warning: "#e6db74",
      error: "#f92672",
      info: "#66d9ef",
      border: "#49483e",
      diffAdded: "#a6e22e",
      diffRemoved: "#f92672",
      diffAddedBg: "#26310f",
      diffRemovedBg: "#3a1420",
      syntaxKeyword: "#f92672",
      syntaxString: "#e6db74",
      syntaxNumber: "#ae81ff",
      syntaxComment: "#75715e",
      syntaxFunction: "#a6e22e",
      syntaxType: "#66d9ef",
      syntaxConstant: "#ae81ff",
    },
  },

  solarized: {
    name: "solarized",
    description: "Solarized, dark and light.",
    defs: {
      base03: "#002b36",
      base02: "#073642",
      base01: "#586e75",
      base00: "#657b83",
      base0: "#839496",
      base2: "#eee8d5",
      base3: "#fdf6e3",
      yellow: "#b58900",
      orange: "#cb4b16",
      red: "#dc322f",
      magenta: "#d33682",
      violet: "#6c71c4",
      blue: "#268bd2",
      cyan: "#2aa198",
      green: "#859900",
    },
    theme: {
      background: "none",
      backgroundPanel: { dark: "base03", light: "base3" },
      backgroundElement: { dark: "base02", light: "base2" },
      text: { dark: "base0", light: "base00" },
      textMuted: "base01",
      primary: "blue",
      secondary: "violet",
      accent: "cyan",
      success: "green",
      warning: "yellow",
      error: "red",
      info: "cyan",
      border: { dark: "base02", light: "base2" },
      diffAdded: "green",
      diffRemoved: "red",
      diffAddedBg: { dark: "#0c2b1a", light: "#e4eccf" },
      diffRemovedBg: { dark: "#31161a", light: "#f5dcd5" },
      syntaxKeyword: "green",
      syntaxString: "cyan",
      syntaxNumber: "magenta",
      syntaxComment: "base01",
      syntaxFunction: "blue",
      syntaxType: "yellow",
      syntaxConstant: "magenta",
    },
  },

  rosepine: {
    name: "rosepine",
    description: "Rose Pine.",
    defs: {
      base: { dark: "#191724", light: "#faf4ed" },
      surface: { dark: "#1f1d2e", light: "#fffaf3" },
      overlay: { dark: "#26233a", light: "#f2e9e1" },
      muted: { dark: "#6e6a86", light: "#9893a5" },
      textc: { dark: "#e0def4", light: "#575279" },
      love: { dark: "#eb6f92", light: "#b4637a" },
      gold: { dark: "#f6c177", light: "#ea9d34" },
      rose: { dark: "#ebbcba", light: "#d7827e" },
      pine: { dark: "#31748f", light: "#286983" },
      foam: { dark: "#9ccfd8", light: "#56949f" },
      iris: { dark: "#c4a7e7", light: "#907aa9" },
    },
    theme: {
      background: "none",
      backgroundPanel: "surface",
      backgroundElement: "overlay",
      text: "textc",
      textMuted: "muted",
      primary: "foam",
      secondary: "iris",
      accent: "rose",
      success: "pine",
      warning: "gold",
      error: "love",
      info: "foam",
      border: "overlay",
      diffAdded: "pine",
      diffRemoved: "love",
      diffAddedBg: { dark: "#1c2b31", light: "#e0eaec" },
      diffRemovedBg: { dark: "#33202a", light: "#f3dfe3" },
      syntaxKeyword: "pine",
      syntaxString: "gold",
      syntaxNumber: "iris",
      syntaxComment: "muted",
      syntaxFunction: "rose",
      syntaxType: "foam",
      syntaxConstant: "iris",
    },
  },
}
