import type { AnnotationDocument, AttributeDef, AttributeValue, GeometryType } from "../types.js"
import { type Issue, MAX_ISSUES_PER_CHECK, issue, pushAll } from "./issues.js"

const optionSets = new WeakMap<AttributeDef, ReadonlySet<string>>()

/** One Set per definition, so enum checks do not scan up to 1000 options per value. */
function optionSet(def: AttributeDef): ReadonlySet<string> {
  let set = optionSets.get(def)
  if (!set) {
    set = new Set(def.options ?? [])
    optionSets.set(def, set)
  }
  return set
}

function attributeProblem(def: AttributeDef, value: AttributeValue): string | null {
  switch (def.type) {
    case "string":
      return typeof value === "string" ? null : "expected a string"
    case "boolean":
      return typeof value === "boolean" ? null : "expected a boolean"
    case "enum":
      return typeof value === "string" && optionSet(def).has(value)
        ? null
        : "expected one of the listed options"
    case "number":
      if (typeof value !== "number") return "expected a number"
      if (def.min !== undefined && value < def.min) return `must be at least ${def.min}`
      if (def.max !== undefined && value > def.max) return `must be at most ${def.max}`
      return null
  }
}

export function attributeIssues(
  doc: AnnotationDocument,
  path: string,
  attributes: Record<string, AttributeValue>,
): Issue[] {
  const issues: Issue[] = []
  for (const [key, value] of Object.entries(attributes)) {
    if (issues.length >= MAX_ISSUES_PER_CHECK) break
    const def = doc.config.attributes[key]
    if (!def) {
      issues.push(issue("ATTRIBUTE_INVALID", `${path}.${key}`, `Unknown attribute "${key}"`))
      continue
    }
    const problem = attributeProblem(def, value)
    if (problem)
      issues.push(issue("ATTRIBUTE_INVALID", `${path}.${key}`, `Attribute "${key}": ${problem}`))
  }
  return issues
}

export function classGeometryIssue(
  doc: AnnotationDocument,
  path: string,
  classId: string | undefined,
  type: GeometryType,
): Issue[] {
  const allowed = classId === undefined ? undefined : doc.config.classes[classId]?.allowedGeometry
  if (allowed && !allowed.includes(type)) {
    return [
      issue(
        "INVALID_GEOMETRY",
        `${path}.geometry`,
        `Class "${classId}" does not allow ${type} geometry`,
      ),
    ]
  }
  return []
}

function attributeDefKeys(doc: AnnotationDocument): Issue[] {
  return Object.entries(doc.config.attributes)
    .filter(([key, def]) => def.key !== key)
    .map(([key, def]) =>
      issue(
        "INVALID_DOCUMENT",
        `config.attributes.${key}`,
        `Record key "${key}" does not match key "${def.key}"`,
      ),
    )
}

function attributeDefProblems(key: string, def: AttributeDef): Issue[] {
  const at = `config.attributes.${key}`
  const issues: Issue[] = []
  if (def.min !== undefined && def.max !== undefined && def.min > def.max)
    issues.push(issue("INVALID_DOCUMENT", at, "min is greater than max"))
  if (def.type === "enum" && (def.options ?? []).length === 0)
    issues.push(issue("INVALID_DOCUMENT", at, "An enum attribute needs options"))
  if (def.default !== undefined) {
    const problem = attributeProblem(def, def.default)
    if (problem) issues.push(issue("ATTRIBUTE_INVALID", `${at}.default`, `Default ${problem}`))
  }
  return issues
}

function duplicateAttributeKeys(doc: AnnotationDocument): Issue[] {
  return Object.entries(doc.config.classes)
    .filter(([, c]) => new Set(c.attributeKeys).size !== (c.attributeKeys ?? []).length)
    .map(([id]) =>
      issue("INVALID_DOCUMENT", `config.classes.${id}.attributeKeys`, "Attribute listed twice"),
    )
}

export function checkLabels(doc: AnnotationDocument): Issue[] {
  const issues = [...attributeDefKeys(doc), ...duplicateAttributeKeys(doc)]
  for (const [key, def] of Object.entries(doc.config.attributes))
    pushAll(issues, attributeDefProblems(key, def))
  for (const [id, source] of Object.entries(doc.sources)) {
    pushAll(issues, attributeIssues(doc, `sources.${id}.attributes`, source.attributes))
  }
  for (const [id, region] of Object.entries(doc.regions)) {
    pushAll(issues, attributeIssues(doc, `regions.${id}.attributes`, region.attributes))
    pushAll(issues, classGeometryIssue(doc, `regions.${id}`, region.classId, region.geometry.type))
  }
  for (const [id, track] of Object.entries(doc.tracks)) {
    pushAll(issues, attributeIssues(doc, `tracks.${id}.attributes`, track.attributes))
    pushAll(issues, classGeometryIssue(doc, `tracks.${id}`, track.classId, track.geometryType))
  }
  return issues
}
