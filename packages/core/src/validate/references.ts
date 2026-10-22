import { DEFAULT_STATUSES } from "../schema/config.js"
import type { AnnotationBase, AnnotationDocument, ClassDef, Skeleton, Source } from "../types.js"
import {
  type Issue,
  MAX_ISSUES_PER_CHECK,
  clip,
  issue,
  own,
  pushAll,
  walkGeometries,
} from "./issues.js"

/** Detects cycles in a parent graph in linear time (three-colour depth-first walk). */
export function findCycles(parents: ReadonlyMap<string, string>): string[] {
  const state = new Map<string, 1 | 2>() // 1 = on the current chain, 2 = finished
  const cyclic: string[] = []
  for (const start of parents.keys()) {
    const chain: string[] = []
    let current: string | undefined = start
    while (current !== undefined && !state.has(current)) {
      state.set(current, 1)
      chain.push(current)
      current = parents.get(current)
    }
    if (current !== undefined && state.get(current) === 1) cyclic.push(current)
    for (const id of chain) state.set(id, 2)
  }
  return cyclic
}

const statusSets = new WeakMap<readonly string[], ReadonlySet<string>>()

/** Statuses are looked up once per annotation, so build the Set once per list. */
export function statusSet(statuses: readonly string[]): ReadonlySet<string> {
  let set = statusSets.get(statuses)
  if (!set) {
    set = new Set(statuses)
    statusSets.set(statuses, set)
  }
  return set
}

function tagIssues(doc: AnnotationDocument, path: string, tagIds: readonly string[]): Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const tagId of tagIds) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) return issues
    if (!Object.hasOwn(doc.config.tags, tagId))
      issues.push(issue("INVALID_DOCUMENT", path, `Unknown tag "${tagId}"`))
    else if (seen.has(tagId))
      issues.push(issue("INVALID_DOCUMENT", path, `Tag "${tagId}" is listed twice`))
    seen.add(tagId)
  }
  return issues
}

/** References of one region or track: source, class, tags, parent and status. */
export function annotationRefs(
  doc: AnnotationDocument,
  kind: "regions" | "tracks",
  id: string,
  a: AnnotationBase,
): Issue[] {
  const issues: Issue[] = []
  const at = `${kind}.${id}`
  if (!Object.hasOwn(doc.sources, a.sourceId))
    issues.push(issue("INVALID_DOCUMENT", `${at}.sourceId`, `Unknown source "${a.sourceId}"`))
  if (a.classId !== undefined && !Object.hasOwn(doc.config.classes, a.classId)) {
    issues.push(issue("INVALID_DOCUMENT", `${at}.classId`, `Unknown class "${a.classId}"`))
  }
  pushAll(issues, tagIssues(doc, `${at}.tagIds`, a.tagIds))
  if (a.parentId !== undefined) {
    const parent = own(doc.regions, a.parentId) ?? own(doc.tracks, a.parentId)
    if (!parent)
      issues.push(issue("INVALID_DOCUMENT", `${at}.parentId`, `Unknown parent "${a.parentId}"`))
    else if (parent.sourceId !== a.sourceId) {
      issues.push(
        issue("INVALID_DOCUMENT", `${at}.parentId`, "Parent must belong to the same source"),
      )
    }
  }
  if (!statusSet(doc.config.statuses ?? DEFAULT_STATUSES).has(a.status)) {
    issues.push(
      issue(
        "INVALID_DOCUMENT",
        `${at}.status`,
        `Status "${clip(a.status)}" is not an allowed status`,
      ),
    )
  }
  return issues
}

/** References of one source: its class and tags. */
export function sourceRefIssues(doc: AnnotationDocument, id: string, source: Source): Issue[] {
  const issues = tagIssues(doc, `sources.${id}.tagIds`, source.tagIds)
  if (source.classId !== undefined && !Object.hasOwn(doc.config.classes, source.classId)) {
    issues.push(
      issue("INVALID_DOCUMENT", `sources.${id}.classId`, `Unknown class "${source.classId}"`),
    )
  }
  return issues
}

function sourceRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  for (const [id, source] of Object.entries(doc.sources))
    pushAll(issues, sourceRefIssues(doc, id, source))
  return issues
}

/** References of one class: its parent (existence only; cycles are a graph check) and attribute keys. */
export function classRefIssues(doc: AnnotationDocument, id: string, def: ClassDef): Issue[] {
  const issues: Issue[] = []
  const at = `config.classes.${id}`
  if (def.parentId !== undefined && !Object.hasOwn(doc.config.classes, def.parentId))
    issues.push(issue("INVALID_DOCUMENT", `${at}.parentId`, `Unknown class "${def.parentId}"`))
  for (const key of def.attributeKeys ?? []) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) break
    if (!Object.hasOwn(doc.config.attributes, key))
      issues.push(issue("INVALID_DOCUMENT", `${at}.attributeKeys`, `Unknown attribute "${key}"`))
  }
  return issues
}

/** Skeleton edges must name existing points. */
export function skeletonIssues(id: string, skeleton: Skeleton): Issue[] {
  const count = skeleton.points.length
  return skeleton.edges.some(([a, b]) => a >= count || b >= count)
    ? [
        issue(
          "INVALID_DOCUMENT",
          `config.skeletons.${id}.edges`,
          "Edge refers to a point that does not exist",
        ),
      ]
    : []
}

function configRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  const parents = new Map<string, string>()
  for (const [id, def] of Object.entries(doc.config.classes)) {
    pushAll(issues, classRefIssues(doc, id, def))
    if (def.parentId !== undefined && Object.hasOwn(doc.config.classes, def.parentId))
      parents.set(id, def.parentId)
  }
  for (const id of findCycles(parents))
    issues.push(issue("CYCLE", `config.classes.${id}.parentId`, "Class hierarchy contains a cycle"))
  for (const [id, skeleton] of Object.entries(doc.config.skeletons))
    pushAll(issues, skeletonIssues(id, skeleton))
  return issues
}

function annotationGraph(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  const parents = new Map<string, string>()
  for (const [id, region] of Object.entries(doc.regions)) {
    pushAll(issues, annotationRefs(doc, "regions", id, region))
    if (region.parentId !== undefined) parents.set(id, region.parentId)
  }
  for (const [id, track] of Object.entries(doc.tracks)) {
    pushAll(issues, annotationRefs(doc, "tracks", id, track))
    if (track.parentId !== undefined) parents.set(id, track.parentId)
    if (own(doc.sources, track.sourceId)?.kind === "image") {
      issues.push(
        issue("INVALID_DOCUMENT", `tracks.${id}.sourceId`, "Tracks belong to video sources only"),
      )
    }
  }
  for (const id of findCycles(parents))
    issues.push(
      issue(
        "CYCLE",
        `${Object.hasOwn(doc.regions, id) ? "regions" : "tracks"}.${id}.parentId`,
        "Parent chain contains a cycle",
      ),
    )
  return issues
}

function skeletonRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  for (const { geometry, path } of walkGeometries(doc)) {
    if (
      geometry.type === "keypoints" &&
      !Object.hasOwn(doc.config.skeletons, geometry.skeletonId)
    ) {
      issues.push(
        issue(
          "INVALID_DOCUMENT",
          `${path}.skeletonId`,
          `Unknown skeleton "${geometry.skeletonId}"`,
        ),
      )
    }
  }
  return issues
}

export function checkReferences(doc: AnnotationDocument): Issue[] {
  return [...sourceRefs(doc), ...configRefs(doc), ...annotationGraph(doc), ...skeletonRefs(doc)]
}
