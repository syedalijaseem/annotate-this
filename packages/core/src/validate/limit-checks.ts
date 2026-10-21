import { largestRun, vertexCount } from "../geometry/bounds.js"
import type { Limits } from "../limits.js"
import type { AnnotationDocument, JSONValue } from "../types.js"
import { nestingDepth } from "./depth.js"
import { type Issue, issue, walkGeometries } from "./issues.js"

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
    for (const option of a.options ?? []) check(`config.attributes.${key}.options`, option, max)
  }
  for (const [id, k] of Object.entries(doc.config.skeletons))
    check(`config.skeletons.${id}.name`, k.name, max)
  for (const tool of doc.config.tools ?? []) check("config.tools", tool, max)
}

function stringIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  const issues: Issue[] = []
  const check: StringCheck = (path, value, max) => {
    if (value !== undefined && value.length > max)
      issues.push(issue("LIMIT_EXCEEDED", path, `Text is longer than ${max} characters`))
  }
  check("config.taskDescription", doc.config.taskDescription, limits.maxCommentLength)
  for (const [id, s] of Object.entries(doc.sources)) {
    check(`sources.${id}.name`, s.name, limits.maxStringLength)
    check(`sources.${id}.uri`, s.uri, limits.maxStringLength)
    check(`sources.${id}.thumbnailUri`, s.thumbnailUri, limits.maxStringLength)
    check(`sources.${id}.comment`, s.comment, limits.maxCommentLength)
  }
  for (const [id, a] of [...Object.entries(doc.regions), ...Object.entries(doc.tracks)]) {
    check(
      `${id in doc.regions ? "regions" : "tracks"}.${id}.comment`,
      a.comment,
      limits.maxCommentLength,
    )
    check(
      `${id in doc.regions ? "regions" : "tracks"}.${id}.status`,
      a.status,
      limits.maxStringLength,
    )
  }
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
    total += vertexCount(geometry) + (geometry.type === "mask" ? geometry.counts.length : 0)
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
