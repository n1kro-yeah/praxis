/**
 * Language grammars for the terminal highlighter.
 *
 * These are regular-expression grammars, not parsers. That is a real limitation
 * and worth being explicit about: a regex cannot tell a division sign from the
 * start of a regex literal, cannot match nested template expressions properly,
 * and will colour a keyword that appears inside an identifier if the word
 * boundaries are wrong.
 *
 * The tradeoff is deliberate. A real parser per language means a grammar
 * dependency for each one, several megabytes of tables, and a startup cost paid on
 * every launch, to fix colouring errors in code the user is reading rather than
 * compiling. Highlighting that is right ninety-five percent of the time and
 * instant beats highlighting that is perfect and adds two hundred milliseconds to
 * startup.
 *
 * Rule order matters enormously. Rules are tried in sequence at each position
 * and the first match wins, so comments and strings must precede everything that
 * could match inside them. Getting this wrong produces the classic failure where
 * a keyword inside a string is coloured as a keyword.
 */

/* ------------------------------------------------------------------ */
/* Token kinds                                                         */
/* ------------------------------------------------------------------ */

/**
 * The set of things a token can be.
 *
 * Kept small on purpose. Each kind needs a colour in every theme, and a palette
 * with forty distinctions is one nobody can design for. These twelve cover the
 * distinctions that actually aid reading.
 */
export type TokenKind =
  | "keyword"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "variable"
  | "constant"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "text"

export interface Rule {
  readonly kind: TokenKind
  readonly pattern: RegExp
  /**
   * Which capture group carries the token.
   *
   * Needed when a pattern has to match context that is not part of the token
   * itself: matching `function name` to colour only `name` requires consuming
   * the keyword too, or the pattern would match any identifier.
   */
  readonly group?: number
}

export interface Grammar {
  readonly name: string
  readonly aliases: readonly string[]
  readonly extensions: readonly string[]
  readonly rules: readonly Rule[]
  /** Whether identifiers are case sensitive, for keyword matching. */
  readonly caseSensitive?: boolean
}

/* ------------------------------------------------------------------ */
/* Shared fragments                                                    */
/* ------------------------------------------------------------------ */

/**
 * Rules shared by the C-family languages.
 *
 * Factored out because getting string escaping right is fiddly and duplicating
 * it fifteen times guarantees the copies drift apart. The escape handling
 * (`\\.` inside the character class) is the part that matters: without it, a
 * string containing an escaped quote terminates early and everything after it is
 * mis-coloured to the end of the line.
 */
const C_COMMENTS: Rule[] = [
  { kind: "comment", pattern: /\/\*[\s\S]*?\*\// },
  { kind: "comment", pattern: /\/\/[^\n]*/ },
]

const C_STRINGS: Rule[] = [
  { kind: "string", pattern: /"(?:[^"\\\n]|\\.)*"/ },
  { kind: "string", pattern: /'(?:[^'\\\n]|\\.)*'/ },
]

const C_NUMBERS: Rule[] = [
  // Hex, binary, and octal first: `0x1f` would otherwise match as `0` followed
  // by the identifier `x1f`.
  { kind: "number", pattern: /\b0[xX][0-9a-fA-F_]+[uUlLnf]*\b/ },
  { kind: "number", pattern: /\b0[bB][01_]+[uUlLnf]*\b/ },
  { kind: "number", pattern: /\b0[oO][0-7_]+[uUlLnf]*\b/ },
  { kind: "number", pattern: /\b\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?[uUlLnfdmF]*\b/ },
]

const C_OPERATORS: Rule[] = [
  { kind: "operator", pattern: /[+\-*/%=<>!&|^~?:]+/ },
  { kind: "punctuation", pattern: /[{}()[\],;.]/ },
]

/** Builds a word-boundary alternation from a keyword list. */
function words(list: readonly string[]): RegExp {
  // Sorted longest first so that `instanceof` is not matched as `in`, which
  // would leave `stanceof` to be coloured as an identifier.
  const sorted = [...list].sort((left, right) => right.length - left.length)

  return new RegExp("\\b(?:" + sorted.join("|") + ")\\b")
}

/* ------------------------------------------------------------------ */
/* Keyword lists                                                       */
/* ------------------------------------------------------------------ */

const JS_KEYWORDS = [
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "infer", "instanceof", "interface", "is",
  "keyof", "let", "namespace", "new", "of", "override", "package", "private",
  "protected", "public", "readonly", "return", "satisfies", "set", "static",
  "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void",
  "while", "with", "yield",
]

const JS_TYPES = [
  "any", "bigint", "boolean", "never", "number", "object", "string", "symbol",
  "unknown", "Array", "Map", "Set", "Promise", "Record", "Partial", "Required",
  "Readonly", "Pick", "Omit", "Exclude", "Extract", "ReturnType", "Parameters",
  "Date", "RegExp", "Error", "JSON", "Math", "Object", "String", "Number",
  "Boolean", "Function", "Buffer", "Uint8Array",
]

const JS_CONSTANTS = ["true", "false", "null", "undefined", "NaN", "Infinity", "globalThis"]

const PYTHON_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass",
  "raise", "return", "try", "while", "with", "yield", "case",
]

const PYTHON_TYPES = [
  "int", "float", "str", "bool", "bytes", "list", "dict", "set", "tuple",
  "frozenset", "complex", "object", "type", "Any", "Optional", "Union", "List",
  "Dict", "Set", "Tuple", "Callable", "Iterable", "Iterator", "Sequence",
]

const GO_KEYWORDS = [
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
]

const GO_TYPES = [
  "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr", "any",
]

const RUST_KEYWORDS = [
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
  "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
  "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
  "struct", "super", "trait", "type", "unsafe", "use", "where", "while",
]

const RUST_TYPES = [
  "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize",
  "str", "u8", "u16", "u32", "u64", "u128", "usize", "String", "Vec", "Option",
  "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "BTreeMap",
]

const JAVA_KEYWORDS = [
  "abstract", "assert", "break", "case", "catch", "class", "const", "continue",
  "default", "do", "else", "enum", "extends", "final", "finally", "for", "goto",
  "if", "implements", "import", "instanceof", "interface", "native", "new",
  "package", "private", "protected", "public", "return", "static", "strictfp",
  "super", "switch", "synchronized", "this", "throw", "throws", "transient",
  "try", "var", "void", "volatile", "while", "record", "sealed", "yield",
]

const JAVA_TYPES = [
  "boolean", "byte", "char", "double", "float", "int", "long", "short",
  "String", "Object", "Integer", "Long", "Double", "Float", "Boolean",
  "Character", "List", "Map", "Set", "Optional", "Stream",
]

const RUBY_KEYWORDS = [
  "alias", "and", "begin", "break", "case", "class", "def", "defined?", "do",
  "else", "elsif", "end", "ensure", "for", "if", "in", "module", "next", "not",
  "or", "redo", "rescue", "retry", "return", "self", "super", "then", "undef",
  "unless", "until", "when", "while", "yield", "require", "require_relative",
  "attr_accessor", "attr_reader", "attr_writer",
]

const SHELL_KEYWORDS = [
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until",
  "do", "done", "function", "select", "time", "in", "return", "local", "export",
  "readonly", "declare", "typeset", "unset", "source", "alias", "set", "shift",
  "trap", "exit", "break", "continue", "eval", "exec",
]

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "JOIN",
  "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "ON", "AS", "AND", "OR",
  "NOT", "NULL", "IS", "IN", "BETWEEN", "LIKE", "ORDER", "BY", "GROUP",
  "HAVING", "LIMIT", "OFFSET", "UNION", "ALL", "DISTINCT", "CASE", "WHEN",
  "THEN", "ELSE", "END", "WITH", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  "UNIQUE", "DEFAULT", "CHECK", "CONSTRAINT", "CASCADE", "RETURNING",
]

const CSHARP_KEYWORDS = [
  "abstract", "as", "async", "await", "base", "break", "case", "catch",
  "checked", "class", "const", "continue", "default", "delegate", "do", "else",
  "enum", "event", "explicit", "extern", "finally", "fixed", "for", "foreach",
  "goto", "if", "implicit", "in", "interface", "internal", "is", "lock",
  "namespace", "new", "operator", "out", "override", "params", "private",
  "protected", "public", "readonly", "ref", "return", "sealed", "sizeof",
  "stackalloc", "static", "switch", "this", "throw", "try", "typeof",
  "unchecked", "unsafe", "using", "virtual", "void", "volatile", "while",
  "record", "init", "required", "with", "yield", "var", "nameof",
]

const PHP_KEYWORDS = [
  "abstract", "and", "array", "as", "break", "callable", "case", "catch",
  "class", "clone", "const", "continue", "declare", "default", "do", "echo",
  "else", "elseif", "empty", "enddeclare", "endfor", "endforeach", "endif",
  "endswitch", "endwhile", "enum", "extends", "final", "finally", "fn", "for",
  "foreach", "function", "global", "goto", "if", "implements", "include",
  "instanceof", "insteadof", "interface", "isset", "list", "match", "namespace",
  "new", "or", "print", "private", "protected", "public", "readonly", "require",
  "return", "static", "switch", "throw", "trait", "try", "unset", "use", "var",
  "while", "xor", "yield",
]

/* ------------------------------------------------------------------ */
/* Grammars                                                            */
/* ------------------------------------------------------------------ */

const typescript: Grammar = {
  name: "typescript",
  aliases: ["ts", "tsx", "javascript", "js", "jsx", "mjs", "cjs", "mts", "cts"],
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  rules: [
    ...C_COMMENTS,
    // Template literals before ordinary strings, or the backtick is not
    // recognised and the contents fall through to the other rules.
    { kind: "string", pattern: /`(?:[^`\\]|\\[\s\S])*`/ },
    ...C_STRINGS,
    // Regex literals need the preceding character to disambiguate from
    // division. Matching an operator or bracket before the slash catches the
    // common cases without a full parse.
    { kind: "string", pattern: /(^|[=(,:[!&|?{};+\-*/%<>~^]\s*)(\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuyvd]*)/, group: 2 },
    { kind: "comment", pattern: /^#!.*$/ },
    // Decorators are distinctive and read better in the function colour.
    { kind: "function", pattern: /@[A-Za-z_$][\w$]*/ },
    { kind: "constant", pattern: words(JS_CONSTANTS) },
    { kind: "keyword", pattern: words(JS_KEYWORDS) },
    { kind: "type", pattern: words(JS_TYPES) },
    ...C_NUMBERS,
    // An identifier followed by an opening paren is a call. Not always true,
    // but the exceptions are rare enough that the colour still helps.
    { kind: "function", pattern: /([A-Za-z_$][\w$]*)\s*(?=\()/, group: 1 },
    // Capitalised identifiers are almost always types or classes by convention.
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_$]*\b/ },
    // Screaming case is the near-universal marker for a constant.
    { kind: "constant", pattern: /\b[A-Z][A-Z0-9_]{2,}\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_$][\w$]*/ },
  ],
}

const python: Grammar = {
  name: "python",
  aliases: ["py", "python3"],
  extensions: [".py", ".pyi", ".pyw"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    // Triple quotes first, or the first two quotes match as an empty string and
    // the docstring body is left uncoloured.
    { kind: "string", pattern: /[rbfuRBFU]{0,3}"""[\s\S]*?"""/ },
    { kind: "string", pattern: /[rbfuRBFU]{0,3}'''[\s\S]*?'''/ },
    { kind: "string", pattern: /[rbfuRBFU]{0,3}"(?:[^"\\\n]|\\.)*"/ },
    { kind: "string", pattern: /[rbfuRBFU]{0,3}'(?:[^'\\\n]|\\.)*'/ },
    { kind: "function", pattern: /@[A-Za-z_][\w.]*/ },
    { kind: "constant", pattern: /\b(?:True|False|None|NotImplemented|Ellipsis|__name__|__main__)\b/ },
    { kind: "keyword", pattern: words(PYTHON_KEYWORDS) },
    { kind: "type", pattern: words(PYTHON_TYPES) },
    { kind: "number", pattern: /\b0[xXbBoO][0-9a-fA-F_]+\b/ },
    { kind: "number", pattern: /\b\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?[jJ]?\b/ },
    { kind: "function", pattern: /\b(?:def|class)\s+([A-Za-z_]\w*)/, group: 1 },
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "constant", pattern: /\b[A-Z][A-Z0-9_]{2,}\b/ },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    { kind: "operator", pattern: /[+\-*/%=<>!&|^~@]+/ },
    { kind: "punctuation", pattern: /[{}()[\],;.:]/ },
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const go: Grammar = {
  name: "go",
  aliases: ["golang"],
  extensions: [".go"],
  rules: [
    ...C_COMMENTS,
    // Raw strings can span lines and ignore escapes entirely.
    { kind: "string", pattern: /`[^`]*`/ },
    ...C_STRINGS,
    { kind: "constant", pattern: /\b(?:true|false|nil|iota)\b/ },
    { kind: "keyword", pattern: words(GO_KEYWORDS) },
    { kind: "type", pattern: words(GO_TYPES) },
    ...C_NUMBERS,
    { kind: "function", pattern: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, group: 1 },
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const rust: Grammar = {
  name: "rust",
  aliases: ["rs"],
  extensions: [".rs"],
  rules: [
    ...C_COMMENTS,
    // Raw strings with hashes, which can contain quotes freely.
    { kind: "string", pattern: /r#*"[\s\S]*?"#*/ },
    ...C_STRINGS,
    { kind: "function", pattern: /#!?\[[^\]]*\]/ },
    // Macros are worth distinguishing: the trailing bang changes the semantics
    // completely and is easy to miss in dense code.
    { kind: "function", pattern: /\b[a-z_]\w*!/ },
    { kind: "constant", pattern: /\b(?:true|false|None|Some|Ok|Err)\b/ },
    { kind: "keyword", pattern: words(RUST_KEYWORDS) },
    { kind: "type", pattern: words(RUST_TYPES) },
    // Lifetimes, which look like nothing else in the language.
    { kind: "attribute", pattern: /'[a-z_]\w*\b/ },
    ...C_NUMBERS,
    { kind: "function", pattern: /\bfn\s+([A-Za-z_]\w*)/, group: 1 },
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const json: Grammar = {
  name: "json",
  aliases: ["jsonc", "json5"],
  extensions: [".json", ".jsonc", ".json5"],
  rules: [
    // Not valid JSON, but jsonc and json5 allow them and this grammar covers
    // both. Colouring a comment in strict JSON is harmless; failing to colour
    // one in jsonc is not.
    ...C_COMMENTS,
    // A key is a string followed by a colon. Matching it first gives keys and
    // values different colours, which is the single most useful distinction
    // when reading configuration.
    { kind: "attribute", pattern: /("(?:[^"\\]|\\.)*")\s*(?=:)/, group: 1 },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"/ },
    { kind: "constant", pattern: /\b(?:true|false|null)\b/ },
    { kind: "number", pattern: /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
    { kind: "punctuation", pattern: /[{}[\],:]/ },
  ],
}

const yaml: Grammar = {
  name: "yaml",
  aliases: ["yml"],
  extensions: [".yaml", ".yml"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    // Document markers, which are structural and easy to overlook.
    { kind: "punctuation", pattern: /^---$|^\.\.\.$/ },
    { kind: "attribute", pattern: /^(\s*-?\s*)([A-Za-z_][\w.-]*)\s*(?=:)/, group: 2 },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"/ },
    { kind: "string", pattern: /'(?:[^']|'')*'/ },
    { kind: "constant", pattern: /\b(?:true|false|null|yes|no|on|off|~)\b/i },
    { kind: "number", pattern: /\b-?\d+(?:\.\d+)?\b/ },
    // Anchors and references.
    { kind: "function", pattern: /[&*][A-Za-z_][\w-]*/ },
    { kind: "type", pattern: /!!?[A-Za-z_][\w:/.-]*/ },
    { kind: "punctuation", pattern: /[-:[\]{},|>]/ },
  ],
}

const markdown: Grammar = {
  name: "markdown",
  aliases: ["md", "mdx"],
  extensions: [".md", ".markdown", ".mdx"],
  rules: [
    // Fenced blocks first, or their contents get treated as markdown.
    { kind: "string", pattern: /^```[\s\S]*?^```/m },
    { kind: "string", pattern: /`[^`\n]+`/ },
    { kind: "keyword", pattern: /^#{1,6}\s.*$/m },
    { kind: "comment", pattern: /^>\s?.*$/m },
    { kind: "function", pattern: /\[[^\]]*\]\([^)]*\)/ },
    { kind: "type", pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
    { kind: "variable", pattern: /\*[^*\n]+\*|_[^_\n]+_/ },
    { kind: "punctuation", pattern: /^\s*[-*+]\s|^\s*\d+\.\s/m },
    { kind: "comment", pattern: /^(?:---|\*\*\*|___)$/m },
  ],
}

const shell: Grammar = {
  name: "shell",
  aliases: ["bash", "sh", "zsh", "fish", "console", "shellscript"],
  extensions: [".sh", ".bash", ".zsh", ".fish", ".bashrc", ".zshrc"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    // Double-quoted strings can contain expansions, but colouring the whole
    // thing as a string is close enough and avoids a nested tokeniser.
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"/ },
    { kind: "string", pattern: /'[^']*'/ },
    { kind: "variable", pattern: /\$\{[^}]*\}|\$[A-Za-z_]\w*|\$[0-9@*#?$!-]/ },
    { kind: "keyword", pattern: words(SHELL_KEYWORDS) },
    // Long and short options, which carry most of the meaning in a command line.
    { kind: "attribute", pattern: /(?:^|\s)(--?[A-Za-z][\w-]*)/, group: 1 },
    { kind: "number", pattern: /\b\d+\b/ },
    { kind: "operator", pattern: /[|&;<>()]+|&&|\|\|/ },
    { kind: "function", pattern: /^\s*([A-Za-z_][\w-]*)\s*(?=\(\))/m, group: 1 },
  ],
}

const html: Grammar = {
  name: "html",
  aliases: ["htm", "xhtml", "vue", "svelte"],
  extensions: [".html", ".htm", ".xhtml", ".vue", ".svelte"],
  rules: [
    { kind: "comment", pattern: /<!--[\s\S]*?-->/ },
    { kind: "keyword", pattern: /<!DOCTYPE[^>]*>/i },
    { kind: "tag", pattern: /<\/?([A-Za-z][\w:-]*)/, group: 1 },
    { kind: "attribute", pattern: /\b([A-Za-z_:][\w:.-]*)\s*(?==)/, group: 1 },
    { kind: "string", pattern: /"(?:[^"]|\\.)*"|'(?:[^']|\\.)*'/ },
    { kind: "punctuation", pattern: /[<>/=]/ },
  ],
}

const css: Grammar = {
  name: "css",
  aliases: ["scss", "sass", "less", "stylus"],
  extensions: [".css", ".scss", ".sass", ".less", ".styl"],
  rules: [
    { kind: "comment", pattern: /\/\*[\s\S]*?\*\//},
    { kind: "comment", pattern: /\/\/[^\n]*/ },
    { kind: "keyword", pattern: /@[A-Za-z-]+/ },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/ },
    // A hex colour reads better as a constant than as a number with a hash.
    { kind: "constant", pattern: /#[0-9a-fA-F]{3,8}\b/ },
    { kind: "number", pattern: /\b-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch|ex|pt|cm|mm|in)?\b/ },
    { kind: "attribute", pattern: /([-A-Za-z]+)\s*(?=:)/, group: 1 },
    { kind: "tag", pattern: /[.#][A-Za-z_][\w-]*/ },
    { kind: "function", pattern: /\b([A-Za-z-]+)\s*(?=\()/, group: 1 },
    { kind: "variable", pattern: /\$[A-Za-z_][\w-]*|--[A-Za-z_][\w-]*/ },
    { kind: "punctuation", pattern: /[{}();:,]/ },
  ],
}

const sql: Grammar = {
  name: "sql",
  aliases: ["postgres", "postgresql", "mysql", "sqlite"],
  extensions: [".sql"],
  // SQL keywords are conventionally upper case but valid in any case, so the
  // keyword patterns are built case-insensitively below.
  caseSensitive: false,
  rules: [
    { kind: "comment", pattern: /--[^\n]*/ },
    { kind: "comment", pattern: /\/\*[\s\S]*?\*\// },
    { kind: "string", pattern: /'(?:[^']|'')*'/ },
    // Double quotes are identifiers in SQL, not strings, which is the opposite
    // of most languages and worth colouring differently.
    { kind: "variable", pattern: /"(?:[^"]|"")*"/ },
    { kind: "keyword", pattern: new RegExp("\\b(?:" + SQL_KEYWORDS.join("|") + ")\\b", "i") },
    { kind: "type", pattern: /\b(?:INT|INTEGER|BIGINT|SMALLINT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|CHAR|VARCHAR|TEXT|DATE|TIME|TIMESTAMP|BOOLEAN|BLOB|JSON|JSONB|UUID|SERIAL)\b/i },
    { kind: "number", pattern: /\b\d+(?:\.\d+)?\b/ },
    { kind: "operator", pattern: /[=<>!+\-*/%|]+/ },
    { kind: "punctuation", pattern: /[(),;.]/ },
  ],
}

const java: Grammar = {
  name: "java",
  aliases: ["kotlin", "kt", "scala", "groovy"],
  extensions: [".java", ".kt", ".kts", ".scala", ".groovy"],
  rules: [
    ...C_COMMENTS,
    { kind: "string", pattern: /"""[\s\S]*?"""/ },
    ...C_STRINGS,
    { kind: "function", pattern: /@[A-Za-z_]\w*/ },
    { kind: "constant", pattern: /\b(?:true|false|null)\b/ },
    { kind: "keyword", pattern: words([...JAVA_KEYWORDS, "fun", "val", "when", "object", "companion", "suspend", "data", "lateinit", "init"]) },
    { kind: "type", pattern: words(JAVA_TYPES) },
    ...C_NUMBERS,
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const c: Grammar = {
  name: "c",
  aliases: ["cpp", "c++", "cc", "h", "hpp", "objc"],
  extensions: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".m", ".mm"],
  rules: [
    ...C_COMMENTS,
    // Preprocessor directives, which are not part of the language proper and
    // read better in the keyword colour than parsed as expressions.
    { kind: "keyword", pattern: /^\s*#\s*\w+/m },
    ...C_STRINGS,
    { kind: "constant", pattern: /\b(?:true|false|NULL|nullptr)\b/ },
    {
      kind: "keyword",
      pattern: words([
        "alignas", "alignof", "auto", "break", "case", "catch", "class", "const",
        "constexpr", "continue", "decltype", "default", "delete", "do", "else",
        "enum", "explicit", "extern", "final", "for", "friend", "goto", "if",
        "inline", "mutable", "namespace", "new", "noexcept", "operator",
        "override", "private", "protected", "public", "register", "return",
        "sizeof", "static", "struct", "switch", "template", "this", "throw",
        "try", "typedef", "typename", "union", "using", "virtual", "volatile",
        "while",
      ]),
    },
    {
      kind: "type",
      pattern: words([
        "bool", "char", "double", "float", "int", "long", "short", "signed",
        "unsigned", "void", "size_t", "ssize_t", "uint8_t", "uint16_t",
        "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t",
        "wchar_t", "string", "vector", "map",
      ]),
    },
    ...C_NUMBERS,
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "constant", pattern: /\b[A-Z][A-Z0-9_]{2,}\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const ruby: Grammar = {
  name: "ruby",
  aliases: ["rb", "gemfile", "rakefile"],
  extensions: [".rb", ".rake", ".gemspec"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    { kind: "comment", pattern: /^=begin[\s\S]*?^=end/m },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"/ },
    { kind: "string", pattern: /'(?:[^'\\]|\\.)*'/ },
    { kind: "string", pattern: /%[wWiI]?[[({][^\])}]*[\])}]/ },
    // Symbols, which are pervasive and deserve their own colour.
    { kind: "constant", pattern: /:[A-Za-z_]\w*[?!]?/ },
    { kind: "variable", pattern: /@@?[A-Za-z_]\w*|\$[A-Za-z_]\w*/ },
    { kind: "constant", pattern: /\b(?:true|false|nil|__FILE__|__LINE__)\b/ },
    { kind: "keyword", pattern: words(RUBY_KEYWORDS) },
    { kind: "number", pattern: /\b\d[\d_]*(?:\.\d+)?\b/ },
    { kind: "function", pattern: /\bdef\s+([A-Za-z_][\w.]*[?!=]?)/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    { kind: "operator", pattern: /[+\-*/%=<>!&|^~?:]+/ },
    { kind: "punctuation", pattern: /[{}()[\],;.]/ },
  ],
}

const csharp: Grammar = {
  name: "csharp",
  aliases: ["cs", "c#"],
  extensions: [".cs"],
  rules: [
    ...C_COMMENTS,
    { kind: "string", pattern: /\$?@"(?:[^"]|"")*"/ },
    ...C_STRINGS,
    { kind: "keyword", pattern: /^\s*#\s*\w+/m },
    { kind: "function", pattern: /\[[A-Za-z_]\w*(?:\([^)]*\))?\]/ },
    { kind: "constant", pattern: /\b(?:true|false|null)\b/ },
    { kind: "keyword", pattern: words(CSHARP_KEYWORDS) },
    { kind: "type", pattern: words(["bool", "byte", "char", "decimal", "double", "float", "int", "long", "object", "sbyte", "short", "string", "uint", "ulong", "ushort", "dynamic", "Task", "List", "Dictionary", "IEnumerable"]) },
    ...C_NUMBERS,
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

const php: Grammar = {
  name: "php",
  aliases: [],
  extensions: [".php", ".phtml"],
  rules: [
    ...C_COMMENTS,
    { kind: "comment", pattern: /#[^\n]*/ },
    { kind: "keyword", pattern: /<\?php|\?>|<\?=/ },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"/ },
    { kind: "string", pattern: /'(?:[^'\\]|\\.)*'/ },
    // Variables always carry a sigil, which makes them unambiguous here in a
    // way they are not in most languages.
    { kind: "variable", pattern: /\$[A-Za-z_]\w*/ },
    { kind: "constant", pattern: /\b(?:true|false|null|TRUE|FALSE|NULL)\b/ },
    { kind: "keyword", pattern: words(PHP_KEYWORDS) },
    { kind: "type", pattern: words(["int", "float", "string", "bool", "array", "object", "mixed", "void", "iterable", "never", "self", "parent", "static"]) },
    ...C_NUMBERS,
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
  ],
}

const toml: Grammar = {
  name: "toml",
  aliases: ["ini", "conf", "cfg", "properties", "editorconfig"],
  extensions: [".toml", ".ini", ".conf", ".cfg", ".properties"],
  rules: [
    { kind: "comment", pattern: /[#;][^\n]*/ },
    { kind: "tag", pattern: /^\s*\[\[?[^\]]+\]\]?/m },
    { kind: "attribute", pattern: /^\s*([A-Za-z_][\w.-]*)\s*(?==)/m, group: 1 },
    { kind: "string", pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''/ },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/ },
    { kind: "constant", pattern: /\b(?:true|false)\b/ },
    { kind: "number", pattern: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2})?/ },
    { kind: "number", pattern: /\b-?\d[\d_]*(?:\.\d+)?\b/ },
    { kind: "punctuation", pattern: /[=[\]{},.]/ },
  ],
}

const diff: Grammar = {
  name: "diff",
  aliases: ["patch", "udiff"],
  extensions: [".diff", ".patch"],
  rules: [
    // Headers before the +/- rules, or `+++` is coloured as an addition.
    { kind: "keyword", pattern: /^(?:diff|index|---|\+\+\+|@@).*$/m },
    { kind: "function", pattern: /^\+.*$/m },
    { kind: "comment", pattern: /^-.*$/m },
    { kind: "variable", pattern: /^ .*$/m },
  ],
}

const dockerfile: Grammar = {
  name: "dockerfile",
  aliases: ["docker", "containerfile"],
  extensions: [".dockerfile"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    {
      kind: "keyword",
      pattern: /^\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/im,
    },
    { kind: "string", pattern: /"(?:[^"\\]|\\.)*"|'[^']*'/ },
    { kind: "variable", pattern: /\$\{?[A-Za-z_]\w*\}?/ },
    { kind: "attribute", pattern: /(?:^|\s)(--[A-Za-z][\w-]*)/, group: 1 },
    { kind: "operator", pattern: /\bAS\b/i },
  ],
}

const graphql: Grammar = {
  name: "graphql",
  aliases: ["gql"],
  extensions: [".graphql", ".gql"],
  rules: [
    { kind: "comment", pattern: /#[^\n]*/ },
    { kind: "string", pattern: /"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"/ },
    { kind: "keyword", pattern: words(["query", "mutation", "subscription", "fragment", "on", "type", "input", "enum", "interface", "union", "scalar", "schema", "directive", "extend", "implements"]) },
    { kind: "constant", pattern: /\b(?:true|false|null)\b/ },
    { kind: "variable", pattern: /\$[A-Za-z_]\w*/ },
    { kind: "function", pattern: /@[A-Za-z_]\w*/ },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    { kind: "number", pattern: /\b-?\d+(?:\.\d+)?\b/ },
    { kind: "punctuation", pattern: /[{}()[\]:,!|=]/ },
  ],
}

const xml: Grammar = {
  name: "xml",
  aliases: ["svg", "xsl", "plist", "pom"],
  extensions: [".xml", ".svg", ".xsl", ".plist", ".xsd"],
  rules: [
    { kind: "comment", pattern: /<!--[\s\S]*?-->/ },
    { kind: "keyword", pattern: /<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>/ },
    { kind: "tag", pattern: /<\/?([A-Za-z_][\w:.-]*)/, group: 1 },
    { kind: "attribute", pattern: /\b([A-Za-z_:][\w:.-]*)\s*(?==)/, group: 1 },
    { kind: "string", pattern: /"(?:[^"]|\\.)*"|'(?:[^']|\\.)*'/ },
    { kind: "punctuation", pattern: /[<>/=]/ },
  ],
}

const lua: Grammar = {
  name: "lua",
  aliases: [],
  extensions: [".lua"],
  rules: [
    { kind: "comment", pattern: /--\[\[[\s\S]*?\]\]/ },
    { kind: "comment", pattern: /--[^\n]*/ },
    { kind: "string", pattern: /\[\[[\s\S]*?\]\]/ },
    ...C_STRINGS,
    { kind: "constant", pattern: /\b(?:true|false|nil)\b/ },
    { kind: "keyword", pattern: words(["and", "break", "do", "else", "elseif", "end", "for", "function", "goto", "if", "in", "local", "not", "or", "repeat", "return", "then", "until", "while"]) },
    { kind: "number", pattern: /\b\d+(?:\.\d+)?\b/ },
    { kind: "function", pattern: /\bfunction\s+([A-Za-z_][\w.:]*)/, group: 1 },
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "operator", pattern: /[+\-*/%=<>#~^]+/ },
    { kind: "punctuation", pattern: /[{}()[\],;.:]/ },
  ],
}

const swift: Grammar = {
  name: "swift",
  aliases: [],
  extensions: [".swift"],
  rules: [
    ...C_COMMENTS,
    { kind: "string", pattern: /"""[\s\S]*?"""/ },
    ...C_STRINGS,
    { kind: "function", pattern: /@[A-Za-z_]\w*/ },
    { kind: "constant", pattern: /\b(?:true|false|nil)\b/ },
    { kind: "keyword", pattern: words(["associatedtype", "class", "deinit", "enum", "extension", "fileprivate", "func", "import", "init", "inout", "internal", "let", "open", "operator", "private", "protocol", "public", "rethrows", "static", "struct", "subscript", "typealias", "var", "break", "case", "continue", "default", "defer", "do", "else", "fallthrough", "for", "guard", "if", "in", "repeat", "return", "switch", "where", "while", "as", "catch", "is", "super", "self", "throw", "throws", "try", "async", "await", "actor", "some", "any", "lazy", "weak", "unowned", "mutating", "override", "final", "indirect", "convenience", "required"]) },
    { kind: "type", pattern: words(["Int", "Double", "Float", "String", "Bool", "Character", "Array", "Dictionary", "Set", "Optional", "Any", "AnyObject", "Void", "Never", "Result", "Data", "URL"]) },
    ...C_NUMBERS,
    { kind: "function", pattern: /\bfunc\s+([A-Za-z_]\w*)/, group: 1 },
    { kind: "function", pattern: /([A-Za-z_]\w*)\s*(?=\()/, group: 1 },
    { kind: "type", pattern: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ...C_OPERATORS,
    { kind: "variable", pattern: /[A-Za-z_]\w*/ },
  ],
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const GRAMMARS: readonly Grammar[] = [
  typescript,
  python,
  go,
  rust,
  json,
  yaml,
  markdown,
  shell,
  html,
  css,
  sql,
  java,
  c,
  ruby,
  csharp,
  php,
  toml,
  diff,
  dockerfile,
  graphql,
  xml,
  lua,
  swift,
]

// Built once at module load rather than searched on every lookup. Highlighting
// runs per code block on every render, and a linear scan of twenty-three
// grammars with nested alias arrays adds up quickly during a fast scroll.
const byName = new Map<string, Grammar>()
const byExtension = new Map<string, Grammar>()

for (const grammar of GRAMMARS) {
  byName.set(grammar.name, grammar)

  for (const alias of grammar.aliases) {
    // First registration wins, so an alias claimed by an earlier grammar is not
    // stolen by a later one.
    if (!byName.has(alias)) byName.set(alias, grammar)
  }

  for (const extension of grammar.extensions) {
    if (!byExtension.has(extension)) byExtension.set(extension, grammar)
  }
}

/** Finds a grammar by language name or alias. */
export function grammarForLanguage(language: string): Grammar | undefined {
  return byName.get(language.trim().toLowerCase())
}

/**
 * Finds a grammar for a file path.
 *
 * Extension-less files are checked by name, because `Dockerfile`, `Makefile`,
 * and `Gemfile` are common enough that failing to highlight them is noticeable.
 */
export function grammarForPath(path: string): Grammar | undefined {
  const name = path.split(/[/\\]/).pop() ?? path
  const lower = name.toLowerCase()

  const dot = lower.lastIndexOf(".")

  if (dot > 0) {
    const found = byExtension.get(lower.slice(dot))

    if (found) return found
  }

  return byName.get(lower)
}

/** Every language name that can be used in a fence. */
export function languageNames(): string[] {
  return [...byName.keys()].sort()
}
