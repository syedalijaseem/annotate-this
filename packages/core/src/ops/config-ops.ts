import { AnnotateError } from "../errors.js"
import { DEFAULT_STATUSES } from "../schema/config.js"
import type { ClassDef, Config, Skeleton } from "../types.js"
import { countNodes } from "../validate/depth.js"
import { type Issue, clip, pushAll } from "../validate/issues.js"
import { attributeDefProblems, duplicateKeyIssue } from "../validate/labels.js"
import { configStrings, defStrings, metaDepthIssues, textLimit } from "../validate/limit-checks.js"
import { classRefIssues, skeletonIssues, statusSet } from "../validate/references.js"
import { LEVELS, assertDepth } from "./check.js"
import { type InverseOp, type OpContext, checkBaseRev } from "./context.js"
import type { Def, DefKind } from "./draft.js"
import { assertNone, inUse } from "./entities.js"
import { applyPatch } from "./patch.js"
import type { ConfigPatch, Operation, SetConfigOp } from "./types.js"
import { SCAN_COST, assertAreaHolds, findAnnotationUses } from "./uses.js"

// Every config operation targets the config: baseRev is checked against config.rev.
export const checkConfigRev = (ctx: OpContext, op: Operation): void =>
  checkBaseRev(ctx, op, ctx.draft.view.config.rev)

// The parseDocument rules for one config entry as it would be stored.
function defIssues<K extends DefKind>(ctx: OpContext, kind: K, key: string, def: Def<K>): Issue[] {
  const doc = ctx.draft.view
  const issues: Issue[] = []
  defStrings(textLimit(issues), kind, key, def, ctx.limits.maxStringLength)
  if (kind === "classes") {
    pushAll(issues, classRefIssues(doc, key, def as ClassDef))
    pushAll(issues, duplicateKeyIssue(key, def as ClassDef))
  }
  if (kind === "classes" || kind === "tags") {
    const { meta } = def as ClassDef
    pushAll(issues, metaDepthIssues(`config.${kind}.${key}.meta`, meta, ctx.limits))
  }
  if (kind === "attributes") pushAll(issues, attributeDefProblems(key, def as Def<"attributes">))
  if (kind === "skeletons") pushAll(issues, skeletonIssues(key, def as Skeleton))
  return issues
}

// Validates a new or changed definition and stores it (the config rev moves in endOp).
export function storeDef<K extends DefKind>(ctx: OpContext, kind: K, key: string, def: Def<K>) {
  const { draft, limits } = ctx
  ctx.charge(countNodes(def))
  assertDepth(def, limits, LEVELS.definition, `config.${kind}`)
  if (!draft.def(kind, key) && draft.defCount(kind) + 1 > limits.maxEntries) {
    // Each config record is one object, so it is bound by maxEntries.
    throw new AnnotateError(
      "LIMIT_EXCEEDED",
      `config.${kind}: more than ${limits.maxEntries} entries`,
    )
  }
  assertNone(defIssues(ctx, kind, key, def))
  draft.putDef(kind, key, def)
}

// Clearing the statuses falls back to the defaults, which existing annotations must also satisfy.
function assertStatusesHold(ctx: OpContext, next: Config): void {
  const allowed = statusSet(next.statuses ?? DEFAULT_STATUSES)
  const { regions, tracks } = findAnnotationUses(ctx, (a) => !allowed.has(a.status))
  const user = regions[0] ?? tracks[0]
  if (user) throw inUse(`Status "${clip(user.status)}" is still used by "${user.id}"`)
}

// A new config area applies to every source without its own area.
function assertConfigAreaHolds(ctx: OpContext, next: Config): void {
  const { sources } = ctx.draft.view
  ctx.charge(SCAN_COST * ctx.draft.view.sourceOrder.length)
  for (const source of Object.values(sources)) {
    if (!source.allowedArea) assertAreaHolds(ctx, source, next.allowedArea)
  }
}

export function setConfig(ctx: OpContext, op: SetConfigOp): InverseOp[] {
  const { draft, limits } = ctx
  checkConfigRev(ctx, op)
  for (const field of ["allowedArea", "meta"] as const) {
    const value = op.patch[field]
    if (value) assertDepth(value, limits, LEVELS.configField, `config.${field}`)
  }
  const result = applyPatch(ctx, draft.view.config, op.patch)
  if (!result) return []
  const { next, undo } = result
  const issues = "meta" in undo ? metaDepthIssues("config.meta", next.meta, limits) : []
  configStrings(textLimit(issues), next, limits)
  assertNone(issues)
  if ("statuses" in undo) assertStatusesHold(ctx, next)
  if ("allowedArea" in undo) assertConfigAreaHolds(ctx, next)
  draft.replaceConfig(next)
  return [{ type: "setConfig", patch: undo as ConfigPatch }]
}
