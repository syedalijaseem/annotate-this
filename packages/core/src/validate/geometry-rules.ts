import { type Bounds, boundsWithin, geometryBounds } from "../geometry/bounds.js"
import type { Limits } from "../limits.js"
import type { AnnotationDocument, BoxGeometry, Geometry, Source } from "../types.js"
import { type Issue, issue, own, pushAll, walkGeometries } from "./issues.js"

/** Slack for coordinates that land a rounding error outside the image. */
const BOUNDS_TOLERANCE = 0.5

function boxBounds(box: BoxGeometry): Bounds {
  return { minX: box.x, minY: box.y, maxX: box.x + box.w, maxY: box.y + box.h }
}

function shapeRules(
  geometry: Geometry,
  path: string,
  doc: AnnotationDocument,
  limits: Limits,
): Issue[] {
  if (geometry.type === "keypoints") {
    const skeleton = own(doc.config.skeletons, geometry.skeletonId)
    if (skeleton && geometry.points.length !== skeleton.points.length * 3) {
      return [
        issue(
          "INVALID_GEOMETRY",
          path,
          `Keypoints need ${skeleton.points.length} points for skeleton "${skeleton.id}"`,
        ),
      ]
    }
  }
  if (geometry.type === "mask") {
    if (geometry.width * geometry.height > limits.maxMaskPixels) {
      return [issue("LIMIT_EXCEEDED", path, `Mask has more than ${limits.maxMaskPixels} pixels`)]
    }
    let total = 0
    for (const run of geometry.counts) total += run
    if (total !== geometry.width * geometry.height) {
      return [issue("INVALID_GEOMETRY", path, "Mask run lengths must sum to width * height")]
    }
  }
  return []
}

/** Geometry must lie within its source and within `area` (the allowed area that applies), if any. */
export function areaIssues(
  geometry: Geometry,
  path: string,
  source: Source,
  area: BoxGeometry | undefined,
): Issue[] {
  const bounds = geometryBounds(geometry)
  if (!bounds) return []
  const image: Bounds = { minX: 0, minY: 0, maxX: source.width, maxY: source.height }
  if (!boundsWithin(bounds, image, BOUNDS_TOLERANCE)) {
    return [
      issue(
        "OUT_OF_BOUNDS",
        path,
        `Geometry extends outside the ${source.width}x${source.height} source`,
      ),
    ]
  }
  if (area && !boundsWithin(bounds, boxBounds(area), BOUNDS_TOLERANCE)) {
    return [issue("OUT_OF_BOUNDS", path, "Geometry extends outside the allowed area")]
  }
  return []
}

function areaRules(
  geometry: Geometry,
  path: string,
  sourceId: string,
  doc: AnnotationDocument,
): Issue[] {
  const source = own(doc.sources, sourceId)
  return source
    ? areaIssues(geometry, path, source, source.allowedArea ?? doc.config.allowedArea)
    : []
}

/** Shape and area rules for one geometry. */
export function geometryIssues(
  geometry: Geometry,
  path: string,
  sourceId: string,
  doc: AnnotationDocument,
  limits: Limits,
): Issue[] {
  return [...shapeRules(geometry, path, doc, limits), ...areaRules(geometry, path, sourceId, doc)]
}

export function checkGeometryRules(doc: AnnotationDocument, limits: Limits): Issue[] {
  const issues: Issue[] = []
  for (const { geometry, path, sourceId } of walkGeometries(doc)) {
    pushAll(issues, geometryIssues(geometry, path, sourceId, doc, limits))
  }
  return issues
}
