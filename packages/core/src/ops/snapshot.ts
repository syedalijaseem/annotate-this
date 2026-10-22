import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { type InputBudget, STRUCTURE_DEPTH_ALLOWANCE, isPlainContainer } from "../validate/depth.js"

type Container = unknown[] | Record<string, unknown>
type Charge = (units: number) => void

interface Pending {
  source: object
  target: Container
  depth: number
  // Inside a free-form record (meta, attributes, custom geometry data).
  record: boolean
}

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

// Work units (Limits.maxBatchWork, about 40 ns each) per value copied. Values
// inside free-form records are copied, parsed and measured again when stored:
// measured end to end, a key costs about 0.6 µs and an array element about
// 0.1 µs. Objects with many keys are kept as hash tables by the engine, which
// makes every key about three times slower (about 1.8 µs).
export const RECORD_KEY_COST = 16
export const RECORD_ELEMENT_COST = 3
export const LARGE_OBJECT_KEY_COST = 48
const LARGE_OBJECT_KEYS = 1024

// Fields whose values are free-form records, wherever they appear in a payload.
const RECORD_FIELDS: ReadonlySet<string> = new Set(["meta", "attributes", "data"])

// Assigns without invoking the `__proto__` setter, so such a key stays visible to the schemas.
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  } else target[key] = value
}

// Copies plain JSON, counting nodes like findBudgetBreach (containers, keys
// and non-number values) and charging the work budget for each container
// before reading it, so an oversized payload stops early.
class Walker {
  private readonly stack: Pending[] = []
  private nodes = 0

  constructor(
    private readonly budget: InputBudget,
    private readonly charge: Charge,
  ) {}

  copy(value: unknown, depth: number, record: boolean): unknown {
    if (typeof value === "object" && value !== null) return this.enqueue(value, depth, record)
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      this.count(1)
      return value
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value
      throw invalid("numbers must be finite")
    }
    throw invalid("payload must be plain JSON")
  }

  run(): void {
    for (let next = this.stack.pop(); next; next = this.stack.pop()) {
      this.count(1)
      this.charge(1)
      if (Array.isArray(next.target)) this.copyArray(next as Pending & { target: unknown[] })
      else this.copyObject(next)
    }
  }

  private enqueue(source: object, depth: number, record: boolean): Container {
    if (depth > this.budget.depth) throw tooBig("payload is nested too deep")
    if (!isPlainContainer(source)) throw invalid("payload must be plain JSON")
    const target: Container = Array.isArray(source) ? [] : {}
    this.stack.push({ source, target, depth, record })
    return target
  }

  private copyArray({ source, target, depth, record }: Pending & { target: unknown[] }): void {
    const items = source as unknown[]
    const length = items.length
    this.charge(length * (record ? RECORD_ELEMENT_COST : 1))
    for (let i = 0; i < length; i++) {
      const child = items[i]
      if (child === undefined) throw invalid("arrays must not contain undefined")
      target.push(this.copy(child, depth + 1, record))
    }
  }

  private copyObject({ source, target, depth, record }: Pending): void {
    const keys = Object.keys(source)
    if (keys.length > this.budget.entries) {
      throw tooBig(`an object has more than ${this.budget.entries} keys`)
    }
    this.count(keys.length)
    const keyCost =
      keys.length > LARGE_OBJECT_KEYS ? LARGE_OBJECT_KEY_COST : record ? RECORD_KEY_COST : 1
    this.charge(keys.length * keyCost)
    // Each property is read once, before deciding how its value is charged.
    const values = keys.map((key) => (source as Record<string, unknown>)[key])
    // setDocumentMeta's patch is a record itself.
    const metaPatch = depth === 1 && values[keys.indexOf("type")] === "setDocumentMeta"
    for (const [i, key] of keys.entries()) {
      const child = values[i]
      const isRecord = record || RECORD_FIELDS.has(key) || (metaPatch && key === "patch")
      if (child !== undefined)
        define(target as Record<string, unknown>, key, this.copy(child, depth + 1, isRecord))
    }
  }

  private count(nodes: number): void {
    this.nodes += nodes
    if (this.nodes > this.budget.nodes) throw tooBig(`more than ${this.budget.nodes} values`)
  }
}

// Takes one plain-JSON copy of an untrusted operation payload, charging
// `charge` as it goes. Every property is read exactly once (getters and
// proxies cannot change their answer between checks), and the walk enforces
// the document input budget as it goes, so it is iterative, bounded and
// terminates on cyclic input. Object properties that are `undefined` are
// dropped (TypeScript callers write `{ position: undefined }`); `undefined`
// inside an array is rejected.
export function snapshot(value: unknown, budget: InputBudget, charge: Charge): unknown {
  const walker = new Walker(budget, charge)
  const copied = walker.copy(value, 1, false)
  walker.run()
  return copied
}
