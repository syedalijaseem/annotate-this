import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  // Emit the declaration map that the sourceMappingURL comment in index.d.ts
  // names (it is shipped with dist), instead of leaving the comment dangling.
  dts: { sourcemap: true },
  clean: true,
  sourcemap: true,
})
