import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { safeParse } from "valibot"
import { RegionSchema } from "../schema/annotation.js"
import type { AnnotationDocument, Region } from "../types.js"
import { geometryIssues } from "../validate/geometry-rules.js"
import { type Issue, clip } from "../validate/issues.js"
import { attributeIssues, classGeometryIssue } from "../validate/labels.js"
import { annotationLimitIssues } from "../validate/limit-checks.js"
import { annotationRefs } from "../validate/references.js"
import { regionFrameIssue } from "../validate/video.js"

const MAX_REPORTED = 25

export function fail(issues: readonly Issue[]): never {
  const first = issues[0] as Issue
  const extra = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""
  throw new AnnotateError(first.code, `${first.path}: ${first.message}${extra}`, {
    issues: issues.slice(0, MAX_REPORTED).map(({ path, message }) => ({ path, message })),
  })
}

/**
 * Entity-level validation for one region against the working document: its
 * shape (schema), then the same rules as whole-document validation restricted
 * to what an operation can have changed (Spec 0002, "Validation levels per
 * operation"). `validateRegion` returns the parsed region, which is what gets stored.
 */
export function parseRegion(input: unknown): Region {
  const parsed = safeParse(RegionSchema, input, { abortEarly: true })
  if (!parsed.success) {
    const message = clip(parsed.issues[0]?.message ?? "Invalid region")
    throw new AnnotateError("INVALID_DOCUMENT", `region: ${message}`)
  }
  return parsed.output
}

/** The document-level rules for a region that already has the right shape. */
export function assertRegionRules(doc: AnnotationDocument, region: Region, limits: Limits): void {
  const at = `regions.${region.id}`
  const issues = [
    ...annotationRefs(doc, "regions", region.id, region),
    ...attributeIssues(doc, `${at}.attributes`, region.attributes),
    ...classGeometryIssue(doc, at, region.classId, region.geometry.type),
    ...geometryIssues(region.geometry, `${at}.geometry`, region.sourceId, doc, limits),
    ...regionFrameIssue(doc, region.id, region),
    ...annotationLimitIssues("regions", region, limits),
  ]
  if (issues.length > 0) fail(issues)
}

export function validateRegion(doc: AnnotationDocument, input: unknown, limits: Limits): Region {
  const region = parseRegion(input)
  assertRegionRules(doc, region, limits)
  return region
}
