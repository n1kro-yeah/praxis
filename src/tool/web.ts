/**
 * Web tools.
 *
 * Two tools, and the split between them is the same one a person makes: search
 * when you do not know where the answer is, fetch when you do.
 *
 * `webfetch` is the harder of the two, because the raw material is hostile. A
 * modern documentation page is perhaps three per cent prose and ninety-seven per
 * cent navigation, scripts, cookie banners, and analytics. Handing that to a model
 * costs a fortune in tokens and buries the answer. So the fetched HTML goes through
 * a conversion that strips the furniture and produces markdown, which is both
 * dramatically smaller and structurally closer to what the model was trained on.
 *
 * `websearch` has no universal free backend. The design here is a chain: use the
 * model provider's own search when it has one, fall back to a configured search
 * API, and fall back again to scraping a search engine's HTML. The last is
 * unreliable and rate-limited, but "unreliable" beats "unavailable" when the
 * alternative is telling the user to go and get an API key.
 *
 * Both tools are network egress from a machine the user did not necessarily expect
 * to make outbound requests, so both are permission-gated on the host.
 */

import { defineTool, ok, fail, type ToolContext } from "./types.js"
import { s } from "../util/schema.js"
import { logger } from "../util/log.js"
import { truncate } from "../util/string.js"

const log = logger("tool.web")

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Response body bytes read before giving up. */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** Characters of converted content returned by default. */
const DEFAULT_LIMIT = 40_000

/** Hard cap regardless of what the caller asks for. */
const MAX_LIMIT = 200_000

/** Default fetch timeout. */
const DEFAULT_TIMEOUT_MS = 30_000

/** Maximum timeout the model may request. */
const MAX_TIMEOUT_MS = 120_000

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5

/** Search request timeout. */
const SEARCH_TIMEOUT_MS = 20_000

/** Default search results. */
const DEFAULT_RESULTS = 8

/**
 * How long a fetch is cached.
 *
 * Fifteen minutes. Models re-fetch the same page constantly \u2014 following a link,
 * coming back, checking a detail \u2014 and each round trip is a second of latency for
 * content that has not changed.
 */
const CACHE_TTL_MS = 15 * 60 * 1000

/** Cached responses held in memory. */
const CACHE_MAX_ENTRIES = 50

/**
 * A browser user agent.
 *
 * Sending something identifying as a bot gets a 403 from a meaningful fraction
 * of the web, including several major documentation hosts. This is not an attempt
 * to evade anything \u2014 the request is made on a person's behalf, at their explicit
 * instruction, and the alternative is failing on sites they can open in a browser.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  readonly content: string
  readonly contentType: string
  readonly finalUrl: string
  readonly at: number
}

const cache = new Map<string, CacheEntry>()

function cacheGet(key: string): CacheEntry | undefined {
  const entry = cache.get(key)

  if (!entry) return undefined

  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }

  // Refresh recency so the map's insertion order acts as an LRU list.
  cache.delete(key)
  cache.set(key, entry)

  return entry
}

function cacheSet(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)

  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

export function clearWebCache(): void {
  cache.clear()
}

/* ------------------------------------------------------------------ */
/* HTML to markdown                                                    */
/* ------------------------------------------------------------------ */

/**
 * Elements removed entirely, contents and all.
 *
 * Scripts and styles are obvious. `nav`, `header`, `footer`, and `aside` are
 * removed because on a documentation page they are the sidebar, the breadcrumb,
 * and the "on this page" list \u2014 collectively larger than the article and useful to
 * nobody reading it.
 */
const DROP_ELEMENTS = [
  "script", "style", "noscript", "iframe", "svg", "canvas", "video", "audio",
  "nav", "header", "footer", "aside", "form", "button", "select", "textarea",
  "template", "dialog", "menu",
]

/**
 * Class and id fragments that mark page furniture.
 *
 * Crude, and it will occasionally remove something wanted. The trade is worth
 * it: a cookie banner in the middle of an article is far more disruptive to a
 * model reading it than a missing sidebar.
 */
const NOISE_PATTERNS = [
  "cookie", "consent", "banner", "popup", "modal", "overlay",
  "advertisement", "sponsored", "promo",
  "sidebar", "navbar", "navigation", "breadcrumb", "pagination",
  "social-share", "share-button", "newsletter", "subscribe",
  "skip-link", "screen-reader", "sr-only", "visually-hidden",
]

/**
 * Named entities decoded during conversion.
 *
 * Only the ones that actually appear. Numeric entities are handled generically,
 * which covers the rest.
 */
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", ldquo: "\u201c", rdquo: "\u201d",
  lsquo: "\u2018", rsquo: "\u2019", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  deg: "\u00b0", plusmn: "\u00b1", times: "\u00d7", divide: "\u00f7",
  laquo: "\u00ab", raquo: "\u00bb", bull: "\u2022", middot: "\u00b7",
  larr: "\u2190", rarr: "\u2192", harr: "\u2194", darr: "\u2193", uarr: "\u2191",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2", sect: "\u00a7",
  para: "\u00b6", dagger: "\u2020", permil: "\u2030", prime: "\u2032",
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X"
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)

      // Surrogates and out-of-range values would throw. Leaving the raw entity
      // in place is uglier but strictly better than crashing the conversion.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match
      if (code >= 0xd800 && code <= 0xdfff) return match

      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }

    return ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Finds the main content of a page.
 *
 * Tried in order of how strong a signal each is. An explicit `<main>` is
 * definitive; `role="main"` nearly so; `<article>` usually right on a blog. The
 * common documentation class names are last because they are guesses.
 *
 * When nothing matches, the whole body is used and the noise filtering has to do
 * the work alone.
 */
function extractMain(html: string): string {
  const candidates: RegExp[] = [
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<[a-z]+\b[^>]*\brole=["']main["'][^>]*>([\s\S]*?)<\/[a-z]+>/i,
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<div\b[^>]*\bclass=["'][^"']*\b(?:markdown-body|content|article|post-content|entry-content|documentation|doc-content|prose)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div\b[^>]*\bid=["'](?:content|main|main-content|article)["'][^>]*>([\s\S]*?)<\/div>/i,
  ]

  for (const pattern of candidates) {
    const match = pattern.exec(html)

    // A very short match is a false positive \u2014 an empty `<main>` wrapper, or a
    // `<div class="content">` holding only a heading. Fall through to the next.
    if (match?.[1] && match[1].length > 500) return match[1]
  }

  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)

  return body?.[1] ?? html
}

/**
 * Converts HTML to markdown.
 *
 * A regex-based converter rather than a parser. This is the wrong approach in
 * general \u2014 HTML is not regular \u2014 but the goal is not fidelity, it is producing
 * something a model can read from arbitrary and frequently malformed input. A real
 * parser would be a large dependency, would be slower, and would throw on input
 * this one merely handles imperfectly.
 *
 * Order matters throughout. Code blocks are extracted first and reinserted last,
 * because their contents must not be processed as markup: a code sample containing
 * `<div>` should stay `<div>`, not become a heading.
 */
export function htmlToMarkdown(html: string): string {
  let text = extractMain(html)

  // Comments can contain anything, including unbalanced tags that would derail
  // everything after them.
  text = text.replace(/<!--[\s\S]*?-->/g, "")

  for (const element of DROP_ELEMENTS) {
    text = text.replace(new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}>`, "gi"), "")
    text = text.replace(new RegExp(`<${element}\\b[^>]*\\/?>`, "gi"), "")
  }

  // Elements whose class or id marks them as furniture. Non-greedy and
  // single-level, so a nested match is left for a later pass; running it twice
  // catches the common case without risking catastrophic backtracking.
  const noise = new RegExp(
    `<(div|section|span|ul|ol|p)\\b[^>]*(?:class|id)=["'][^"']*\\b(?:${NOISE_PATTERNS.join("|")})\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/\\1>`,
    "gi",
  )

  text = text.replace(noise, "").replace(noise, "")

  // Code blocks come out before anything else touches them.
  const codeBlocks: string[] = []

  text = text.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const languageMatch = /class=["'][^"']*\blanguage-([a-z0-9+#-]+)/i.exec(inner)
    const language = languageMatch?.[1] ?? ""

    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/^\n+|\n+$/g, "")

    codeBlocks.push(`\n\`\`\`${language}\n${code}\n\`\`\`\n`)

    return `\u0000CODE${codeBlocks.length - 1}\u0000`
  })

  const inlineCode: string[] = []

  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner: string) => {
    const code = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim()

    // Backticks inside inline code need a longer fence, same as anywhere else.
    const longest = /`+/.exec(code)?.[0].length ?? 0
    const fence = "`".repeat(Math.max(1, longest + 1))

    inlineCode.push(`${fence}${code}${fence}`)

    return `\u0000INLINE${inlineCode.length - 1}\u0000`
  })

  // Headings, deepest first so h1 does not match inside h10 \u2014 which does not
  // exist, but the same reasoning applies to the ordering generally.
  for (let level = 6; level >= 1; level--) {
    text = text.replace(
      new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"),
      (_match, inner: string) => `\n\n${"#".repeat(level)} ${stripTags(inner)}\n\n`,
    )
  }

  text = text.replace(/<br\b[^>]*\/?>/gi, "\n")
  text = text.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")

  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const content = stripTags(inner)
    return content ? `**${content}**` : ""
  })

  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const content = stripTags(inner)
    return content ? `*${content}*` : ""
  })

  text = text.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const content = stripTags(inner)
    return content ? `~~${content}~~` : ""
  })

  // Links. Fragment-only and javascript hrefs become plain text, since a model
  // cannot follow either and the URL is pure noise in the output.
  text = text.replace(
    /<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_match, href: string, inner: string) => {
      const label = stripTags(inner)

      if (!label) return ""
      if (href.startsWith("#") || href.startsWith("javascript:")) return label

      return `[${label}](${href})`
    },
  )

  // Images keep their alt text, which is often the only description of a
  // diagram. The URL is dropped; a model cannot see the image.
  text = text.replace(/<img\b[^>]*\balt=["']([^"']*)["'][^>]*\/?>/gi, (_m, alt: string) =>
    alt ? `[image: ${alt}]` : "",
  )

  text = text.replace(/<img\b[^>]*\/?>/gi, "")

  text = convertLists(text)
  text = convertTables(text)

  text = text.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const content = stripTags(inner).trim()
    if (!content) return ""

    return `\n\n${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`
  })

  text = text.replace(/<\/(p|div|section|article|li|tr|dd|dt)>/gi, "\n\n")
  text = text.replace(/<[^>]+>/g, "")
  text = decodeEntities(text)

  // Non-breaking spaces survive decoding as U+00A0 and confuse both wrapping
  // and any downstream matching on the content.
  text = text.replace(/\u00a0/g, " ")

  // Whitespace normalisation, in this order: trailing spaces, then runs of
  // blank lines, then leading and trailing blank lines.
  text = text
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")

  text = text.replace(/\u0000INLINE(\d+)\u0000/g, (_m, index: string) => inlineCode[Number(index)] ?? "")
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, index: string) => codeBlocks[Number(index)] ?? "")

  return text.replace(/\n{3,}/g, "\n\n")
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim()
}

/**
 * Converts lists.
 *
 * Nesting is not tracked. Doing it properly needs a parser, and the failure
 * mode without it \u2014 a flat list where the original had two levels \u2014 loses very
 * little of what the model needs.
 */
function convertLists(html: string): string {
  let text = html

  text = text.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_match, inner: string) => {
    let index = 0

    const items = inner.replace(/<li\b[^>]*>([\s\S]*?)(?:<\/li>|(?=<li\b)|$)/gi, (_m, item: string) => {
      const content = stripTags(item)
      if (!content) return ""

      index++
      return `${index}. ${content}\n`
    })

    return `\n\n${items.replace(/<[^>]+>/g, "").trim()}\n\n`
  })

  text = text.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_match, inner: string) => {
    const items = inner.replace(/<li\b[^>]*>([\s\S]*?)(?:<\/li>|(?=<li\b)|$)/gi, (_m, item: string) => {
      const content = stripTags(item)
      return content ? `- ${content}\n` : ""
    })

    return `\n\n${items.replace(/<[^>]+>/g, "").trim()}\n\n`
  })

  // Definition lists appear throughout API documentation and read acceptably
  // as a bold term followed by its description.
  text = text.replace(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi, (_match, inner: string) => {
    let out = "\n\n"

    const pattern = /<(dt|dd)\b[^>]*>([\s\S]*?)(?:<\/\1>|(?=<d[td]\b)|$)/gi
    let match: RegExpExecArray | null

    while ((match = pattern.exec(inner)) !== null) {
      const content = stripTags(match[2] ?? "")
      if (!content) continue

      out += match[1]!.toLowerCase() === "dt" ? `\n**${content}**\n` : `${content}\n`
    }

    return `${out}\n`
  })

  return text
}

/**
 * Converts tables to pipe tables.
 *
 * Tables carry real information in API documentation \u2014 parameter names, types,
 * defaults \u2014 and flattening them to prose destroys the correspondence between
 * columns. Worth the extra handling.
 */
function convertTables(html: string): string {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, inner: string) => {
    const rows: string[][] = []

    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let rowMatch: RegExpExecArray | null

    while ((rowMatch = rowPattern.exec(inner)) !== null) {
      const cells: string[] = []

      const cellPattern = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cellMatch: RegExpExecArray | null

      while ((cellMatch = cellPattern.exec(rowMatch[1] ?? "")) !== null) {
        // A literal pipe would break the table structure.
        cells.push(stripTags(cellMatch[2] ?? "").replace(/\|/g, "\\|"))
      }

      if (cells.length > 0) rows.push(cells)
    }

    if (rows.length === 0) return ""

    const width = Math.max(...rows.map((row) => row.length))
    const lines: string[] = []

    const header = rows[0]!
    lines.push(`| ${pad(header, width).join(" | ")} |`)
    lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`)

    for (const row of rows.slice(1)) {
      lines.push(`| ${pad(row, width).join(" | ")} |`)
    }

    return `\n\n${lines.join("\n")}\n\n`
  })
}

function pad(row: string[], width: number): string[] {
  const out = [...row]
  while (out.length < width) out.push("")
  return out
}

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

interface FetchOutcome {
  readonly content: string
  readonly contentType: string
  readonly finalUrl: string
  readonly status: number
  readonly fromCache: boolean
}

/**
 * Fetches a URL, following redirects manually.
 *
 * Manual rather than automatic because the final URL matters: relative links in
 * the content resolve against it, and reporting the pre-redirect URL back to the
 * model makes every link it extracts wrong.
 */
async function fetchUrl(url: string, timeoutMs: number): Promise<FetchOutcome> {
  const cached = cacheGet(url)

  if (cached) {
    return {
      content: cached.content,
      contentType: cached.contentType,
      finalUrl: cached.finalUrl,
      status: 200,
      fromCache: true,
    }
  }

  let current = url
  let redirects = 0

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    for (;;) {
      const response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          // Markdown first: a growing number of documentation hosts serve it
          // directly, which skips the conversion entirely and is both faster
          // and higher fidelity than anything derived from their HTML.
          accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, application/json;q=0.7, */*;q=0.1",
          "accept-language": "en-US,en;q=0.9",
        },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")

        if (!location) throw new Error(`${response.status} redirect with no destination.`)

        if (++redirects > MAX_REDIRECTS) {
          throw new Error(`Gave up after ${MAX_REDIRECTS} redirects; the URL is probably looping.`)
        }

        current = new URL(location, current).toString()
        continue
      }

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText || "request failed"}`)
      }

      const contentType = response.headers.get("content-type") ?? ""

      // Reject binary before reading the body. Downloading five megabytes of
      // PDF to discover it is a PDF is a waste of the user's bandwidth.
      if (isBinaryContentType(contentType)) {
        throw new Error(
          `That URL serves ${contentType.split(";")[0]}, which is not text. There is nothing readable to return.`,
        )
      }

      const declared = Number(response.headers.get("content-length") ?? "0")

      if (declared > MAX_BODY_BYTES) {
        throw new Error(
          `The page is ${(declared / 1024 / 1024).toFixed(1)} MB, above the ${MAX_BODY_BYTES / 1024 / 1024} MB limit.`,
        )
      }

      const content = await readCapped(response, MAX_BODY_BYTES)

      cacheSet(url, { content, contentType, finalUrl: current, at: Date.now() })

      return { content, contentType, finalUrl: current, status: response.status, fromCache: false }
    }
  } finally {
    clearTimeout(timer)
  }
}

function isBinaryContentType(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""

  if (type.startsWith("text/")) return false
  if (type === "application/json" || type === "application/xml") return false
  if (type.endsWith("+json") || type.endsWith("+xml")) return false
  if (type === "application/javascript" || type === "application/x-ndjson") return false

  return type !== ""
}

/**
 * Reads a body up to a byte cap.
 *
 * Streaming rather than `response.text()`, so a server lying about
 * `content-length` cannot exhaust memory.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()

  if (!reader) return response.text()

  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) break
    if (!value) continue

    total += value.byteLength
    chunks.push(value)

    if (total > maxBytes) {
      await reader.cancel()
      break
    }
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks))
}

/* ------------------------------------------------------------------ */
/* webfetch                                                            */
/* ------------------------------------------------------------------ */

const FETCH_DESCRIPTION = `Fetch a web page and return its content.

HTML is converted to markdown, which strips navigation, scripts, and styling so what comes back is the actual content. Pages that serve markdown directly are returned unchanged.

Usage:
- The url must be absolute and start with http:// or https://.
- format defaults to "markdown". Use "text" for plain text with no markup, or "html" for the raw source when you specifically need the markup.
- Long pages are truncated. Use offset to continue from where the previous call stopped.
- Results are cached for fifteen minutes, so re-fetching the same URL is free.
- Use this when you have a URL. To find one, use websearch first.`

export const webFetchTool = defineTool({
  id: "webfetch",
  action: "network",
  readOnly: true,
  concurrent: true,

  init: () => ({
    description: FETCH_DESCRIPTION,

    parameters: s.object({
      url: s.string().describe("Absolute URL to fetch, starting with http:// or https://"),
      format: s
        .enum(["markdown", "text", "html"])
        .optional()
        .describe('Output format. Defaults to "markdown".'),
      offset: s.number().optional().describe("Character offset to start from, for continuing a truncated fetch"),
      limit: s.number().optional().describe(`Maximum characters to return. Defaults to ${DEFAULT_LIMIT}.`),
      timeout: s.number().optional().describe("Timeout in seconds, up to 120"),
    }),

    async execute(input: {
      url: string
      format?: "markdown" | "text" | "html"
      offset?: number
      limit?: number
      timeout?: number
    }, context: ToolContext) {
      let parsed: URL

      try {
        parsed = new URL(input.url)
      } catch {
        return fail(`"${input.url}" is not a valid URL.`)
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return fail(`Only http and https are supported; got ${parsed.protocol}`)
      }

      // Loopback and link-local addresses are a server-side request forgery
      // vector: a model persuaded by page content to fetch the cloud metadata
      // endpoint would read credentials. Blocked outright.
      if (isPrivateHost(parsed.hostname)) {
        return fail(
          `${parsed.hostname} is a local or private address. Fetching it from here could expose internal services, so it is not allowed. Use the bash tool if you genuinely need to reach a local server.`,
        )
      }

      await context.ask({
        action: "network",
        resource: parsed.origin,
        title: `Fetch ${parsed.hostname}`,
        detail: input.url,
        pattern: `${parsed.protocol}//${parsed.hostname}/*`,
        risk: "low",
      })

      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        input.timeout !== undefined ? input.timeout * 1000 : DEFAULT_TIMEOUT_MS,
      )

      let outcome: FetchOutcome

      try {
        outcome = await fetchUrl(input.url, timeoutMs)
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return fail(`${parsed.hostname} did not respond within ${timeoutMs / 1000} seconds.`)
        }

        return fail(
          `Could not fetch ${input.url}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      const format = input.format ?? "markdown"
      const type = outcome.contentType.split(";")[0]?.trim().toLowerCase() ?? ""

      let content: string

      if (format === "html") {
        content = outcome.content
      } else if (type === "text/markdown" || type === "text/plain") {
        // Already what was asked for.
        content = outcome.content
      } else if (type === "application/json" || type.endsWith("+json")) {
        // Pretty-print JSON. A minified API response on one line is unreadable
        // and, worse, tokenises badly.
        try {
          content = JSON.stringify(JSON.parse(outcome.content), null, 2)
        } catch {
          content = outcome.content
        }
      } else if (format === "text") {
        content = stripTags(extractMain(outcome.content)).replace(/\s{2,}/g, " ")
      } else {
        content = htmlToMarkdown(outcome.content)
      }

      const title = extractTitle(outcome.content)

      const offset = Math.max(0, input.offset ?? 0)
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT))

      const slice = content.slice(offset, offset + limit)
      const remaining = Math.max(0, content.length - offset - slice.length)

      const header: string[] = []

      if (title) header.push(`# ${title}`)

      // Only mention the URL when a redirect changed it. Repeating the URL the
      // model just supplied is noise.
      if (outcome.finalUrl !== input.url) header.push(`Redirected to: ${outcome.finalUrl}`)

      const parts = [header.join("\n"), slice].filter(Boolean)

      if (remaining > 0) {
        parts.push(
          `\n[${remaining} characters remain. To continue, fetch again with offset ${offset + slice.length}.]`,
        )
      }

      log.info("fetched a page", {
        url: input.url,
        bytes: outcome.content.length,
        returned: slice.length,
        cached: outcome.fromCache,
      })

      return ok(parts.join("\n\n"), {
        title: title ?? parsed.hostname,
        metadata: {
          url: outcome.finalUrl,
          contentType: outcome.contentType,
          characters: content.length,
          returned: slice.length,
          truncated: remaining > 0,
          cached: outcome.fromCache,
        },
      })
    },
  }),
})

function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)

  if (!match?.[1]) return undefined

  const title = stripTags(match[1])

  return title === "" ? undefined : truncate(title, 120)
}

/**
 * Whether a hostname points somewhere internal.
 *
 * Covers loopback, the private IPv4 ranges, link-local (including the cloud
 * metadata address), and the IPv6 equivalents. Not a complete defence \u2014 a DNS name
 * resolving to a private address gets through \u2014 but it stops the direct attempt.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")

  if (host === "localhost" || host.endsWith(".localhost")) return true
  if (host === "::1" || host === "0.0.0.0") return true
  if (host.endsWith(".local") || host.endsWith(".internal")) return true

  // IPv6 unique-local and link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe80:/.test(host)) return true

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)

  if (!ipv4) return false

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]

  if (a === 127 || a === 10 || a === 0) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true

  return false
}

/* ------------------------------------------------------------------ */
/* websearch                                                           */
/* ------------------------------------------------------------------ */

export interface SearchResult {
  readonly title: string
  readonly url: string
  readonly snippet: string
}

export type SearchBackend = (query: string, count: number) => Promise<SearchResult[]>

const backends = new Map<string, SearchBackend>()

/**
 * Registers a search backend.
 *
 * Plugins use this, and so does the provider layer when the active model's
 * provider offers hosted search. Ordering is insertion order, so a backend
 * registered by a plugin is tried before the built-in scraper.
 */
export function registerSearchBackend(name: string, backend: SearchBackend): void {
  backends.set(name, backend)
  log.debug("search backend registered", { name })
}

export function unregisterSearchBackend(name: string): void {
  backends.delete(name)
}

export function searchBackendNames(): string[] {
  return [...backends.keys()]
}

/**
 * Exa, when a key is configured.
 *
 * Registered lazily so that no key means no backend, rather than a backend that
 * fails on every call.
 */
function exaBackend(apiKey: string): SearchBackend {
  return async (query, count) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

    try {
      const response = await fetch("https://api.exa.ai/search", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: count,
          type: "auto",
          contents: { text: { maxCharacters: 800 } },
        }),
      })

      if (!response.ok) throw new Error(`Exa returned ${response.status}`)

      const body = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; text?: string }>
      }

      return (body.results ?? []).map((result) => ({
        title: result.title ?? result.url ?? "Untitled",
        url: result.url ?? "",
        snippet: truncate((result.text ?? "").replace(/\s+/g, " ").trim(), 400),
      }))
    } finally {
      clearTimeout(timer)
    }
  }
}

function braveBackend(apiKey: string): SearchBackend {
  return async (query, count) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

    try {
      const url = new URL("https://api.search.brave.com/res/v1/web/search")
      url.searchParams.set("q", query)
      url.searchParams.set("count", String(count))

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: "application/json", "x-subscription-token": apiKey },
      })

      if (!response.ok) throw new Error(`Brave returned ${response.status}`)

      const body = (await response.json()) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
      }

      return (body.web?.results ?? []).map((result) => ({
        title: stripTags(result.title ?? ""),
        url: result.url ?? "",
        snippet: stripTags(result.description ?? ""),
      }))
    } finally {
      clearTimeout(timer)
    }
  }
}

function tavilyBackend(apiKey: string): SearchBackend {
  return async (query, count) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          max_results: count,
          search_depth: "basic",
        }),
      })

      if (!response.ok) throw new Error(`Tavily returned ${response.status}`)

      const body = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>
      }

      return (body.results ?? []).map((result) => ({
        title: result.title ?? "Untitled",
        url: result.url ?? "",
        snippet: truncate((result.content ?? "").replace(/\s+/g, " ").trim(), 400),
      }))
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * The no-key fallback: DuckDuckGo's HTML endpoint.
 *
 * Scraping, with everything that implies \u2014 it will break when the markup changes,
 * and it is rate-limited. It exists so that search works out of the box, because
 * the alternative is a tool that is advertised to the model and then fails,
 * which is worse than no tool at all.
 */
const duckduckgoBackend: SearchBackend = async (query, count) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    })

    if (!response.ok) throw new Error(`DuckDuckGo returned ${response.status}`)

    const html = await response.text()
    const results: SearchResult[] = []

    const pattern =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>)?/gi

    let match: RegExpExecArray | null

    while ((match = pattern.exec(html)) !== null && results.length < count) {
      let href = match[1] ?? ""

      // The links are wrapped in a redirect whose real destination is in the
      // `uddg` parameter.
      const wrapped = /[?&]uddg=([^&]+)/.exec(href)

      if (wrapped?.[1]) {
        try {
          href = decodeURIComponent(wrapped[1])
        } catch {
          // Keep the wrapper URL; it still resolves.
        }
      }

      if (href.startsWith("//")) href = `https:${href}`
      if (!href.startsWith("http")) continue

      results.push({
        title: stripTags(match[2] ?? ""),
        url: href,
        snippet: stripTags(match[3] ?? ""),
      })
    }

    return results
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Installs whichever keyed backends are configured.
 *
 * Called at startup. Environment variables rather than configuration, because
 * these are secrets and secrets do not belong in a file that gets committed.
 */
export function initSearchBackends(env: NodeJS.ProcessEnv = process.env): void {
  const exa = env.EXA_API_KEY ?? env.PRAXIS_EXA_API_KEY
  const brave = env.BRAVE_API_KEY ?? env.BRAVE_SEARCH_API_KEY
  const tavily = env.TAVILY_API_KEY

  if (exa) registerSearchBackend("exa", exaBackend(exa))
  if (brave) registerSearchBackend("brave", braveBackend(brave))
  if (tavily) registerSearchBackend("tavily", tavilyBackend(tavily))

  registerSearchBackend("duckduckgo", duckduckgoBackend)
}

const SEARCH_DESCRIPTION = `Search the web.

Returns titles, URLs, and snippets. Use webfetch on a result to read the page itself \u2014 snippets are rarely enough to answer anything precisely.

Usage:
- Write the query the way you would type it into a search engine, not as a question to an assistant.
- Include version numbers, error text, and library names verbatim. Exact strings are what make a search useful.
- Use this for anything after your training cutoff, for current documentation, and for error messages you do not recognise.
- Do not use it for anything about this codebase. Use grep and read for that.`

export const webSearchTool = defineTool({
  id: "websearch",
  action: "network",
  readOnly: true,
  concurrent: true,

  init: () => ({
    description: SEARCH_DESCRIPTION.replace("{{year}}", String(new Date().getFullYear())),

    parameters: s.object({
      query: s.string().describe("The search query"),
      count: s.number().optional().describe(`Results to return. Defaults to ${DEFAULT_RESULTS}.`),
    }),

    async execute(input: { query: string; count?: number }, context: ToolContext) {
      const query = input.query.trim()

      if (query === "") return fail("The query is empty.")

      if (backends.size === 0) initSearchBackends()

      await context.ask({
        action: "network",
        resource: "websearch",
        title: "Search the web",
        detail: query,
        pattern: "websearch",
        risk: "low",
      })

      const count = Math.min(25, Math.max(1, input.count ?? DEFAULT_RESULTS))
      const failures: string[] = []

      for (const [name, backend] of backends) {
        try {
          const results = await backend(query, count)

          if (results.length === 0) {
            failures.push(`${name}: no results`)
            continue
          }

          log.info("web search returned results", { backend: name, query, results: results.length })

          return ok(renderResults(query, results), {
            title: truncate(query, 60),
            metadata: { backend: name, query, count: results.length },
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)

          log.debug("a search backend failed", { backend: name, error: message })
          failures.push(`${name}: ${message}`)
        }
      }

      return fail(
        [
          `The search for "${query}" did not return anything.`,
          failures.length > 0 ? `Backends tried \u2014 ${failures.join("; ")}.` : "",
          "Setting EXA_API_KEY, BRAVE_API_KEY, or TAVILY_API_KEY gives a reliable backend instead of the scraped fallback.",
        ]
          .filter(Boolean)
          .join(" "),
      )
    },
  }),
})

/**
 * Formats results.
 *
 * Numbered, with the URL on its own line. Numbering lets the model refer to a
 * result without repeating the URL, and putting the URL on its own line keeps it
 * intact when the terminal wraps.
 */
function renderResults(query: string, results: SearchResult[]): string {
  const lines = [`Results for "${query}":`, ""]

  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`)
    lines.push(`   ${result.url}`)

    if (result.snippet) lines.push(`   ${truncate(result.snippet, 300)}`)

    lines.push("")
  })

  lines.push("Use webfetch on any of these to read the page.")

  return lines.join("\n")
}

export const WEB_TOOLS = [webFetchTool, webSearchTool]
