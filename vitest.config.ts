import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      // fixture project — runs the fixture app's own suite (express@4)
      {
        test: {
          name: "fixture",
          include: ["fixtures/express4/tests/**/*.test.{js,ts}"],
          environment: "node",
          pool: "forks",
          // Make require() resolve from the fixture's own node_modules
          server: {
            deps: {
              inline: ["express"],
            },
          },
        },
      },
      // ledger phase tests
      {
        test: {
          name: "ledger",
          include: ["tests/ledger/**/*.test.ts"],
          environment: "node",
        },
      },
      // scanner phase tests
      {
        test: {
          name: "scanner",
          include: ["tests/scanner/**/*.test.ts"],
          environment: "node",
        },
      },
      // plan phase tests
      {
        test: {
          name: "plan",
          include: ["tests/plan/**/*.test.ts"],
          environment: "node",
        },
      },
      // fixer phase tests
      {
        test: {
          name: "fixer",
          include: ["tests/fixer/**/*.test.ts"],
          environment: "node",
        },
      },
      // verify phase tests
      {
        test: {
          name: "verify",
          include: ["tests/verify/**/*.test.ts"],
          environment: "node",
        },
      },
      // report phase tests
      {
        test: {
          name: "report",
          include: ["tests/report/**/*.test.ts"],
          environment: "node",
        },
      },
    ],
  },
});
