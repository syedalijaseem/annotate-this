import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { type CopyBreach, JsonCopier, type NotJson } from "../validate/copy.js"
import { type InputBudget, STRUCTURE_DEPTH_ALLOWANCE } from "../validate/depth.js"
import type { Charge } from "./charge.js"

const invalid = (message: string): AnnotateError =>
  new AnnotateError("INVALID_DOCUMENT", `operation: ${message}`)

const tooBig = (message: string): AnnotateError =>
  new AnnotateError("LIMIT_EXCEEDED", `operation: ${message}`)

// The same budget parseDocument applies to a whole document.
export const payloadBudget = (limits: Limits): InputBudget => ({
  depth: limits.maxMetaDepth + STRUCTURE_DEPTH_ALLOWANCE,
  nodes: limits.maxDocumentNodes,
  entries: limits.maxEntries,
})

// Work units (see Limits.maxBatchWork) per value copied. Values inside
// free-form records are copied, parsed and measured again when stored:
// measured end to end, a key costs about 0.6 µs and an array element about
// 0.1 µs. Objects with many keys are kept as hash tables by the engine, which
// makes every key about three times slower (about 1.8 µs).
const RECORD_KEY_COST = 16
const RECORD_ELEMENT_COST = 3
const LARGE_OBJECT_KEY_COST = 48
const LARGE_OBJECT_KEYS = 1024

// Fields whose values are free-form records, wherever they appear in a payload.
const RECORD_FIELDS: ReadonlySet<string> = /* @__PURE__ */ new Set(["meta", "attributes", "data"])

const NOT_JSON: Record<NotJson, string> = {
  number: "numbers must be finite",
  undefined: "arrays must not contain undefined",
  value: "payload must be plain JSON",
}

// Copies an operation payload, charging the work budget for each container
// before reading it, so an oversized payload stops early. Non-JSON values fail
// at once; object members that are `undefined` are dropped (TypeScript callers
// write `{ position: undefined }`).
class PayloadCopier extends JsonCopier {
  // setDocumentMeta's patch is a record itself.
  private metaPatch = false

  constructor(
    budget: InputBudget,
    private readonly charge: Charge,
  ) {
    super(budget, true)
  }

  protected breach(kind: CopyBreach): Error {
    if (kind === "depth") return tooBig("payload is nested too deep")
    if (kind === "entries") return tooBig(`an object has more than ${this.budget.entries} keys`)
    return tooBig(`more than ${this.budget.nodes} values`)
  }

  protected notJson(kind: NotJson): void {
    throw invalid(NOT_JSON[kind])
  }

  protected undefinedMember(): void {}

  protected override onContainer(): void {
    this.charge(1)
  }

  protected override onItems(length: number, record: boolean): void {
    this.charge(length * (record ? RECORD_ELEMENT_COST : 1))
  }

  protected override onKeys(count: number, record: boolean): void {
    const cost = count > LARGE_OBJECT_KEYS ? LARGE_OBJECT_KEY_COST : record ? RECORD_KEY_COST : 1
    this.charge(count * cost)
  }

  protected override onRoot(keys: readonly string[], values: readonly unknown[]): void {
    this.metaPatch = values[keys.indexOf("type")] === "setDocumentMeta"
  }

  protected override isRecord(record: boolean, key: string, depth: number): boolean {
    return record || RECORD_FIELDS.has(key) || (this.metaPatch && depth === 1 && key === "patch")
  }
}

// Takes one plain-JSON copy of an untrusted operation payload (see JsonCopier),
// charging `charge` as it goes. `undefined` inside an array is rejected.
export function snapshot(value: unknown, budget: InputBudget, charge: Charge): unknown {
  return new PayloadCopier(budget, charge).take(value)
}
