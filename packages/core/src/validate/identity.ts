import type { AnnotationDocument } from "../types.js"
import { type Issue, MAX_ISSUES_PER_CHECK, issue, pushAll } from "./issues.js"

type Keyed = Record<string, { id: string }>

/** Record keys must equal the entity id, so lookups by key and by id always agree. */
function keyMatchesId(kind: string, record: Keyed): Issue[] {
  const issues: Issue[] = []
  for (const [key, entity] of Object.entries(record)) {
    if (entity.id !== key) {
      issues.push(
        issue(
          "INVALID_DOCUMENT",
          `${kind}.${key}`,
          `Record key "${key}" does not match id "${entity.id}"`,
        ),
      )
    }
  }
  return issues
}

/** All entity ids share one flat id space (Spec 0001). */
function uniqueIds(doc: AnnotationDocument): Issue[] {
  const seen = new Map<string, string>()
  const issues: Issue[] = []
  const kinds: [string, Keyed][] = [
    ["sources", doc.sources],
    ["regions", doc.regions],
    ["tracks", doc.tracks],
    ["config.classes", doc.config.classes],
    ["config.tags", doc.config.tags],
    ["config.skeletons", doc.config.skeletons],
  ]
  for (const [kind, record] of kinds) {
    for (const entity of Object.values(record)) {
      const previous = seen.get(entity.id)
      if (previous !== undefined) {
        issues.push(
          issue(
            "DUPLICATE_ID",
            `${kind}.${entity.id}`,
            `Id "${entity.id}" is already used by ${previous}`,
          ),
        )
      } else {
        seen.set(entity.id, `${kind}.${entity.id}`)
      }
    }
  }
  return issues
}

/** `order` must list each id of `expected` exactly once and nothing else. */
export function permutationIssues(
  path: string,
  order: readonly string[],
  expected: ReadonlySet<string>,
): Issue[] {
  const issues: Issue[] = []
  const seen = new Set<string>()
  for (const id of order) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) return issues
    if (seen.has(id))
      issues.push(issue("INVALID_DOCUMENT", path, `"${id}" is listed more than once`))
    else if (!expected.has(id))
      issues.push(issue("INVALID_DOCUMENT", path, `"${id}" does not belong here`))
    seen.add(id)
  }
  for (const id of expected) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) return issues
    if (!seen.has(id))
      issues.push(issue("INVALID_DOCUMENT", path, `"${id}" is missing from the order`))
  }
  return issues
}

function idsBySource(record: Record<string, { sourceId: string }>): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>()
  for (const [id, entity] of Object.entries(record)) {
    const set = bySource.get(entity.sourceId) ?? new Set<string>()
    set.add(id)
    bySource.set(entity.sourceId, set)
  }
  return bySource
}

export function checkOrders(doc: AnnotationDocument): Issue[] {
  const issues: Issue[] = [
    ...permutationIssues("sourceOrder", doc.sourceOrder, new Set(Object.keys(doc.sources))),
    ...permutationIssues(
      "config.classOrder",
      doc.config.classOrder,
      new Set(Object.keys(doc.config.classes)),
    ),
    ...permutationIssues(
      "config.tagOrder",
      doc.config.tagOrder,
      new Set(Object.keys(doc.config.tags)),
    ),
  ]
  const regionsOf = idsBySource(doc.regions)
  const tracksOf = idsBySource(doc.tracks)
  const none = new Set<string>()
  for (const [id, source] of Object.entries(doc.sources)) {
    pushAll(
      issues,
      permutationIssues(`sources.${id}.regionOrder`, source.regionOrder, regionsOf.get(id) ?? none),
    )
    if (source.kind === "video") {
      pushAll(
        issues,
        permutationIssues(`sources.${id}.trackOrder`, source.trackOrder, tracksOf.get(id) ?? none),
      )
    }
  }
  return issues
}

export function checkIdentity(doc: AnnotationDocument): Issue[] {
  return [
    ...keyMatchesId("sources", doc.sources),
    ...keyMatchesId("regions", doc.regions),
    ...keyMatchesId("tracks", doc.tracks),
    ...keyMatchesId("config.classes", doc.config.classes),
    ...keyMatchesId("config.tags", doc.config.tags),
    ...keyMatchesId("config.skeletons", doc.config.skeletons),
    ...uniqueIds(doc),
  ]
}
