import { DEFAULT_STATUSES } from "../schema/config.js"
import type { AnnotationBase, AnnotationDocument } from "../types.js"
import { type Issue, issue, walkGeometries } from "./issues.js"

/** Detects cycles in a parent graph in linear time (three-colour depth-first walk). */
function findCycles(parents: ReadonlyMap<string, string>): string[] {
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

function tagIssues(doc: AnnotationDocument, path: string, tagIds: readonly string[]): Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const tagId of tagIds) {
    if (!(tagId in doc.config.tags))
      issues.push(issue("INVALID_DOCUMENT", path, `Unknown tag "${tagId}"`))
    else if (seen.has(tagId))
      issues.push(issue("INVALID_DOCUMENT", path, `Tag "${tagId}" is listed twice`))
    seen.add(tagId)
  }
  return issues
}

function annotationRefs(
  doc: AnnotationDocument,
  kind: "regions" | "tracks",
  id: string,
  a: AnnotationBase,
): Issue[] {
  const issues: Issue[] = []
  const at = `${kind}.${id}`
  if (!(a.sourceId in doc.sources))
    issues.push(issue("INVALID_DOCUMENT", `${at}.sourceId`, `Unknown source "${a.sourceId}"`))
  if (a.classId !== undefined && !(a.classId in doc.config.classes)) {
    issues.push(issue("INVALID_DOCUMENT", `${at}.classId`, `Unknown class "${a.classId}"`))
  }
  issues.push(...tagIssues(doc, `${at}.tagIds`, a.tagIds))
  if (a.parentId !== undefined) {
    const parent = doc.regions[a.parentId] ?? doc.tracks[a.parentId]
    if (!parent)
      issues.push(issue("INVALID_DOCUMENT", `${at}.parentId`, `Unknown parent "${a.parentId}"`))
    else if (parent.sourceId !== a.sourceId) {
      issues.push(
        issue("INVALID_DOCUMENT", `${at}.parentId`, "Parent must belong to the same source"),
      )
    }
  }
  if (!(doc.config.statuses ?? DEFAULT_STATUSES).includes(a.status)) {
    issues.push(
      issue("INVALID_DOCUMENT", `${at}.status`, `Status "${a.status}" is not an allowed status`),
    )
  }
  return issues
}

function sourceRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  for (const [id, source] of Object.entries(doc.sources)) {
    if (source.classId !== undefined && !(source.classId in doc.config.classes)) {
      issues.push(
        issue("INVALID_DOCUMENT", `sources.${id}.classId`, `Unknown class "${source.classId}"`),
      )
    }
    issues.push(...tagIssues(doc, `sources.${id}.tagIds`, source.tagIds))
  }
  return issues
}

function configRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  const parents = new Map<string, string>()
  for (const [id, def] of Object.entries(doc.config.classes)) {
    if (def.parentId !== undefined) {
      if (def.parentId in doc.config.classes) parents.set(id, def.parentId)
      else
        issues.push(
          issue(
            "INVALID_DOCUMENT",
            `config.classes.${id}.parentId`,
            `Unknown class "${def.parentId}"`,
          ),
        )
    }
    for (const key of def.attributeKeys ?? []) {
      if (!(key in doc.config.attributes)) {
        issues.push(
          issue(
            "INVALID_DOCUMENT",
            `config.classes.${id}.attributeKeys`,
            `Unknown attribute "${key}"`,
          ),
        )
      }
    }
  }
  for (const id of findCycles(parents))
    issues.push(issue("CYCLE", `config.classes.${id}.parentId`, "Class hierarchy contains a cycle"))
  for (const [id, skeleton] of Object.entries(doc.config.skeletons)) {
    for (const [a, b] of skeleton.edges) {
      if (a >= skeleton.points.length || b >= skeleton.points.length) {
        issues.push(
          issue(
            "INVALID_DOCUMENT",
            `config.skeletons.${id}.edges`,
            "Edge refers to a point that does not exist",
          ),
        )
      }
    }
  }
  return issues
}

function annotationGraph(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  const parents = new Map<string, string>()
  for (const [id, region] of Object.entries(doc.regions)) {
    issues.push(...annotationRefs(doc, "regions", id, region))
    if (region.parentId !== undefined) parents.set(id, region.parentId)
  }
  for (const [id, track] of Object.entries(doc.tracks)) {
    issues.push(...annotationRefs(doc, "tracks", id, track))
    if (track.parentId !== undefined) parents.set(id, track.parentId)
    if (doc.sources[track.sourceId]?.kind === "image") {
      issues.push(
        issue("INVALID_DOCUMENT", `tracks.${id}.sourceId`, "Tracks belong to video sources only"),
      )
    }
  }
  for (const id of findCycles(parents))
    issues.push(
      issue(
        "CYCLE",
        `${id in doc.regions ? "regions" : "tracks"}.${id}.parentId`,
        "Parent chain contains a cycle",
      ),
    )
  return issues
}

function skeletonRefs(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = []
  for (const { geometry, path } of walkGeometries(doc)) {
    if (geometry.type === "keypoints" && !(geometry.skeletonId in doc.config.skeletons)) {
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
