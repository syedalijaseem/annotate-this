import { getDotPath, safeParse } from "valibot"
import { AnnotateError } from "../errors.js"
import { type Limits, resolveLimits } from "../limits.js"
import { DocumentSchema } from "../schema/document.js"
import type { AnnotationDocument } from "../types.js"
import { checkGeometryRules } from "./geometry-rules.js"
import { checkIdentity, checkOrders } from "./identity.js"
import { type Issue, fail } from "./issues.js"
import { checkLabels } from "./labels.js"
import { checkLimits } from "./limit-checks.js"
import { checkReferences } from "./references.js"
import { snapshotDocument } from "./snapshot.js"
import { checkVideo } from "./video.js"

export interface ParseOptions {
  limits?: Partial<Limits>
}

/** Exotic inputs (throwing getters or proxies) must still produce a typed error. */
function readUntrusted(input: unknown, limits: Limits, copy: boolean) {
  try {
    const snapshot = snapshotDocument(input, limits, copy)
    // Stop at the first problem: a document of a million bad elements must not
    // allocate a million issue objects only to report the first few.
    return safeParse(DocumentSchema, snapshot, { abortEarly: true })
  } catch (error) {
    if (error instanceof AnnotateError) throw error
    throw new AnnotateError("INVALID_DOCUMENT", "document: the input could not be read", {
      issues: [{ path: "document", message: "The input could not be read" }],
    })
  }
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
  return parseInput(input, options, true)
}

// parseDocument; `copy` false skips building the snapshot, for input that is
// fresh JSON.parse output (plain, own data properties only, aliased by nobody).
export function parseInput(
  input: unknown,
  options: ParseOptions,
  copy: boolean,
): AnnotationDocument {
  const limits = resolveLimits(options.limits)
  const result = readUntrusted(input, limits, copy)
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
