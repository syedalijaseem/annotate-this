import type { Geometry } from "../types.js"

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Extends `bounds` with a point, returning a new object (inputs are never mutated). */
function include(bounds: Bounds | null, x: number, y: number): Bounds {
  if (bounds === null) return { minX: x, minY: y, maxX: x, maxY: y }
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y),
  }
}

function flatBounds(
  coordinates: readonly number[],
  stride: number,
  include2d: (index: number) => boolean,
): Bounds | null {
  let bounds: Bounds | null = null
  for (let i = 0; i + 1 < coordinates.length; i += stride) {
    if (!include2d(i)) continue
    bounds = include(bounds, coordinates[i] as number, coordinates[i + 1] as number)
  }
  return bounds
}

function rotatedBoxBounds(cx: number, cy: number, w: number, h: number, angle: number): Bounds {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const halfW = w / 2
  const halfH = h / 2
  let bounds: Bounds | null = null
  for (const [dx, dy] of [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ] as const) {
    bounds = include(bounds, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
  }
  return bounds as Bounds
}

/**
 * Axis-aligned bounds of a geometry in image pixels, or null when it has no
 * spatial extent the core understands (custom geometry, or keypoints that are all unlabeled).
 */
export function geometryBounds(geometry: Geometry): Bounds | null {
  switch (geometry.type) {
    case "box":
      return {
        minX: geometry.x,
        minY: geometry.y,
        maxX: geometry.x + geometry.w,
        maxY: geometry.y + geometry.h,
      }
    case "rotatedBox":
      return rotatedBoxBounds(geometry.cx, geometry.cy, geometry.w, geometry.h, geometry.angle)
    case "point":
      return { minX: geometry.x, minY: geometry.y, maxX: geometry.x, maxY: geometry.y }
    case "polygon": {
      let bounds: Bounds | null = null
      for (const ring of geometry.rings) {
        const ringBounds = flatBounds(ring, 2, () => true)
        if (ringBounds)
          bounds = include(
            include(bounds, ringBounds.minX, ringBounds.minY),
            ringBounds.maxX,
            ringBounds.maxY,
          )
      }
      return bounds
    }
    case "polyline":
      return flatBounds(geometry.points, 2, () => true)
    case "keypoints":
      // Unlabeled keypoints (v = 0) carry placeholder coordinates and have no position.
      return flatBounds(geometry.points, 3, (i) => geometry.points[i + 2] !== 0)
    case "mask":
      return {
        minX: geometry.x,
        minY: geometry.y,
        maxX: geometry.x + geometry.width,
        maxY: geometry.y + geometry.height,
      }
    case "custom":
      return null
  }
}

/** True when `inner` lies within `outer`, allowing `tolerance` pixels of slack. */
export function boundsWithin(inner: Bounds, outer: Bounds, tolerance = 0): boolean {
  return (
    inner.minX >= outer.minX - tolerance &&
    inner.minY >= outer.minY - tolerance &&
    inner.maxX <= outer.maxX + tolerance &&
    inner.maxY <= outer.maxY + tolerance
  )
}

/** Number of vertices a geometry contributes toward the document vertex limits. */
export function vertexCount(geometry: Geometry): number {
  switch (geometry.type) {
    case "polygon":
      return geometry.rings.reduce((total, ring) => total + ring.length / 2, 0)
    case "polyline":
      return geometry.points.length / 2
    case "keypoints":
      return geometry.points.length / 3
    default:
      return 1
  }
}

/** Largest vertex count in a single ring or run, which is what the per-shape limit caps. */
export function largestRun(geometry: Geometry): number {
  if (geometry.type === "polygon") {
    return geometry.rings.reduce((most, ring) => Math.max(most, ring.length / 2), 0)
  }
  return vertexCount(geometry)
}
