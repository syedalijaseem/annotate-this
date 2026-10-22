import { type InputBudget, isPlainContainer } from "./depth.js"
import { MAX_NUMBER_BYTES, commas, jsonStringBytes, measure } from "./json-size.js"

type Container = unknown[] | Record<string, unknown>

interface Pending {
  source: object
  // The copy being filled; undefined when only checking.
  target: Container | undefined
  depth: number
  // Inside a free-form record (meta, attributes, custom geometry data).
  record: boolean
}

// What made a value not plain JSON.
export type NotJson = "number" | "undefined" | "value"

// The budget a walk exceeded.
export type CopyBreach = "depth" | "nodes" | "entries" | "bytes"

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

// Takes one plain-JSON copy of untrusted input: own enumerable string keys
// only (Object.keys), every property read exactly once (getters and proxies
// cannot change their answer between checks), fresh plain containers. The walk
// is iterative and enforces the input budget as it goes, counting nodes as
// countNodes does (containers, keys and non-number values; plain numbers are
// free), so it is bounded and terminates on cyclic input. It also adds up the
// compact JSON.stringify size and stops once that certainly exceeds maxBytes.
// Subclasses decide what a breach or a non-JSON value means, and may charge
// work as the walk goes.
export abstract class JsonCopier {
  private readonly stack: Pending[] = []
  private nodes = 0
  // Compact JSON bytes of everything except numbers, and how many numbers were seen.
  private textBytes = 0
  private numbers = 0
  private readonly measuring: boolean

  constructor(
    protected readonly budget: InputBudget,
    // false: check and measure only, without building a copy.
    private readonly build: boolean,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
  ) {
    this.measuring = maxBytes !== Number.POSITIVE_INFINITY
  }

  // The error to throw for an exceeded budget.
  protected abstract breach(kind: CopyBreach): Error
  // A value that is not plain JSON: throw, or note it and let the walk go on.
  protected abstract notJson(kind: NotJson): void
  // An object member whose value is undefined (JSON.stringify leaves it out).
  protected abstract undefinedMember(): void
  // Optional hooks. Work charges, free when absent:
  protected onContainer?(): void
  protected onItems?(length: number, record: boolean): void
  protected onKeys?(count: number, record: boolean): void
  // The members of the root object, read once, before anything below it is copied.
  protected onRoot?(keys: readonly string[], values: readonly unknown[]): void
  // Whether member `key` of an object at `depth` holds a free-form record
  // (absent: only inside a record already).
  protected isRecord?(record: boolean, key: string, depth: number): boolean

  // The copy of `value` (undefined when not building one).
  take(value: unknown): unknown {
    const copied = this.copy(value, 1, false)
    for (let next = this.stack.pop(); next; next = this.stack.pop()) {
      this.count(1)
      this.onContainer?.()
      if (Array.isArray(next.source)) this.copyArray(next)
      else this.copyObject(next)
      if (this.textBytes + this.numbers > this.maxBytes) throw this.breach("bytes")
    }
    return copied
  }

  // Whether `value` (the input or its copy) is more than maxBytes of compact
  // JSON. Exact, and cheap unless the input is close to the limit: numbers are
  // only written out when their longest possible text could matter.
  exceedsBytes(value: unknown): boolean {
    if (this.textBytes + this.numbers > this.maxBytes) return true
    if (this.textBytes + this.numbers * MAX_NUMBER_BYTES <= this.maxBytes) return false
    return measure(value).bytes > this.maxBytes
  }

  protected count(nodes: number): void {
    this.nodes += nodes
    if (this.nodes > this.budget.nodes) throw this.breach("nodes")
  }

  private copy(value: unknown, depth: number, record: boolean): unknown {
    if (typeof value === "object" && value !== null) return this.enqueue(value, depth, record)
    if (typeof value === "number") {
      if (Number.isFinite(value)) {
        this.numbers += 1
        return value
      }
      this.notJson("number")
      return null
    }
    this.count(1)
    if (typeof value === "string") {
      if (this.measuring) this.textBytes += jsonStringBytes(value)
    } else if (value === null || value === true) this.textBytes += 4
    else if (value === false) this.textBytes += 5
    else {
      this.notJson(value === undefined ? "undefined" : "value")
      return null
    }
    return value
  }

  private enqueue(source: object, depth: number, record: boolean): Container | undefined {
    if (depth > this.budget.depth) throw this.breach("depth")
    if (!isPlainContainer(source)) {
      this.count(1)
      this.notJson("value")
      return undefined
    }
    const target: Container | undefined = this.build ? (Array.isArray(source) ? [] : {}) : undefined
    this.stack.push({ source, target, depth, record })
    return target
  }

  private copyArray({ source, target, depth, record }: Pending): void {
    const items = source as unknown[]
    const length = items.length
    this.onItems?.(length, record)
    this.textBytes += 2 + commas(length)
    for (let i = 0; i < length; i++) {
      const child = this.copy(items[i], depth + 1, record)
      if (target) (target as unknown[]).push(child)
    }
  }

  private copyObject({ source, target, depth, record }: Pending): void {
    const keys = Object.keys(source)
    if (keys.length > this.budget.entries) throw this.breach("entries")
    this.count(keys.length)
    this.onKeys?.(keys.length, record)
    const values = keys.map((key) => (source as Record<string, unknown>)[key])
    if (depth === 1) this.onRoot?.(keys, values)
    let members = 0
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string
      const child = values[i]
      if (child === undefined) {
        this.undefinedMember()
        continue
      }
      members += 1
      if (this.measuring) this.textBytes += jsonStringBytes(key) + 1
      const inRecord = this.isRecord ? this.isRecord(record, key, depth) : record
      const copied = this.copy(child, depth + 1, inRecord)
      if (target) define(target as Record<string, unknown>, key, copied)
    }
    this.textBytes += 2 + commas(members)
  }
}
