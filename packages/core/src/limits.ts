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
   * Maximum work units one `apply` batch may spend. Each step is charged by
   * its measured cost at about 40 ns of engine time per unit, so the default
   * bounds a batch to roughly 2 s on a current laptop: for example one unit per
   * ordering entry compared or payload value copied, 16 per free-form record
   * key, 16 per parent-chain step and 32 per annotation a whole-document scan
   * visits. Bounds the total cost of a hostile or accidental batch (for
   * example 50,000 reorders of a 50,000-region source).
   */
  maxBatchWork: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
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

export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides }
}
