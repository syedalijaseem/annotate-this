import { AnnotateError } from "../errors.js"
import type { JSONValue } from "../types.js"
import { nestingDepth } from "../validate/depth.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import { mergeMap } from "./patch.js"
import type { SetDocumentMetaOp } from "./types.js"

// Document meta is one level of nesting itself, so each value may nest one level less than maxMetaDepth.
function assertMetaDepth(ctx: OpContext, patch: Record<string, JSONValue | null>): void {
  const allowed = ctx.limits.maxMetaDepth - 1
  for (const value of Object.values(patch)) {
    if (nestingDepth(value, allowed) > allowed) {
      throw new AnnotateError(
        "LIMIT_EXCEEDED",
        `meta: value is nested deeper than ${ctx.limits.maxMetaDepth} levels`,
      )
    }
  }
}

export function setDocumentMeta(ctx: OpContext, op: SetDocumentMetaOp): InverseOp[] {
  const { draft } = ctx
  checkBaseRev(ctx, op, draft.original.rev)
  assertMetaDepth(ctx, op.patch)
  const undo: Record<string, JSONValue | null> = {}
  const next = mergeMap<JSONValue>(ctx, draft.view.meta, op.patch, undo)
  if (!next) return []
  draft.setDocumentMeta(next)
  return [{ type: "setDocumentMeta", patch: undo }]
}
