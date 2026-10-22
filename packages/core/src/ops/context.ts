import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import type { Charge } from "./charge.js"
import type { Draft } from "./draft.js"
import type { DistributiveOmit, Operation } from "./types.js"

// An inverse operation before the engine gives it an id.
export type InverseOp = DistributiveOmit<Operation, "id">

export interface OpContext {
  draft: Draft
  // The batch timestamp.
  at: string
  limits: Limits
  ignoreRev: boolean
  // Spends units of the batch work budget (Limits.maxBatchWork).
  charge: Charge
}

// Fails with REV_CONFLICT when the op expected a different rev of its primary target.
export function checkBaseRev(ctx: OpContext, op: Operation, currentRev: number): void {
  if (ctx.ignoreRev || op.baseRev === undefined || op.baseRev === currentRev) return
  throw new AnnotateError(
    "REV_CONFLICT",
    `Expected rev ${op.baseRev} but the target is at rev ${currentRev}`,
  )
}
