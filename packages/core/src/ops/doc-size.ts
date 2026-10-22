import type { AnnotationDocument, Config, ID, Source } from "../types.js"

// What a value adds to the document-wide limits: `nodes` as countNodes counts
// them (Limits.maxDocumentNodes), and `bytes`, a lower bound of its compact
// JSON size (Limits.maxDocumentBytes): a string or key takes its length plus
// quotes (and a colon), a container its brackets, null or a boolean 4, a number 1.
// UTF-16 length never exceeds the UTF-8 size, so the bound holds for any text.
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

function scalarBytes(value: unknown): number {
  if (typeof value === "string") return value.length + 2
  return typeof value === "number" ? 1 : 4
}

// Iterative, so deep values cannot overflow the stack; primitives are never
// queued. Callers charge the returned `nodes` as work.
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
    size.bytes += 2
    if (Array.isArray(current)) {
      for (const child of current as unknown[]) visit(child)
      continue
    }
    for (const key of Object.keys(current)) {
      size.nodes += 1
      size.bytes += key.length + 3
      visit((current as Record<string, unknown>)[key])
    }
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

// A record key (`"id":`) plus, for entities that also sit in an ordering, the order entry (`"id"`).
const keyed = (id: ID, ordered: boolean): Size => ({
  nodes: ordered ? 2 : 1,
  bytes: id.length + 3 + (ordered ? id.length + 2 : 0),
})

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
