// Exact sizes of JSON values, shared by parseDocument (Limits.maxDocumentBytes
// on object input) and apply's size meter.

// What a value adds to the document-wide limits: `nodes` as countNodes counts
// them (Limits.maxDocumentNodes), and `bytes`, its exact UTF-8 size as compact
// JSON.stringify output (Limits.maxDocumentBytes, as parseDocumentJson checks it).
export interface Size {
  nodes: number
  bytes: number
}

export const ZERO: Size = /* @__PURE__ */ Object.freeze({ nodes: 0, bytes: 0 })

export const plus = (a: Size, b: Size): Size => ({
  nodes: a.nodes + b.nodes,
  bytes: a.bytes + b.bytes,
})

export const minus = (a: Size, b: Size): Size => ({
  nodes: a.nodes - b.nodes,
  bytes: a.bytes - b.bytes,
})

// Characters JSON.stringify writes as one byte, unescaped.
const PLAIN_ASCII = /^[\x20\x21\x23-\x5b\x5d-\x7f]*$/
// \b \t \n \f \r; other control characters become \u00XX.
const SHORT_ESCAPES: ReadonlySet<number> = /* @__PURE__ */ new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

function charBytes(code: number): number {
  if (code < 0x20) return SHORT_ESCAPES.has(code) ? 2 : 6
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  // A lone surrogate is written as \uXXXX (well-formed JSON.stringify).
  return isHigh(code) || isLow(code) ? 6 : 3
}

// Exact UTF-8 size of `text` as JSON.stringify writes it, quotes included.
export function jsonStringBytes(text: string): number {
  if (PLAIN_ASCII.test(text)) return text.length + 2
  let bytes = 2
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isHigh(code) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) {
      bytes += 4
      i += 1
    } else bytes += charBytes(code)
  }
  return bytes
}

export function scalarBytes(value: unknown): number {
  if (typeof value === "string") return jsonStringBytes(value)
  if (typeof value === "number") return String(value).length
  if (value === true) return 4
  if (value === false) return 5
  // null; undefined (and anything else not JSON) is written as null inside arrays.
  return 4
}

// Commas between `count` members.
export const commas = (count: number): number => (count > 0 ? count - 1 : 0)

// The longest text JSON.stringify writes for a finite number ("-1.7976931348623157e+308").
export const MAX_NUMBER_BYTES = 24

// Iterative, so deep values cannot overflow the stack; primitives are never
// queued. Object members whose value is undefined are left out of `bytes`, as
// JSON.stringify leaves them out (countNodes still counts them).
export function measure(value: unknown): Size {
  // Local accumulators, filled in place while walking.
  const size = { nodes: 0, bytes: 0 }
  const stack: object[] = []
  const visit = (child: unknown): void => {
    if (typeof child === "object" && child !== null) {
      stack.push(child)
      return
    }
    if (typeof child !== "number") size.nodes += 1
    size.bytes += scalarBytes(child)
  }
  visit(value)
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    size.nodes += 1
    if (Array.isArray(current)) {
      size.bytes += 2 + commas(current.length)
      for (const child of current as unknown[]) visit(child)
      continue
    }
    let members = 0
    for (const key of Object.keys(current)) {
      const child = (current as Record<string, unknown>)[key]
      size.nodes += 1
      if (child === undefined) {
        size.nodes += 1
        continue
      }
      members += 1
      size.bytes += jsonStringBytes(key) + 1
      visit(child)
    }
    size.bytes += 2 + commas(members)
  }
  return size
}
