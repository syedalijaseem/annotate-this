import type { AnnotationDocument, Config, ID, Source } from "../types.js"
import { type Size, jsonStringBytes, measure, plus } from "../validate/json-size.js"

export { type Size, ZERO, jsonStringBytes, measure, minus, plus } from "../validate/json-size.js"

// Immutable entities are measured once: they are shared between documents.
const entitySizes = /* @__PURE__ */ new WeakMap<object, Size>()

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
const documentSizes = /* @__PURE__ */ new WeakMap<AnnotationDocument, Size>()

export const knownSize = (doc: AnnotationDocument): Size | undefined => documentSizes.get(doc)

export function rememberSize(doc: AnnotationDocument, size: Size): void {
  documentSizes.set(doc, size)
}

// A meta record (document meta).
export const metaSize = (meta: object): Size => cached(meta, () => measure(meta))
