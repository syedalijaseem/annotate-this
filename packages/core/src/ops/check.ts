import { safeParse } from "valibot"
import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { RegionSchema } from "../schema/annotation.js"
import type { Region } from "../types.js"
import { STRUCTURE_DEPTH_ALLOWANCE, countNodes, nestingDepth } from "../validate/depth.js"
import { geometryIssues } from "../validate/geometry-rules.js"
import { type Issue, clip, fail, issue } from "../validate/issues.js"
import { attributeIssues, classGeometryIssue } from "../validate/labels.js"
import { annotationLimitIssues, geometryWeight } from "../validate/limit-checks.js"
import { annotationRefs } from "../validate/references.js"
import { regionFrameIssue } from "../validate/video.js"
import type { OpContext } from "./context.js"

// How deep a value may nest when it sits `level` levels below the document root (root = 1).
export const depthAllowance = (limits: Limits, level: number): number =>
  limits.maxMetaDepth + STRUCTURE_DEPTH_ALLOWANCE - (level - 1)

// Document levels: doc > regions > region > geometry.
export const REGION_LEVEL = 3
export const GEOMETRY_LEVEL = 4

// Fails with LIMIT_EXCEEDED when `value` would nest deeper than the document budget allows at `level`.
export function assertDepth(value: unknown, limits: Limits, level: number, what: string): void {
  const allowed = depthAllowance(limits, level)
  if (nestingDepth(value, allowed) > allowed) {
    throw new AnnotateError("LIMIT_EXCEEDED", `${what}: nesting is too deep`)
  }
}

// Parses a region shape; `validateRegion` returns the parsed region, which is what gets stored.
export function parseRegion(input: unknown): Region {
  const parsed = safeParse(RegionSchema, input, { abortEarly: true })
  if (!parsed.success) {
    const message = clip(parsed.issues[0]?.message ?? "Invalid region")
    throw new AnnotateError("INVALID_DOCUMENT", `region: ${message}`)
  }
  return parsed.output
}

// Work units for re-validating a region: its vertices plus the values that get walked.
function regionCost(region: Region): number {
  const { geometry } = region
  const data = geometry.type === "custom" ? countNodes(geometry.data) : 0
  return (
    1 +
    geometryWeight(geometry) +
    data +
    countNodes(region.meta) +
    region.tagIds.length +
    Object.keys(region.attributes).length
  )
}

// shapeRules only checks keypoints against a skeleton that exists; the reference itself is checked here.
function skeletonIssue(ctx: OpContext, at: string, region: Region): Issue[] {
  const { geometry } = region
  if (geometry.type !== "keypoints") return []
  if (Object.hasOwn(ctx.draft.view.config.skeletons, geometry.skeletonId)) return []
  return [
    issue(
      "INVALID_DOCUMENT",
      `${at}.geometry.skeletonId`,
      `Unknown skeleton "${clip(geometry.skeletonId)}"`,
    ),
  ]
}

// Entity-level validation for one region against the working document: the
// same rules as whole-document validation restricted to what an operation can
// have changed (Spec 0002, "Validation levels per operation").
export function assertRegionRules(ctx: OpContext, region: Region): void {
  ctx.charge(regionCost(region))
  const doc = ctx.draft.view
  const { limits } = ctx
  const at = `regions.${region.id}`
  const issues = [
    ...annotationRefs(doc, "regions", region.id, region),
    ...skeletonIssue(ctx, at, region),
    ...attributeIssues(doc, `${at}.attributes`, region.attributes),
    ...classGeometryIssue(doc, at, region.classId, region.geometry.type),
    ...geometryIssues(region.geometry, `${at}.geometry`, region.sourceId, doc, limits),
    ...regionFrameIssue(doc, region.id, region),
    ...annotationLimitIssues("regions", region, limits),
  ]
  if (issues.length > 0) fail(issues)
}

export function validateRegion(ctx: OpContext, input: unknown): Region {
  const region = parseRegion(input)
  assertRegionRules(ctx, region)
  return region
}
