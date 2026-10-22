import { AnnotateError } from "../errors.js"
import { isForbiddenKey } from "../schema/primitives.js"
import type { AttributeDef, ClassDef } from "../types.js"
import { clip, own } from "../validate/issues.js"
import { attributeProblem } from "../validate/labels.js"
import { checkConfigRev, storeDef } from "./config-ops.js"
import type { InverseOp, OpContext } from "./context.js"
import { inUse, needDef } from "./entities.js"
import type { RemoveAttributeDefOp, SetAttributeDefOp } from "./types.js"
import { type Holder, SCAN_COST, anyUse, assertNoTrackChanges, detach, findUses } from "./uses.js"
import { deepEqual } from "./util.js"

// A replaced definition must still accept every stored value (read-only over tracks).
function assertValuesHold(ctx: OpContext, def: AttributeDef): void {
  const uses = findUses(ctx, (h) => {
    const value = own(h.attributes, def.key)
    return value !== undefined && attributeProblem(def, value) !== null
  })
  const user = uses.regions[0] ?? uses.tracks[0] ?? uses.sources[0]
  if (user) throw inUse(`"${user.id}" has a value the new definition of "${def.key}" rejects`)
}

export function setAttributeDef(ctx: OpContext, op: SetAttributeDefOp): InverseOp[] {
  const { def } = op
  checkConfigRev(ctx, op)
  // Attribute keys are record keys, so prototype names are refused like entity ids.
  if (isForbiddenKey(def.key)) {
    throw new AnnotateError("INVALID_DOCUMENT", `Attribute key "${clip(def.key)}" is reserved`)
  }
  const current = ctx.draft.def("attributes", def.key)
  if (current && deepEqual(current, def)) return []
  if (current) assertValuesHold(ctx, def)
  storeDef(ctx, "attributes", def.key, def)
  return current
    ? [{ type: "setAttributeDef", def: current }]
    : [{ type: "removeAttributeDef", key: def.key, onInUse: "reject" }]
}

// Classes whose attributeKeys list `key`, charged by the lists scanned.
function listingClasses(ctx: OpContext, key: string): ClassDef[] {
  const classes = Object.values(ctx.draft.view.config.classes)
  ctx.charge(SCAN_COST * classes.length)
  return classes.filter((c) => {
    ctx.charge(c.attributeKeys?.length ?? 0)
    return c.attributeKeys?.includes(key) === true
  })
}

// Drops `key` from the classes' attributeKeys and returns the steps that put it back.
function unlist(ctx: OpContext, classes: readonly ClassDef[], key: string): InverseOp[] {
  return classes.map((def): InverseOp => {
    const keys = def.attributeKeys ?? []
    ctx.draft.putDef("classes", def.id, { ...def, attributeKeys: keys.filter((k) => k !== key) })
    return { type: "updateClass", classId: def.id, patch: { attributeKeys: keys } }
  })
}

export function removeAttributeDef(ctx: OpContext, op: RemoveAttributeDefOp): InverseOp[] {
  const def = needDef(ctx, "attributes", op.key)
  checkConfigRev(ctx, op)
  const uses = findUses(ctx, (h: Holder) => own(h.attributes, op.key) !== undefined)
  assertNoTrackChanges(uses)
  const classes = listingClasses(ctx, op.key)
  if (op.onInUse === "reject" && (anyUse(uses) || classes.length > 0)) {
    throw inUse(`Attribute "${op.key}" is still used`)
  }
  const steps = [
    ...unlist(ctx, classes, op.key),
    ...detach(ctx, uses, () => ({ attributes: { [op.key]: null } })),
  ]
  ctx.draft.removeDef("attributes", op.key)
  return [{ type: "setAttributeDef", def }, ...steps]
}
