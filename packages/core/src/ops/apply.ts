import { safeParse } from "valibot"
import { AnnotateError, type ErrorDetail } from "../errors.js"
import { ID_PATTERN } from "../ids.js"
import { type Limits, resolveLimits } from "../limits.js"
import { TimestampSchema } from "../schema/primitives.js"
import { clip } from "../validate/issues.js"
import type { InverseOp, OpContext } from "./context.js"
import { setDocumentMeta } from "./document-ops.js"
import { type Charge, Draft } from "./draft.js"
import { parseOperation } from "./op-schema.js"
import { createRegion, patchRegion, reorderRegion, setGeometry } from "./region-ops.js"
import { deleteRegion, moveRegionToSource } from "./region-tree.js"
import { payloadBudget, snapshot } from "./snapshot.js"
import type { ApplyOptions, ApplyResult, Batch, Operation, OperationType } from "./types.js"
import { deriveId } from "./util.js"
import type { AnnotationDocument, ID } from "../types.js"

const ORIGINS: ReadonlySet<unknown> = new Set(["local", "remote", "system"])

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

interface BatchView {
  at: string
  ops: ArrayLike<unknown>
  length: number
}

// Reads each batch field exactly once; exotic input (getters, proxies) becomes a typed error.
function readBatch(batch: Batch, maxOps: number): BatchView {
  try {
    if (typeof batch !== "object" || batch === null)
      fail("INVALID_DOCUMENT", "batch: expected an object")
    const { id, origin, at, ops } = batch as unknown as Record<string, unknown>
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      fail("INVALID_DOCUMENT", "batch: id must be a valid id")
    }
    if (!ORIGINS.has(origin)) fail("INVALID_DOCUMENT", "batch: unknown origin")
    if (!safeParse(TimestampSchema, at).success) {
      fail("INVALID_DOCUMENT", "batch: at must be an ISO-8601 timestamp")
    }
    if (!Array.isArray(ops)) fail("INVALID_DOCUMENT", "batch: ops must be an array")
    const length = (ops as unknown[]).length
    if (length === 0) fail("INVALID_DOCUMENT", "batch: needs at least one operation")
    if (length > maxOps) fail("LIMIT_EXCEEDED", `batch: more than ${maxOps} operations`)
    return { at: at as string, ops: ops as unknown[], length }
  } catch (error) {
    if (error instanceof AnnotateError) throw error
    throw new AnnotateError("INVALID_DOCUMENT", "batch: could not be read")
  }
}

function workMeter(max: number): Charge {
  let spent = 0
  return (units) => {
    spent += units
    if (spent > max) fail("LIMIT_EXCEEDED", `batch: needs more than ${max} units of work`)
  }
}

// One private, parsed copy of an untrusted operation: nothing is read from `raw` afterwards.
function prepare(ctx: OpContext, raw: unknown): Operation {
  const copy = snapshot(raw, payloadBudget(ctx.limits))
  ctx.charge(copy.cost)
  return parseOperation(copy.value)
}

function runOperation(ctx: OpContext, op: Operation): InverseOp[] {
  const handler = HANDLERS[op.type] as (ctx: OpContext, op: Operation) => InverseOp[]
  const inverse = handler(ctx, op)
  ctx.draft.endOp()
  return inverse
}

// Adds the operation's index and id; anything that is not an AnnotateError becomes INVALID_DOCUMENT.
function located(error: unknown, opIndex: number, opId: ID | undefined): AnnotateError {
  const detail: ErrorDetail = { opIndex }
  if (opId !== undefined) detail.opId = opId
  if (!(error instanceof AnnotateError)) {
    return new AnnotateError("INVALID_DOCUMENT", "operation: could not be applied", detail)
  }
  if (error.issues) detail.issues = error.issues
  return new AnnotateError(error.code, error.message, detail)
}

interface Applied {
  id: ID
  inverse: InverseOp[]
}

function applyAll(ctx: OpContext, view: BatchView): Applied[] {
  const seen = new Set<string>()
  const applied: Applied[] = []
  for (let opIndex = 0; opIndex < view.length; opIndex++) {
    let opId: ID | undefined
    try {
      const op = prepare(ctx, view.ops[opIndex])
      opId = op.id
      if (seen.has(op.id)) {
        fail("INVALID_DOCUMENT", `operation: id "${clip(op.id)}" is used twice in the batch`)
      }
      seen.add(op.id)
      applied.push({ id: op.id, inverse: runOperation(ctx, op) })
    } catch (error) {
      throw located(error, opIndex, opId)
    }
  }
  return applied
}

// Undoing means undoing the last operation first.
function inverseOf(applied: readonly Applied[], inverseId: (opId: ID, index: number) => ID) {
  const inverse: Operation[] = []
  for (let i = applied.length - 1; i >= 0; i--) {
    const { id, inverse: ops } = applied[i] as Applied
    for (const [k, body] of ops.entries()) {
      const derived = inverseId(id, k)
      if (typeof derived !== "string" || !ID_PATTERN.test(derived)) {
        fail("INVALID_DOCUMENT", "inverseId must return a valid id")
      }
      inverse.push({ ...body, id: derived } as Operation)
    }
  }
  return inverse
}

function contextFor(doc: AnnotationDocument, at: string, limits: Limits, options: ApplyOptions) {
  const charge = workMeter(limits.maxBatchWork)
  const draft = new Draft(doc, charge)
  const ctx: OpContext = { draft, at, limits, ignoreRev: options.ignoreRev === true, charge }
  return ctx
}

/**
 * Applies a batch to a document. Pure and deterministic: the input is never
 * mutated and everything needed (timestamp, ids) is inside the batch. All
 * operations apply in order to a draft; any failure discards the whole batch
 * and throws an AnnotateError carrying the failing operation's index and id.
 * Operation payloads are untrusted: each is copied once, size-checked and
 * schema-parsed before use. A batch that changes nothing returns the same
 * document, no changes and no inverse. Idempotency windows and undo stacks
 * belong to the store.
 */
export function apply(
  doc: AnnotationDocument,
  batch: Batch,
  options: ApplyOptions = {},
): ApplyResult {
  const limits = resolveLimits(options.limits)
  const view = readBatch(batch, limits.maxBatchOps)
  const ctx = contextFor(doc, view.at, limits, options)
  const applied = applyAll(ctx, view)
  const { doc: next, changes } = ctx.draft.finish()
  if (next === doc) return { doc, changes, inverse: [] }
  return { doc: next, changes, inverse: inverseOf(applied, options.inverseId ?? deriveId) }
}
