import { getDotPath, safeParse } from "valibot"
import { AnnotateError, type ErrorIssue } from "../errors.js"
import { type Limits, resolveLimits } from "../limits.js"
import { DocumentSchema, SCHEMA_MAJOR } from "../schema/document.js"
import type { AnnotationDocument } from "../types.js"
import { isPlainJson, nestingDepth } from "./depth.js"
import { checkGeometryRules } from "./geometry-rules.js"
import { checkIdentity, checkOrders } from "./identity.js"
import { type Issue, clip } from "./issues.js"
import { checkLabels } from "./labels.js"
import { checkLimits } from "./limit-checks.js"
import { checkReferences } from "./references.js"
import { checkVideo } from "./video.js"

const MAX_REPORTED_ISSUES = 25

/** Paths and messages can quote the input, so they are cut to this length. */
const MAX_TEXT = 200

export interface ParseOptions {
  limits?: Partial<Limits>
}

/** Beyond free-form JSON, the document's own structure nests this deep at most. */
const STRUCTURE_DEPTH_ALLOWANCE = 32

const countKeys = (value: unknown): number =>
  typeof value === "object" && value !== null ? Object.keys(value).length : 0

/** Cheap checks that run before the schema walks the whole input. */
function guardShape(input: unknown, limits: Limits): void {
  const fields = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >
  if (countKeys(fields.regions) + countKeys(fields.tracks) > limits.maxAnnotations) {
    throw new AnnotateError(
      "LIMIT_EXCEEDED",
      `regions: More than ${limits.maxAnnotations} annotations`,
      {
        issues: [{ path: "regions", message: `More than ${limits.maxAnnotations} annotations` }],
      },
    )
  }
  const allowed = limits.maxMetaDepth + STRUCTURE_DEPTH_ALLOWANCE
  if (nestingDepth(input, allowed) > allowed) {
    throw new AnnotateError("LIMIT_EXCEEDED", "document: nesting is too deep to validate", {
      issues: [{ path: "document", message: "Nesting is too deep to validate" }],
    })
  }
  if (!isPlainJson(input)) {
    throw new AnnotateError("INVALID_DOCUMENT", "document: contains a value that is not JSON", {
      issues: [{ path: "document", message: "Contains a value that is not JSON" }],
    })
  }
}

/** Reads the major version without trusting the rest of the input. */
function unsupportedMajor(input: unknown): number | null {
  if (typeof input !== "object" || input === null) return null
  const version = (input as { schemaVersion?: unknown }).schemaVersion
  if (typeof version !== "string") return null
  const match = /^(\d+)\./.exec(version)
  const major = match ? Number(match[1]) : null
  return major !== null && major !== SCHEMA_MAJOR ? major : null
}

/** Exotic inputs (throwing getters or proxies) must still produce a typed error. */
function readUntrusted(input: unknown, limits: Limits) {
  try {
    const major = unsupportedMajor(input)
    if (major !== null) {
      throw new AnnotateError(
        "UNSUPPORTED_VERSION",
        `Document schema ${major}.x is not supported (this library reads ${SCHEMA_MAJOR}.x)`,
      )
    }
    guardShape(input, limits)
    // Stop at the first problem: a document of a million bad elements must not
    // allocate a million issue objects only to report the first few.
    return safeParse(DocumentSchema, input, { abortEarly: true })
  } catch (error) {
    if (error instanceof AnnotateError) throw error
    throw new AnnotateError("INVALID_DOCUMENT", "document: the input could not be read", {
      issues: [{ path: "document", message: "The input could not be read" }],
    })
  }
}

function toErrorIssues(issues: readonly Issue[]): ErrorIssue[] {
  return issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(({ path, message }) => ({ path: clip(path, MAX_TEXT), message: clip(message, MAX_TEXT) }))
}

function fail(issues: readonly Issue[]): never {
  const first = issues[0] as Issue
  const extra = issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""
  const summary = clip(`${first.path}: ${first.message}`, MAX_TEXT)
  throw new AnnotateError(first.code, `${summary}${extra}`, {
    issues: toErrorIssues(issues),
  })
}

function invariantIssues(doc: AnnotationDocument, limits: Limits): Issue[] {
  // Staged so the root cause is reported, not its consequences: ids and keys
  // first, then references, then the orderings that depend on both.
  for (const stage of [checkIdentity, checkReferences, checkOrders]) {
    const issues = stage(doc)
    if (issues.length > 0) return issues
  }
  return [
    ...checkLimits(doc, limits),
    ...checkGeometryRules(doc, limits),
    ...checkVideo(doc),
    ...checkLabels(doc),
  ]
}

/**
 * Validates untrusted input and returns it typed. Throws an AnnotateError
 * (UNSUPPORTED_VERSION, INVALID_DOCUMENT, DUPLICATE_ID, CYCLE, INVALID_GEOMETRY,
 * OUT_OF_BOUNDS, ATTRIBUTE_INVALID or LIMIT_EXCEEDED) describing the problems.
 * Unknown fields are preserved. The input is never mutated.
 */
export function parseDocument(input: unknown, options: ParseOptions = {}): AnnotationDocument {
  const limits = resolveLimits(options.limits)
  const result = readUntrusted(input, limits)
  if (!result.success) {
    const issues: Issue[] = result.issues.map((entry) => ({
      code: "INVALID_DOCUMENT",
      path: getDotPath(entry) ?? "document",
      message: entry.message,
    }))
    fail(issues)
  }
  const issues = invariantIssues(result.output, limits)
  if (issues.length > 0) fail(issues)
  return result.output
}
