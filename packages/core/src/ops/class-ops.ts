import type { ClassDef, GeometryType, ID, TagDef } from "../types.js"
import { checkConfigRev, storeDef } from "./config-ops.js"
import type { InverseOp, OpContext } from "./context.js"
import { assertUsableId, inUse, needDef, reorderIn } from "./entities.js"
import { insertAt, insertionIndex, removeEntries } from "./order.js"
import { applyPatch } from "./patch.js"
import { assertNoCycle } from "./region-tree.js"
import type {
  AddClassOp,
  AddTagOp,
  ClassPatch,
  InUsePolicy,
  Position,
  RemoveClassOp,
  RemoveTagOp,
  ReorderClassOp,
  ReorderTagOp,
  TagPatch,
  UpdateClassOp,
  UpdateTagOp,
} from "./types.js"
import {
  SCAN_COST,
  anyUse,
  assertNoTrackChanges,
  detach,
  findAnnotationUses,
  findUses,
  geometriesOf,
} from "./uses.js"

// Classes and tags behave alike: a definition record plus a config ordering.
type LabelKind = "classes" | "tags"
const ORDER = { classes: "classOrder", tags: "tagOrder" } as const

function addLabel(ctx: OpContext, kind: LabelKind, def: ClassDef | TagDef, position?: Position) {
  const { draft } = ctx
  assertUsableId(ctx, def.id)
  const order = draft.view.config[ORDER[kind]]
  const index = insertionIndex(ctx.charge, order, def.id, position ?? "top")
  storeDef(ctx, kind, def.id, def)
  insertAt(ctx.charge, draft.order(ORDER[kind]), index, def.id)
}

export function addClass(ctx: OpContext, op: AddClassOp): InverseOp[] {
  checkConfigRev(ctx, op)
  addLabel(ctx, "classes", op.def, op.position)
  return [{ type: "removeClass", classId: op.def.id, onInUse: "reject" }]
}

export function addTag(ctx: OpContext, op: AddTagOp): InverseOp[] {
  checkConfigRev(ctx, op)
  addLabel(ctx, "tags", op.def, op.position)
  return [{ type: "removeTag", tagId: op.def.id, onInUse: "reject" }]
}

// Narrowing allowedGeometry must not invalidate regions or tracks of the class (read-only over tracks).
function assertGeometryAllowed(ctx: OpContext, id: ID, allowed: readonly GeometryType[]): void {
  const types = new Set(allowed)
  const { regions, tracks } = findAnnotationUses(
    ctx,
    (a) => a.classId === id && geometriesOf(ctx, a).some((g) => !types.has(g.type)),
  )
  const user = regions[0] ?? tracks[0]
  if (user) throw inUse(`"${user.id}" has a geometry type the class would no longer allow`)
}

export function updateClass(ctx: OpContext, op: UpdateClassOp): InverseOp[] {
  const current = needDef(ctx, "classes", op.classId)
  checkConfigRev(ctx, op)
  const result = applyPatch(ctx, current, op.patch)
  if (!result) return []
  const { next, undo } = result
  if (next.parentId !== undefined && "parentId" in undo) {
    const parentOf = (of: ID) => ctx.draft.def("classes", of)?.parentId
    assertNoCycle(ctx, op.classId, next.parentId, parentOf, ctx.draft.defCount("classes"))
  }
  if (next.allowedGeometry && "allowedGeometry" in undo) {
    assertGeometryAllowed(ctx, op.classId, next.allowedGeometry)
  }
  storeDef(ctx, "classes", op.classId, next)
  return [{ type: "updateClass", classId: op.classId, patch: undo as ClassPatch }]
}

export function updateTag(ctx: OpContext, op: UpdateTagOp): InverseOp[] {
  const current = needDef(ctx, "tags", op.tagId)
  checkConfigRev(ctx, op)
  const result = applyPatch(ctx, current, op.patch)
  if (!result) return []
  storeDef(ctx, "tags", op.tagId, result.next)
  return [{ type: "updateTag", tagId: op.tagId, patch: result.undo as TagPatch }]
}

// Removes the definition and its order entry; returns the position that restores it.
function dropLabel(ctx: OpContext, kind: LabelKind, id: ID): Position {
  const { draft } = ctx
  const [restore] = removeEntries(ctx.charge, draft.order(ORDER[kind]), [id])
  draft.removeDef(kind, id)
  return restore ?? "top"
}

// Regions and sources lose the reference under "detach"; anything else in use fails.
function releaseUses(
  ctx: OpContext,
  policy: InUsePolicy,
  test: Parameters<typeof findUses>[1],
  patchOf: Parameters<typeof detach>[2],
) {
  const uses = findUses(ctx, test)
  assertNoTrackChanges(uses)
  if (policy === "reject" && anyUse(uses)) throw inUse("Still used by regions or sources")
  return detach(ctx, uses, patchOf)
}

// Child classes move up to the removed class's parent (under either policy).
function reparentChildren(ctx: OpContext, def: ClassDef): InverseOp[] {
  const steps: InverseOp[] = []
  const classes = Object.values(ctx.draft.view.config.classes)
  ctx.charge(SCAN_COST * classes.length)
  for (const child of classes) {
    if (child.parentId !== def.id) continue
    const result = applyPatch(ctx, child, { parentId: def.parentId ?? null }) as { next: ClassDef }
    ctx.draft.putDef("classes", child.id, result.next)
    steps.push({ type: "updateClass", classId: child.id, patch: { parentId: def.id } })
  }
  return steps
}

export function removeClass(ctx: OpContext, op: RemoveClassOp): InverseOp[] {
  const def = needDef(ctx, "classes", op.classId)
  checkConfigRev(ctx, op)
  const users = releaseUses(
    ctx,
    op.onInUse,
    (h) => h.classId === op.classId,
    () => ({ classId: null }),
  )
  const children = reparentChildren(ctx, def)
  const position = dropLabel(ctx, "classes", op.classId)
  return [{ type: "addClass", def, position }, ...children, ...users]
}

export function removeTag(ctx: OpContext, op: RemoveTagOp): InverseOp[] {
  const def = needDef(ctx, "tags", op.tagId)
  checkConfigRev(ctx, op)
  const has = (tagIds: readonly ID[]) => {
    ctx.charge(tagIds.length)
    return tagIds.includes(op.tagId)
  }
  const users = releaseUses(
    ctx,
    op.onInUse,
    (h) => has(h.tagIds),
    (h) => ({
      tagIds: h.tagIds.filter((tagId) => tagId !== op.tagId),
    }),
  )
  const position = dropLabel(ctx, "tags", op.tagId)
  return [{ type: "addTag", def, position }, ...users]
}

export function reorderClass(ctx: OpContext, op: ReorderClassOp): InverseOp[] {
  needDef(ctx, "classes", op.classId)
  checkConfigRev(ctx, op)
  const restore = reorderIn(ctx, "classOrder", op.classId, op.position)
  return restore ? [{ type: "reorderClass", classId: op.classId, position: restore }] : []
}

export function reorderTag(ctx: OpContext, op: ReorderTagOp): InverseOp[] {
  needDef(ctx, "tags", op.tagId)
  checkConfigRev(ctx, op)
  const restore = reorderIn(ctx, "tagOrder", op.tagId, op.position)
  return restore ? [{ type: "reorderTag", tagId: op.tagId, position: restore }] : []
}
