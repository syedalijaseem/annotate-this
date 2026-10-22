import { expect } from "vitest"
import { isAnnotateError } from "../src/errors.js"
import type { ErrorCode } from "../src/errors.js"
import { apply } from "../src/ops/apply.js"
import type { ApplyBatchOptions, ApplyResult, Batch } from "../src/ops/types.js"
import type { AnnotationDocument } from "../src/types.js"
import { parseDocument } from "../src/validate/index.js"
import { type Loose, box, clone, validDocument, validVideoDocument } from "./fixtures.js"

export const AT = "2026-10-21T12:00:00Z"

/** Small deterministic PRNG (mulberry32), so a failing seed can be replayed. */
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let counter = 0
export const opId = (): string => `t${++counter}`

export const batchOf = (ops: unknown[]): Batch =>
  ({ id: `tb${++counter}`, origin: "local", at: AT, ops }) as Batch

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Applies ops as one batch to a deep-frozen copy, which also proves the input is never mutated. */
export const run = (
  doc: AnnotationDocument,
  ops: unknown[],
  options?: ApplyBatchOptions,
): ApplyResult => apply(deepFreeze(clone(doc)), batchOf(ops), options)

export function errorOf(fn: () => unknown) {
  try {
    fn()
  } catch (error) {
    if (!isAnnotateError(error)) throw error
    return error
  }
  throw new Error("expected an AnnotateError")
}

export const codeOf = (fn: () => unknown): ErrorCode => errorOf(fn).code

// An entity's own rev and provenance.updatedAt; meta keys that happen to be
// named "rev" or "updatedAt" are content and are kept.
function withoutRevs<T extends object>(entity: T): T {
  const copy = { ...entity } as Record<string, unknown>
  delete copy["rev"]
  if (typeof copy["provenance"] === "object" && copy["provenance"] !== null) {
    const provenance: Record<string, unknown> = { ...copy["provenance"] }
    delete provenance["updatedAt"]
    copy["provenance"] = provenance
  }
  return copy as T
}

const mapRecord = <V extends object>(record: Record<string, V>): Record<string, V> =>
  Object.fromEntries(Object.entries(record).map(([id, entity]) => [id, withoutRevs(entity)]))

/**
 * Drops fields an undo is allowed to change: the rev of the document, the
 * config and every entity, and provenance.updatedAt. Only those entity
 * fields: free-form content keeps keys of the same name.
 */
export function stable(doc: AnnotationDocument): unknown {
  const { config } = doc
  return JSON.parse(
    JSON.stringify({
      ...withoutRevs(doc),
      config: withoutRevs(config),
      sources: mapRecord(doc.sources),
      regions: mapRecord(doc.regions),
      tracks: mapRecord(doc.tracks),
    }),
  ) as unknown
}

/** Wire round trip, as an integrator would persist and reload the result. */
export const reload = (doc: AnnotationDocument): AnnotationDocument =>
  parseDocument(JSON.parse(JSON.stringify(doc)))

/**
 * Applies `ops`, checks the result passes full validation, that the inverse
 * restores `doc` and that redo (the inverse of the inverse) restores the result.
 */
export function roundTrip(
  doc: AnnotationDocument,
  ops: unknown[],
  options?: ApplyBatchOptions,
): ApplyResult {
  const result = run(doc, ops, options)
  expect(result.doc).not.toBe(doc)
  reload(result.doc)
  const undone = run(result.doc, result.inverse, options)
  expect(stable(undone.doc)).toEqual(stable(doc))
  reload(undone.doc)
  const redone = run(undone.doc, undone.inverse, options)
  expect(stable(redone.doc)).toEqual(stable(result.doc))
  return result
}

export const nest = (depth: number, leaf: unknown = 1): unknown => {
  let value = leaf
  for (let i = 0; i < depth; i++) value = { k: value }
  return value
}

/**
 * validDocument() plus: class c2 (child of c1, lists "score"), tag t2, a
 * labelled source and r2 classified as c2.
 */
export function richDocument(): AnnotationDocument {
  const doc: Loose = clone(validDocument())
  doc.config.classes.c2 = {
    id: "c2",
    name: "Beta",
    parentId: "c1",
    attributeKeys: ["score"],
    meta: {},
  }
  doc.config.classOrder = ["c1", "c2"]
  doc.config.tags.t2 = { id: "t2", name: "dark", meta: {} }
  doc.config.tagOrder = ["t1", "t2"]
  doc.sources.s1.classId = "c1"
  doc.sources.s1.tagIds = ["t1"]
  doc.sources.s1.attributes = { score: 0.2 }
  doc.regions.r2.classId = "c2"
  doc.sources.s2 = { ...clone(doc.sources.s1), id: "s2", name: "b.jpg", regionOrder: [] }
  delete doc.sources.s2.classId
  doc.sources.s2.tagIds = []
  doc.sources.s2.attributes = {}
  doc.sourceOrder = ["s1", "s2"]
  return parseDocument(doc)
}

/** validVideoDocument() with the track labelled: class c1, tag t1, attribute score. */
export function videoDocument(): AnnotationDocument {
  const doc: Loose = clone(validVideoDocument())
  doc.tracks.tr1.classId = "c1"
  doc.tracks.tr1.tagIds = ["t1"]
  doc.tracks.tr1.attributes = { score: 0.7 }
  return parseDocument(doc)
}

/**
 * validDocument() with `n` small boxes m0..m(n-1) in s1, bottom to top, and
 * no other regions. `parentOf(i)` makes region i a child of region parentOf(i).
 * Not parsed: callers that build 50,000 regions pass it to `apply` directly.
 */
export function manyRegions(
  n: number,
  parentOf?: (i: number) => number | undefined,
): AnnotationDocument {
  const doc: Loose = clone(validDocument())
  doc.regions = {}
  doc.sources.s1.regionOrder = []
  for (let i = 0; i < n; i++) {
    const region: Loose = { ...box(`m${i}`, "s1", 10, 10, 20, 20) }
    const parent = parentOf?.(i)
    if (parent !== undefined) region.parentId = `m${parent}`
    doc.regions[`m${i}`] = region
    doc.sources.s1.regionOrder.push(`m${i}`)
  }
  return doc as AnnotationDocument
}
