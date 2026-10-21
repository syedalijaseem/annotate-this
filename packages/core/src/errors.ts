/** Stable error codes (Spec 0002). Messages are safe to show to users. */
export const ERROR_CODES = [
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
] as const

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

const CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES)

/** Structural check, so errors that crossed a realm or bundle boundary are still recognised. */
export function isAnnotateError(value: unknown): value is AnnotateError {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { name?: unknown; code?: unknown; message?: unknown }
  return (
    candidate.name === "AnnotateError" &&
    typeof candidate.code === "string" &&
    CODE_SET.has(candidate.code) &&
    typeof candidate.message === "string"
  )
}
