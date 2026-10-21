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
  /** Maximum serialized document size in bytes (checked on JSON text input). */
  maxDocumentBytes: number
  /** Maximum decoded pixels of any single mask. */
  maxMaskPixels: number
  /** Maximum operations in one batch. */
  maxBatchOps: number
  /** Maximum values in the whole input (strings, booleans, null, objects, arrays and keys; plain numbers are free). */
  maxDocumentNodes: number
  /** Maximum keys in any one object, and so the largest record the document can hold. */
  maxEntries: number
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
})

export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  return { ...DEFAULT_LIMITS, ...overrides }
}
