import type { AnnotationDocument, Config, ID, Source } from "../types.js"

// What a value adds to the document-wide limits: `nodes` as countNodes counts
// them (Limits.maxDocumentNodes), and `bytes`, its exact UTF-8 size as compact
// JSON.stringify output (Limits.maxDocumentBytes, as parseDocumentJson checks it).
export interface Size {
  nodes: number
  bytes: number
}

export const ZERO: Size = Object.freeze({ nodes: 0, bytes: 0 })

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
const SHORT_ESCAPES: ReadonlySet<number> = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d])

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

function scalarBytes(value: unknown): number {
  if (typeof value === "string") return jsonStringBytes(value)
  if (typeof value === "number") return String(value).length
  if (value === true) return 4
  if (value === false) return 5
  // null; undefined (and anything else not JSON) is written as null inside arrays.
  return 4
}

// Commas between `count` members.
const commas = (count: number): number => (count > 0 ? count - 1 : 0)

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

// Immutable entities are measured once: they are shared between documents.
const entitySizes = new WeakMap<object, Size>()

function cached(entity: object, compute: () => Size): Size {
  let size = entitySizes.get(entity)
  if (!size) {
    size = compute()
    entitySizes.set(entity, size)
  }
  return size
}

// The record key (`"id":`) and, for entities that also sit in an ordering,
// the order entry (`"id"`), each with one comma. A record or order with n
// entries has n - 1 commas: the draft corrects for that whenever one becomes
// empty or non-empty (see EMPTY_CONTAINER_BYTES).
const keyed = (id: ID, ordered: boolean): Size => {
  const text = jsonStringBytes(id)
  return { nodes: ordered ? 2 : 1, bytes: text + 2 + (ordered ? text + 1 : 0) }
}

// What a record or order that holds entries weighs less than its entries
// (with one comma each) suggest: the comma after the last entry.
export const EMPTY_CONTAINER_BYTES = 1

// A region with its key in `regions` and its entry in the source's regionOrder.
export const regionSize = (region: { id: ID }): Size =>
  cached(region, () => plus(measure(region), keyed(region.id, true)))

// A source with its key and its sourceOrder entry. Its regionOrder entries
// belong to the regions, so a source's size does not change with its order.
export const sourceSize = (source: Source): Size =>
  cached(source, () => plus(measure({ ...source, regionOrder: [] }), keyed(source.id, true)))

// A config entry with its record key and, for classes and tags, its order entry.
export const defSize = (key: string, def: object, ordered: boolean): Size =>
  cached(def, () => plus(measure(def), keyed(key, ordered)))

// The config without its records and orders, whose entries are counted per definition.
export const configShellSize = (config: Config): Size =>
  measure({
    ...config,
    classes: {},
    tags: {},
    attributes: {},
    skeletons: {},
    classOrder: [],
    tagOrder: [],
  })

// Sizes of documents `apply` has measured or produced. Documents are immutable
// values, so a size stays true; it lets the next batch skip a full walk.
const documentSizes = new WeakMap<AnnotationDocument, Size>()

export const knownSize = (doc: AnnotationDocument): Size | undefined => documentSizes.get(doc)

export function rememberSize(doc: AnnotationDocument, size: Size): void {
  documentSizes.set(doc, size)
}

// A meta record (document meta).
export const metaSize = (meta: object): Size => cached(meta, () => measure(meta))
