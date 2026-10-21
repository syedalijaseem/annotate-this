import { safeParse } from "valibot"
import { AnnotateError, type ErrorDetail } from "../errors.js"
import { ID_PATTERN } from "../ids.js"
import { resolveLimits } from "../limits.js"
import { TimestampSchema } from "../schema/primitives.js"
import { isPlainJson } from "../validate/depth.js"
import { clip } from "../validate/issues.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import { Draft } from "./draft.js"
import { assertSafePatchKeys } from "./patch.js"
import {
  createRegion,
  deleteRegion,
  moveRegionToSource,
  patchRegion,
  reorderRegion,
  setGeometry,
} from "./region-ops.js"
import type { ApplyOptions, ApplyResult, Batch, Operation, OperationType } from "./types.js"
import { deepEqual, deriveId, withoutKeys } from "./util.js"
import type { AnnotationDocument, JSONValue } from "../types.js"

const ORIGINS: ReadonlySet<string> = new Set(["local", "remote", "system"])

function setDocumentMeta(ctx: OpContext, op: Extract<Operation, { type: "setDocumentMeta" }>) {
  const { draft } = ctx
  checkBaseRev(ctx, op, draft.original.rev)
  assertSafePatchKeys({ meta: op.patch })
  const current = draft.view.meta
  const sets: [string, JSONValue][] = []
  const drops = new Set<string>()
  const undo: Record<string, JSONValue | null> = {}
  for (const [key, value] of Object.entries(op.patch)) {
    const has = Object.hasOwn(current, key)
    if (value === null ? !has : has && deepEqual(current[key], value)) continue
    undo[key] = has ? (current[key] as JSONValue) : null
    if (value === null) drops.add(key)
    else sets.push([key, value])
  }
  if (sets.length === 0 && drops.size === 0) return []
  const next = withoutKeys(current, drops)
  for (const [key, value] of sets) next[key] = value
  draft.setDocumentMeta(next)
  return [{ type: "setDocumentMeta", patch: undo } as InverseOp]
}

const HANDLERS: {
  [K in OperationType]: (ctx: OpContext, op: Extract<Operation, { type: K }>) => InverseOp[]
} = {
  setDocumentMeta,
  createRegion,
  setGeometry,
  patchRegion,
  deleteRegion,
  reorderRegion,
  moveRegionToSource,
}

const fail = (code: "INVALID_DOCUMENT" | "LIMIT_EXCEEDED", message: string): never => {
  throw new AnnotateError(code, message)
}

function assertBatch(batch: Batch, maxOps: number): void {
  if (typeof batch !== "object" || batch === null)
    fail("INVALID_DOCUMENT", "batch: expected an object")
  if (typeof batch.id !== "string" || !ID_PATTERN.test(batch.id)) {
    fail("INVALID_DOCUMENT", "batch: id must be a valid id")
  }
  if (!ORIGINS.has(batch.origin)) fail("INVALID_DOCUMENT", "batch: unknown origin")
  if (!safeParse(TimestampSchema, batch.at).success) {
    fail("INVALID_DOCUMENT", "batch: at must be an ISO-8601 timestamp")
  }
  if (!Array.isArray(batch.ops) || batch.ops.length === 0) {
    fail("INVALID_DOCUMENT", "batch: needs at least one operation")
  }
  if (batch.ops.length > maxOps) fail("LIMIT_EXCEEDED", `batch: more than ${maxOps} operations`)
}

function assertOperation(op: Operation, seen: Set<string>): void {
  if (typeof op !== "object" || op === null)
    fail("INVALID_DOCUMENT", "operation: expected an object")
  if (typeof op.id !== "string" || !ID_PATTERN.test(op.id)) {
    fail("INVALID_DOCUMENT", "operation: id must be a valid id")
  }
  if (seen.has(op.id))
    fail("INVALID_DOCUMENT", `operation: id "${clip(op.id)}" is used twice in the batch`)
  seen.add(op.id)
  if (!Object.hasOwn(HANDLERS, op.type)) {
    fail("INVALID_DOCUMENT", `operation: unknown type "${clip(String(op.type))}"`)
  }
  if (op.baseRev !== undefined && !Number.isSafeInteger(op.baseRev)) {
    fail("INVALID_DOCUMENT", "operation: baseRev must be an integer")
  }
  if (!isPlainJson(op)) fail("INVALID_DOCUMENT", "operation: payload must be plain JSON")
}

function runOperation(ctx: OpContext, op: Operation): InverseOp[] {
  const handler = HANDLERS[op.type] as (ctx: OpContext, op: Operation) => InverseOp[]
  return handler(ctx, op)
}

/**
 * Applies a batch to a document. Pure and deterministic: the input is never
 * mutated and everything needed (timestamp, ids) is inside the batch. All
 * operations apply in order to a draft; any failure discards the whole batch
 * and throws an AnnotateError carrying the failing operation's index and id.
 * A batch that changes nothing returns the same document, no changes and no
 * inverse. Idempotency windows and undo stacks belong to the store.
 */
export function apply(
  doc: AnnotationDocument,
  batch: Batch,
  options: ApplyOptions = {},
): ApplyResult {
  const limits = resolveLimits(options.limits)
  assertBatch(batch, limits.maxBatchOps)
  const draft = new Draft(doc)
  const ctx: OpContext = { draft, at: batch.at, limits, ignoreRev: options.ignoreRev === true }
  const seen = new Set<string>()
  const groups: { op: Operation; inverse: InverseOp[] }[] = []
  for (const [opIndex, op] of batch.ops.entries()) {
    try {
      assertOperation(op, seen)
      groups.push({ op, inverse: runOperation(ctx, op) })
    } catch (error) {
      if (!(error instanceof AnnotateError)) throw error
      const detail: ErrorDetail = { opIndex }
      if (typeof op === "object" && op !== null && typeof op.id === "string") detail.opId = op.id
      if (error.issues) detail.issues = error.issues
      throw new AnnotateError(error.code, error.message, detail)
    }
  }
  const { doc: next, changes } = draft.finish()
  // Undoing means undoing the last operation first.
  const inverse: Operation[] = []
  for (const { op, inverse: ops } of groups.reverse()) {
    for (const [k, body] of ops.entries()) {
      inverse.push({ ...body, id: deriveId(op.id, k) } as Operation)
    }
  }
  return { doc: next, changes, inverse: next === doc ? [] : inverse }
}
