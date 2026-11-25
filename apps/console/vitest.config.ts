import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/runner/**/*.ts", "src/data/plan.ts", "src/data/seed.ts", "src/judge.ts"],
      exclude: ["src/runner/firestoreQueue.ts"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
      reporter: ["text", "json-summary"],
    },
  },
});
