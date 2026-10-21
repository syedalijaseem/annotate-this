// Fails if any production dependency uses a license outside the allowlist (ADR 0003).
import { execFileSync } from "node:child_process"

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "BlueOak-1.0.0",
])

const raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  encoding: "utf8",
})
const byLicense = JSON.parse(raw)
const bad = Object.keys(byLicense).filter((license) => !ALLOWED.has(license))

if (bad.length > 0) {
  console.error(`Disallowed production licenses: ${bad.join(", ")}`)
  process.exit(1)
}
console.log(`Production licenses OK (${Object.keys(byLicense).join(", ") || "no dependencies"})`)
