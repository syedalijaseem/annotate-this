import { largestRun, vertexCount } from "../geometry/bounds.js"
import type { Limits } from "../limits.js"
import type {
  AnnotationDocument,
  AttributeDef,
  ClassDef,
  Config,
  Geometry,
  JSONValue,
  Region,
  Skeleton,
  Source,
  Track,
} from "../types.js"
import { nestingDepth } from "./depth.js"
import { type Issue, MAX_ISSUES_PER_CHECK, issue, pushAll, walkGeometries } from "./issues.js"

/** What one geometry counts against `maxTotalVertices` (mask runs count too). */
export const geometryWeight = (geometry: Geometry): number =>
  vertexCount(geometry) + (geometry.type === "mask" ? geometry.counts.length : 0)

const tooDeep = (path: string, limits: Limits): Issue =>
  issue("LIMIT_EXCEEDED", path, `Value is nested deeper than ${limits.maxMetaDepth} levels`)

/** `meta` (or custom geometry data) may nest at most maxMetaDepth levels. */
export function metaDepthIssues(path: string, value: unknown, limits: Limits): Issue[] {
  return nestingDepth(value, limits.maxMetaDepth) > limits.maxMetaDepth
    ? [tooDeep(path, limits)]
    : []
}

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
  return holders.flatMap(([path, meta]) => metaDepthIssues(path, meta, limits))
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

export type StringCheck = (path: string, value: string | undefined, max: number) => void

/** A StringCheck that records LIMIT_EXCEEDED issues (at most MAX_ISSUES_PER_CHECK) into `issues`. */
export const textLimit =
  (issues: Issue[]): StringCheck =>
  (path, value, max) => {
    if (issues.length < MAX_ISSUES_PER_CHECK && value !== undefined && value.length > max)
      issues.push(issue("LIMIT_EXCEEDED", path, `Text is longer than ${max} characters`))
  }

export type DefKind = "classes" | "tags" | "attributes" | "skeletons"

/** Text fields of one class, tag, attribute definition or skeleton (known fields only). */
export function defStrings(
  check: StringCheck,
  kind: DefKind,
  key: string,
  def: Config[DefKind][string],
  max: number,
): void {
  const at = `config.${kind}.${key}`
  if (kind === "attributes") {
    const a = def as AttributeDef
    check(`${at}.label`, a.label, max)
    check(`${at}.default`, textOf(a.default), max)
    for (const option of a.options ?? []) check(`${at}.options`, option, max)
    return
  }
  const named = def as ClassDef | Skeleton
  check(`${at}.name`, named.name, max)
  if (kind === "classes") check(`${at}.hotkey`, (named as ClassDef).hotkey, max)
  if (kind === "skeletons") {
    for (const [i, point] of (named as Skeleton).points.entries())
      check(`${at}.points.${i}.name`, point.name, max)
  }
}

/** Text fields of the config itself: the task description, tool ids and statuses. */
export function configStrings(check: StringCheck, config: Config, limits: Limits): void {
  check("config.taskDescription", config.taskDescription, limits.maxCommentLength)
  for (const tool of config.tools ?? []) check("config.tools", tool, limits.maxStringLength)
  for (const status of config.statuses ?? [])
    check("config.statuses", status, limits.maxStringLength)
}

function configStringIssues(doc: AnnotationDocument, check: StringCheck, limits: Limits): void {
  configStrings(check, doc.config, limits)
  for (const kind of ["classes", "tags", "attributes", "skeletons"] as const) {
    for (const [key, def] of Object.entries(doc.config[kind]))
      defStrings(check, kind, key, def, limits.maxStringLength)
  }
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
  const issues = metaDepthIssues(`${at}.meta`, a.meta, limits)
  annotationStrings(textLimit(issues), at, a, limits)
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
    if (geometry.type === "custom")
      pushAll(issues, metaDepthIssues(`${at}.geometry.data`, geometry.data, limits))
  }
  return issues
}

/** Text fields of one source. */
export function sourceStrings(check: StringCheck, id: string, s: Source, limits: Limits): void {
  const text = limits.maxStringLength
  check(`sources.${id}.name`, s.name, text)
  check(`sources.${id}.uri`, s.uri, text)
  check(`sources.${id}.thumbnailUri`, s.thumbnailUri, text)
  check(`sources.${id}.comment`, s.comment, limits.maxCommentLength)
  check(`sources.${id}.scale.realSize.unit`, s.scale?.realSize?.unit, text)
  attributeStrings(check, `sources.${id}.attributes`, s.attributes, text)
}

function stringIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  const issues: Issue[] = []
  const check = textLimit(issues)
  for (const [id, s] of Object.entries(doc.sources)) sourceStrings(check, id, s, limits)
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
