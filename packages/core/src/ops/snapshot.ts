import { AnnotateError } from "../errors.js"
import type { Limits } from "../limits.js"
import { type InputBudget, STRUCTURE_DEPTH_ALLOWANCE, isPlainContainer } from "../validate/depth.js"

type Container = unknown[] | Record<string, unknown>

interface Pending {
  source: object
  target: Container
  depth: number
}

export interface Snapshot {
  value: unknown
  // Values visited (numbers included), for the batch work budget.
  cost: number
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

// Counts like findBudgetBreach: containers, keys and non-number values are nodes.
class Walker {
  private readonly stack: Pending[] = []
  private nodes = 0
  cost = 1

  constructor(private readonly budget: InputBudget) {}

  copy(value: unknown, depth: number): unknown {
    if (typeof value === "object" && value !== null) return this.enqueue(value, depth)
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
      if (Array.isArray(next.target))
        this.copyArray(next.source as unknown[], next.target, next.depth)
      else this.copyObject(next.source, next.target, next.depth)
    }
  }

  private enqueue(source: object, depth: number): Container {
    if (depth > this.budget.depth) throw tooBig("payload is nested too deep")
    if (!isPlainContainer(source)) throw invalid("payload must be plain JSON")
    const target: Container = Array.isArray(source) ? [] : {}
    this.stack.push({ source, target, depth })
    return target
  }

  private copyArray(source: unknown[], target: unknown[], depth: number): void {
    const length = source.length
    this.cost += length
    for (let i = 0; i < length; i++) {
      const child = source[i]
      if (child === undefined) throw invalid("arrays must not contain undefined")
      target.push(this.copy(child, depth + 1))
    }
  }

  private copyObject(source: object, target: Record<string, unknown>, depth: number): void {
    const keys = Object.keys(source)
    if (keys.length > this.budget.entries) {
      throw tooBig(`an object has more than ${this.budget.entries} keys`)
    }
    this.count(keys.length)
    this.cost += keys.length
    for (const key of keys) {
      const child = (source as Record<string, unknown>)[key]
      if (child !== undefined) define(target, key, this.copy(child, depth + 1))
    }
  }

  private count(nodes: number): void {
    this.nodes += nodes
    if (this.nodes > this.budget.nodes) throw tooBig(`more than ${this.budget.nodes} values`)
  }
}

// Takes one plain-JSON copy of an untrusted operation payload. Every property
// is read exactly once (getters and proxies cannot change their answer
// between checks), and the walk enforces the document input budget as it
// goes, so it is iterative, bounded and terminates on cyclic input. Object
// properties that are `undefined` are dropped (TypeScript callers write
// `{ position: undefined }`); `undefined` inside an array is rejected.
export function snapshot(value: unknown, budget: InputBudget): Snapshot {
  const walker = new Walker(budget)
  const copied = walker.copy(value, 1)
  walker.run()
  return { value: copied, cost: walker.cost }
}
