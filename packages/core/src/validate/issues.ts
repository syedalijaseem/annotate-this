import { AnnotateError, type ErrorCode } from "../errors.js"
import type { AnnotationDocument, Geometry } from "../types.js"

export interface Issue {
  code: ErrorCode
  /** Dot path into the document. */
  path: string
  message: string
}

export const issue = (code: ErrorCode, path: string, message: string): Issue => ({
  code,
  path,
  message,
})

export interface GeometryVisit {
  geometry: Geometry
  path: string
  sourceId: string
}

/** Visits every geometry in the document: region geometry and track keyframe geometry. */
export function* walkGeometries(doc: AnnotationDocument): Generator<GeometryVisit> {
  for (const [id, region] of Object.entries(doc.regions)) {
    yield { geometry: region.geometry, path: `regions.${id}.geometry`, sourceId: region.sourceId }
  }
  for (const [id, track] of Object.entries(doc.tracks)) {
    for (const [i, keyframe] of track.keyframes.entries()) {
      yield {
        geometry: keyframe.geometry,
        path: `tracks.${id}.keyframes.${i}.geometry`,
        sourceId: track.sourceId,
      }
    }
  }
}

/** Shortens attacker-controlled text before it goes into a message. */
export function clip(text: string, max = 64): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Appends without spreading: `push(...items)` overflows the call stack for very large arrays. */
export function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item)
}

/** Checks stop collecting after this many issues: only the first few are ever reported. */
export const MAX_ISSUES_PER_CHECK = 100

/** Own-property lookup: names like "toString" must never resolve through Object.prototype. */
export function own<V>(record: Record<string, V>, key: string): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

const MAX_REPORTED_ISSUES = 25

/** Paths and messages can quote the input, so they are cut to this length. */
const MAX_TEXT = 200

/** Throws the first issue's code, with the first few issues attached (clipped: they can quote input). */
export function fail(issues: readonly Issue[]): never {
  const first = issues[0] as Issue
  const extra = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""
  const summary = clip(`${first.path}: ${first.message}`, MAX_TEXT)
  throw new AnnotateError(first.code, `${summary}${extra}`, {
    issues: issues.slice(0, MAX_REPORTED_ISSUES).map(({ path, message }) => ({
      path: clip(path, MAX_TEXT),
      message: clip(message, MAX_TEXT),
    })),
  })
}
