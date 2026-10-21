import { largestRun, vertexCount } from "../geometry/bounds.js"
import type { Limits } from "../limits.js"
import type { AnnotationDocument, Geometry, JSONValue, Region, Track } from "../types.js"
import { nestingDepth } from "./depth.js"
import { type Issue, MAX_ISSUES_PER_CHECK, issue, walkGeometries } from "./issues.js"

/** What one geometry counts against `maxTotalVertices` (mask runs count too). */
export const geometryWeight = (geometry: Geometry): number =>
  vertexCount(geometry) + (geometry.type === "mask" ? geometry.counts.length : 0)

function metaIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  const holders: [string, JSONValue][] = [
    ["meta", doc.meta],
    ["config.meta", doc.config.meta],
  ]
  for (const [id, entity] of Object.entries(doc.sources))
    holders.push([`sources.${id}.meta`, entity.meta])
  for (const [id, entity] of Object.entries(doc.regions))
    holders.push([`regions.${id}.meta`, entity.meta])
  for (const [id, entity] of Object.entries(doc.tracks))
    holders.push([`tracks.${id}.meta`, entity.meta])
  for (const [id, entity] of Object.entries(doc.config.classes))
    holders.push([`config.classes.${id}.meta`, entity.meta])
  for (const [id, entity] of Object.entries(doc.config.tags))
    holders.push([`config.tags.${id}.meta`, entity.meta])
  for (const { geometry, path } of walkGeometries(doc)) {
    if (geometry.type === "custom") holders.push([`${path}.data`, geometry.data])
  }
  return holders
    .filter(([, meta]) => nestingDepth(meta, limits.maxMetaDepth) > limits.maxMetaDepth)
    .map(([path]) =>
      issue("LIMIT_EXCEEDED", path, `Value is nested deeper than ${limits.maxMetaDepth} levels`),
    )
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** Checks the string values of an attribute record. */
function attributeStrings(
  check: StringCheck,
  path: string,
  attributes: Record<string, unknown>,
  max: number,
): void {
  for (const [key, value] of Object.entries(attributes)) check(`${path}.${key}`, textOf(value), max)
}

type StringCheck = (path: string, value: string | undefined, max: number) => void

function configStringIssues(doc: AnnotationDocument, check: StringCheck, limits: Limits): void {
  const max = limits.maxStringLength
  for (const [id, c] of Object.entries(doc.config.classes)) {
    check(`config.classes.${id}.name`, c.name, max)
    check(`config.classes.${id}.hotkey`, c.hotkey, max)
  }
  for (const [id, t] of Object.entries(doc.config.tags))
    check(`config.tags.${id}.name`, t.name, max)
  for (const [key, a] of Object.entries(doc.config.attributes)) {
    check(`config.attributes.${key}.label`, a.label, max)
    check(`config.attributes.${key}.default`, textOf(a.default), max)
    for (const option of a.options ?? []) check(`config.attributes.${key}.options`, option, max)
  }
  for (const [id, k] of Object.entries(doc.config.skeletons)) {
    check(`config.skeletons.${id}.name`, k.name, max)
    for (const [i, point] of k.points.entries())
      check(`config.skeletons.${id}.points.${i}.name`, point.name, max)
  }
  for (const tool of doc.config.tools ?? []) check("config.tools", tool, max)
}

function annotationStrings(
  check: StringCheck,
  at: string,
  a: Region | Track,
  limits: Limits,
): void {
  const text = limits.maxStringLength
  check(`${at}.comment`, a.comment, limits.maxCommentLength)
  check(`${at}.status`, a.status, text)
  check(`${at}.provenance.createdBy`, a.provenance.createdBy, text)
  if (a.provenance.source !== "manual") {
    check(`${at}.provenance.source.model`, a.provenance.source.model, text)
    check(`${at}.provenance.source.version`, a.provenance.source.version, text)
  }
  attributeStrings(check, `${at}.attributes`, a.attributes, text)
}

/** Text, `meta` depth and shape-size limits for one region or track. */
export function annotationLimitIssues(
  kind: "regions" | "tracks",
  a: Region | Track,
  limits: Limits,
): Issue[] {
  const at = `${kind}.${a.id}`
  const issues: Issue[] = []
  const check: StringCheck = (path, value, max) => {
    if (value !== undefined && value.length > max)
      issues.push(issue("LIMIT_EXCEEDED", path, `Text is longer than ${max} characters`))
  }
  annotationStrings(check, at, a, limits)
  if (nestingDepth(a.meta, limits.maxMetaDepth) > limits.maxMetaDepth) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        `${at}.meta`,
        `Value is nested deeper than ${limits.maxMetaDepth} levels`,
      ),
    )
  }
  const geometries =
    kind === "regions" ? [(a as Region).geometry] : (a as Track).keyframes.map((k) => k.geometry)
  for (const geometry of geometries) {
    if (largestRun(geometry) > limits.maxVerticesPerShape) {
      issues.push(
        issue(
          "LIMIT_EXCEEDED",
          `${at}.geometry`,
          `More than ${limits.maxVerticesPerShape} vertices in one ring or line`,
        ),
      )
    }
    if (
      geometry.type === "custom" &&
      nestingDepth(geometry.data, limits.maxMetaDepth) > limits.maxMetaDepth
    ) {
      issues.push(
        issue(
          "LIMIT_EXCEEDED",
          `${at}.geometry.data`,
          `Value is nested deeper than ${limits.maxMetaDepth} levels`,
        ),
      )
    }
  }
  return issues
}

function stringIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  const issues: Issue[] = []
  const check: StringCheck = (path, value, max) => {
    if (issues.length < MAX_ISSUES_PER_CHECK && value !== undefined && value.length > max)
      issues.push(issue("LIMIT_EXCEEDED", path, `Text is longer than ${max} characters`))
  }
  check("config.taskDescription", doc.config.taskDescription, limits.maxCommentLength)
  const text = limits.maxStringLength
  for (const [id, s] of Object.entries(doc.sources)) {
    check(`sources.${id}.name`, s.name, text)
    check(`sources.${id}.uri`, s.uri, text)
    check(`sources.${id}.thumbnailUri`, s.thumbnailUri, text)
    check(`sources.${id}.comment`, s.comment, limits.maxCommentLength)
    check(`sources.${id}.scale.realSize.unit`, s.scale?.realSize?.unit, text)
    attributeStrings(check, `sources.${id}.attributes`, s.attributes, text)
  }
  const annotations: [string, string, AnnotationDocument["regions"][string] | Track][] = [
    ...Object.entries(doc.regions).map(([id, a]): [string, string, typeof a] => ["regions", id, a]),
    ...Object.entries(doc.tracks).map(([id, a]): [string, string, typeof a] => ["tracks", id, a]),
  ]
  for (const [kind, id, a] of annotations) annotationStrings(check, `${kind}.${id}`, a, limits)
  configStringIssues(doc, check, limits)
  return issues
}

function sizeIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  const issues: Issue[] = []
  const annotations = Object.keys(doc.regions).length + Object.keys(doc.tracks).length
  if (annotations > limits.maxAnnotations) {
    issues.push(
      issue("LIMIT_EXCEEDED", "regions", `More than ${limits.maxAnnotations} annotations`),
    )
  }
  let total = 0
  for (const { geometry, path } of walkGeometries(doc)) {
    total += geometryWeight(geometry)
    if (largestRun(geometry) > limits.maxVerticesPerShape) {
      issues.push(
        issue(
          "LIMIT_EXCEEDED",
          path,
          `More than ${limits.maxVerticesPerShape} vertices in one ring or line`,
        ),
      )
    }
  }
  if (total > limits.maxTotalVertices) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        "regions",
        `More than ${limits.maxTotalVertices} vertices in the document`,
      ),
    )
  }
  return issues
}

export function checkLimits(doc: AnnotationDocument, limits: Limits): Issue[] {
  return [...sizeIssues(doc, limits), ...stringIssues(doc, limits), ...metaIssues(doc, limits)]
}
