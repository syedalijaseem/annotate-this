import { AnnotateError } from "./errors.js"

/** Resource limits (Spec 0001, invariant 9). All are configurable; exceeding one raises LIMIT_EXCEEDED. */
export interface Limits {
  /** Maximum number of regions plus tracks. */
  maxAnnotations: number
  /** Maximum vertices across the whole document (polygon/polyline points, keypoints, keyframe geometry). */
  maxTotalVertices: number
  /** Maximum vertices in a single ring, polyline or keypoint set. */
  maxVerticesPerShape: number
  /** Maximum length of names, URIs and other short text. */
  maxStringLength: number
  /** Maximum length of comments and the task description. */
  maxCommentLength: number
  /** Maximum nesting depth of `meta` JSON. */
  maxMetaDepth: number
  /**
   * Maximum serialized document size in bytes: the UTF-8 size of the JSON text
   * for parseDocumentJson, and the exact compact `JSON.stringify` size of every
   * document `apply` returns.
   */
  maxDocumentBytes: number
  /** Maximum decoded pixels of any single mask. */
  maxMaskPixels: number
  /**
   * Maximum operations in one batch, and so in the inverse `apply` returns (an
   * operation whose undo would need more fails with LIMIT_EXCEEDED). Bulk
   * operations (`createRegions`, `deleteRegions`) restore or remove any number
   * of regions in one operation, so large deletes stay undoable; they are still
   * bounded by maxAnnotations, maxDocumentNodes, maxDocumentBytes and maxBatchWork.
   */
  maxBatchOps: number
  /** Maximum values in the whole input (strings, booleans, null, objects, arrays and keys; plain numbers are free). */
  maxDocumentNodes: number
  /** Maximum keys in any one object, and so the largest record the document can hold. */
  maxEntries: number
  /**
   * Maximum work units one `apply` batch may spend, which bounds the time a
   * hostile or accidental batch can take. Every step is charged by its
   * measured cost, aiming at 40 ns of engine time per unit: measured on a
   * current laptop (Node 24), the primitives cost between 12 and 52 ns per
   * unit (for example 250 units per operation, 200 per new region, 16 per
   * annotation a whole-document scan visits, 16 per key of a copied record,
   * 8 per parent-chain step, 1 per 8 ordering entries compared). The default
   * therefore stops any batch after roughly 0.6 to 2.6 s, and about 2 s for
   * typical worst cases; legitimate large batches (pasting 50,000 regions,
   * 5,000 reorders on a 20,000-region source) fit well inside it.
   */
  maxBatchWork: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = /* @__PURE__ */ Object.freeze({
  maxAnnotations: 50_000,
  maxTotalVertices: 2_000_000,
  maxVerticesPerShape: 100_000,
  maxStringLength: 10_000,
  maxCommentLength: 100_000,
  maxMetaDepth: 32,
  maxDocumentBytes: 64 * 1024 * 1024,
  maxMaskPixels: 268_435_456,
  maxBatchOps: 50_000,
  maxDocumentNodes: 3_000_000,
  maxEntries: 100_000,
  maxBatchWork: 50_000_000,
})

const LIMIT_KEYS = /* @__PURE__ */ Object.freeze(
  /* @__PURE__ */ Object.keys(DEFAULT_LIMITS) as (keyof Limits)[],
)

const invalidLimits = (message: string): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", `limits: ${message}`)

// Each own override is read once; a limit that is not a whole number would
// silently switch its check off (every check is `value > limit`).
function readOverride(overrides: object, key: keyof Limits): number | undefined {
  if (!Object.hasOwn(overrides, key)) return undefined
  const value: unknown = (overrides as Record<string, unknown>)[key]
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidLimits(`${key} must be a non-negative whole number`)
  }
  return value
}

/**
 * The defaults with `overrides` applied. Only own keys of `Limits` are read;
 * keys set to `undefined` keep their default. Every override must be a
 * non-negative safe integer (there is no "unlimited": pass a large number),
 * otherwise this throws an AnnotateError (INVALID_DOCUMENT) naming the limit.
 * The result is frozen.
 */
export function resolveLimits(overrides: Partial<Limits> = {}): Readonly<Limits> {
  if (typeof overrides !== "object" || overrides === null) {
    throw invalidLimits("expected an object")
  }
  const limits: Limits = { ...DEFAULT_LIMITS }
  for (const key of LIMIT_KEYS) {
    let value: number | undefined
    try {
      value = readOverride(overrides, key)
    } catch (error) {
      if (error instanceof AnnotateError) throw error
      throw invalidLimits(`${key} could not be read`)
    }
    if (value !== undefined) limits[key] = value
  }
  return Object.freeze(limits)
}
