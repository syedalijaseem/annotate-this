import type { ErrorCode } from "../errors.js"
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
  /** Set when the geometry belongs to a track keyframe. */
  trackId?: string
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
        trackId: id,
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
