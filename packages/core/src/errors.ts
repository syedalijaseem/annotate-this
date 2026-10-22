/** Stable error codes (Spec 0002). Messages are safe to show to users. */
export const ERROR_CODES = /* @__PURE__ */ Object.freeze([
  "NOT_FOUND",
  "DUPLICATE_ID",
  "DUPLICATE_BATCH",
  "REV_CONFLICT",
  "IN_USE",
  "CYCLE",
  "INVALID_GEOMETRY",
  "OUT_OF_BOUNDS",
  "ATTRIBUTE_INVALID",
  "LIMIT_EXCEEDED",
  "INVALID_DOCUMENT",
  "SIZE_MISMATCH",
  "UNSUPPORTED_VERSION",
  "READ_ONLY",
] as const)

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ErrorIssue {
  /** Dot path into the offending document, e.g. `regions.r1.geometry`. */
  path: string
  message: string
}

export interface ErrorDetail {
  opIndex?: number
  opId?: string
  issues?: ErrorIssue[]
}

export class AnnotateError extends Error {
  readonly code: ErrorCode
  readonly opIndex?: number
  readonly opId?: string
  readonly issues?: ErrorIssue[]

  constructor(code: ErrorCode, message: string, detail: ErrorDetail = {}) {
    super(message)
    this.name = "AnnotateError"
    this.code = code
    if (detail.opIndex !== undefined) this.opIndex = detail.opIndex
    if (detail.opId !== undefined) this.opId = detail.opId
    if (detail.issues !== undefined) this.issues = detail.issues
  }
}

const CODE_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(ERROR_CODES)

const isIssue = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ErrorIssue).path === "string" &&
  typeof (value as ErrorIssue).message === "string"

function isWellFormed(candidate: Record<string, unknown>): boolean {
  const { name, code, message, issues, opIndex, opId } = candidate
  return (
    name === "AnnotateError" &&
    typeof code === "string" &&
    CODE_SET.has(code) &&
    typeof message === "string" &&
    (issues === undefined || (Array.isArray(issues) && issues.every(isIssue))) &&
    (opIndex === undefined || typeof opIndex === "number") &&
    (opId === undefined || typeof opId === "string")
  )
}

/**
 * Structural check, so errors that crossed a realm or bundle boundary are
 * still recognised. Detail fields must have their documented types; a hostile
 * value (throwing getters, proxies) is simply not an AnnotateError.
 */
export function isAnnotateError(value: unknown): value is AnnotateError {
  if (typeof value !== "object" || value === null) return false
  try {
    return isWellFormed(value as Record<string, unknown>)
  } catch {
    return false
  }
}
