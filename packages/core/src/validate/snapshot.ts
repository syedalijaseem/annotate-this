import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { SCHEMA_MAJOR } from "../schema/document.js"
import { type CopyBreach, JsonCopier } from "./copy.js"
import { STRUCTURE_DEPTH_ALLOWANCE } from "./depth.js"

const BREACH_MESSAGES: Record<Exclude<CopyBreach, "bytes">, (limits: Limits) => string> = {
  depth: () => "Nesting is too deep to validate",
  nodes: (limits) => `More than ${limits.maxDocumentNodes} values in the document`,
  entries: (limits) => `An object has more than ${limits.maxEntries} keys`,
}

const countKeys = (value: unknown): number =>
  typeof value === "object" && value !== null ? Object.keys(value).length : 0

const tooLarge = (limits: Limits): AnnotateError =>
  new AnnotateError("LIMIT_EXCEEDED", `Document is larger than ${limits.maxDocumentBytes} bytes`)

// The major version, read from the root's own members.
function unsupportedMajor(version: unknown): number | null {
  if (typeof version !== "string") return null
  const match = /^(\d+)\./.exec(version)
  const major = match ? Number(match[1]) : null
  return major !== null && major !== SCHEMA_MAJOR ? major : null
}

// Budget breaches throw at once; values that are not JSON are noted and
// reported after the walk, so a budget breach wins (as it always has).
class DocumentCopier extends JsonCopier {
  sawNonJson = false

  constructor(
    private readonly limits: Limits,
    build: boolean,
  ) {
    const budget = {
      depth: limits.maxMetaDepth + STRUCTURE_DEPTH_ALLOWANCE,
      nodes: limits.maxDocumentNodes,
      entries: limits.maxEntries,
    }
    super(budget, build, limits.maxDocumentBytes)
  }

  protected breach(kind: CopyBreach): Error {
    if (kind === "bytes") return tooLarge(this.limits)
    const message = BREACH_MESSAGES[kind](this.limits)
    return new AnnotateError("LIMIT_EXCEEDED", `document: ${message}`, {
      issues: [{ path: "document", message }],
    })
  }

  protected notJson(): void {
    this.sawNonJson = true
  }

  protected undefinedMember(): void {
    // Counted like any other non-number value.
    this.count(1)
    this.sawNonJson = true
  }

  // Cheap checks before anything below the root is read: the version, and
  // the annotation count before the schema walks every annotation.
  protected override onRoot(keys: readonly string[], values: readonly unknown[]): void {
    const major = unsupportedMajor(values[keys.indexOf("schemaVersion")])
    if (major !== null) {
      throw new AnnotateError(
        "UNSUPPORTED_VERSION",
        `Document schema ${major}.x is not supported (this library reads ${SCHEMA_MAJOR}.x)`,
      )
    }
    const { maxAnnotations } = this.limits
    const regions = values[keys.indexOf("regions")]
    const tracks = values[keys.indexOf("tracks")]
    if (countKeys(regions) + countKeys(tracks) > maxAnnotations) {
      const message = `More than ${maxAnnotations} annotations`
      throw new AnnotateError("LIMIT_EXCEEDED", `regions: ${message}`, {
        issues: [{ path: "regions", message }],
      })
    }
  }
}

/**
 * Takes the one copy of untrusted document input that everything else reads
 * (see JsonCopier): own properties only, each read once, fresh containers, so
 * no getter, proxy or prototype can answer differently later, and nothing in
 * the result aliases the input. Enforces the input budget (depth, nodes,
 * entries) and maxDocumentBytes, the exact compact JSON size, while walking.
 * With `build` false the input is only checked and returned as is: for
 * JSON.parse output, which is plain and fresh already.
 */
export function snapshotDocument(input: unknown, limits: Limits, build: boolean): unknown {
  const copier = new DocumentCopier(limits, build)
  const copied = copier.take(input)
  const copy = build ? copied : input
  if (copier.sawNonJson) {
    throw new AnnotateError("INVALID_DOCUMENT", "document: contains a value that is not JSON", {
      issues: [{ path: "document", message: "Contains a value that is not JSON" }],
    })
  }
  if (copier.exceedsBytes(copy)) throw tooLarge(limits)
  return copy
}
