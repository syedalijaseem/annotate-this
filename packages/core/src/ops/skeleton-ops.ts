import type { ID, Skeleton } from "../types.js"
import { checkConfigRev, storeDef } from "./config-ops.js"
import type { InverseOp, OpContext } from "./context.js"
import { assertUsableId, inUse, needDef } from "./entities.js"
import { applyPatch } from "./patch.js"
import type { AddSkeletonOp, RemoveSkeletonOp, SkeletonPatch, UpdateSkeletonOp } from "./types.js"
import { findAnnotationUses, geometriesOf } from "./uses.js"

// Fails with IN_USE when a region or track keyframe has keypoints on the skeleton.
function assertUnused(ctx: OpContext, id: ID, why: string): void {
  const { regions, tracks } = findAnnotationUses(ctx, (a) =>
    geometriesOf(ctx, a).some((g) => g.type === "keypoints" && g.skeletonId === id),
  )
  const user = regions[0] ?? tracks[0]
  if (user) throw inUse(`Skeleton "${id}" is used by "${user.id}"; ${why}`)
}

export function addSkeleton(ctx: OpContext, op: AddSkeletonOp): InverseOp[] {
  checkConfigRev(ctx, op)
  assertUsableId(ctx, op.def.id)
  storeDef(ctx, "skeletons", op.def.id, op.def)
  return [{ type: "removeSkeleton", skeletonId: op.def.id }]
}

export function updateSkeleton(ctx: OpContext, op: UpdateSkeletonOp): InverseOp[] {
  const current = needDef(ctx, "skeletons", op.skeletonId)
  checkConfigRev(ctx, op)
  const result = applyPatch<Skeleton>(ctx, current, op.patch)
  if (!result) return []
  // Keypoints geometry stores 3 numbers per skeleton point, so the count is fixed while used.
  if (result.next.points.length !== current.points.length) {
    assertUnused(ctx, op.skeletonId, "its point count cannot change")
  }
  storeDef(ctx, "skeletons", op.skeletonId, result.next)
  return [
    { type: "updateSkeleton", skeletonId: op.skeletonId, patch: result.undo as SkeletonPatch },
  ]
}

export function removeSkeleton(ctx: OpContext, op: RemoveSkeletonOp): InverseOp[] {
  const def = needDef(ctx, "skeletons", op.skeletonId)
  checkConfigRev(ctx, op)
  assertUnused(ctx, op.skeletonId, "it cannot be removed")
  ctx.draft.removeDef("skeletons", op.skeletonId)
  return [{ type: "addSkeleton", def }]
}
