// tests/core/manifest.test.ts
// §9.4 acceptance: the manifest bump, and its I2/I1 constraints.
//
// The bump is a REAL edit, so it is held to the same standard as any fixer edit:
// it is plan-driven, it carries a citation, it is a no-op when already correct,
// and it never touches git.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

import { SANDBOX_ROOT } from "../helpers/sandbox.js";
import {
  bumpManifest,
  readDeclaredVersion,
  manifestCandidates,
  manifestCommitMessage,
} from "../../src/core/manifest.js";
import type { PlanItem } from "../../src/docs/schemas.js";

// Vitest runs test FILES in parallel, so teardown removes ONLY this file's sandbox
// directory. Wiping the shared root would delete a sibling file's in-flight fixtures.
let current = "";

function repo(): string {
  mkdirSync(SANDBOX_ROOT, { recursive: true });
  const dir = join(SANDBOX_ROOT, `manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  current = dir;
  return dir;
}

const PLAN_ITEM = {
  id: "EX-18",
  title: "Node.js 18+ required",
  kind: "manual",
  severity: "medium",
  match: { include: ["package.json"], exclude: [] },
  fix: { instruction: "Bump the declared express version to 5.1.0", manual: true },
  citation: {
    docId: "express5",
    page: 3,
    sectionTitle: "Node.js version",
    locator: "express5.md §Node.js version",
    quote: "Express 5 requires Node.js version 18 or higher.",
  },
  hState: "H1",
} as unknown as PlanItem;

beforeEach(() => mkdirSync(SANDBOX_ROOT, { recursive: true }));
afterEach(() => {
  if (current && existsSync(current)) {
    rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  current = "";
});

describe("§9.4 — manifest bump", () => {
  it("bumps dependencies and leaves the rest of package.json intact", () => {
    const root = repo();
    const original = {
      name: "fixture-app",
      scripts: { test: "vitest run" },
      dependencies: { express: "4.18.2", supertest: "^7.0.0" },
      devDependencies: { vitest: "^2.1.9" },
    };
    writeFileSync(join(root, "package.json"), `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const { bump, written } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: true,
    });

    expect(written).toBe(true);
    expect(bump.changed).toBe(true);
    expect(bump.file).toBe("package.json");
    expect(bump.from).toBe("4.18.2");
    expect(bump.to).toBe("5.1.0");

    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as typeof original;
    expect(after.dependencies.express).toBe("5.1.0");
    // Nothing else moved.
    expect(after.dependencies.supertest).toBe("^7.0.0");
    expect(after.devDependencies.vitest).toBe("^2.1.9");
    expect(after.name).toBe("fixture-app");
    expect(after.scripts.test).toBe("vitest run");
  });

  it("carries the plan item's citation (I2)", () => {
    const root = repo();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "4.18.2" } }, null, 2),
      "utf8"
    );
    const { bump } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: true,
    });
    expect(bump.itemId).toBe("EX-18");
    expect(bump.citationRef).toContain("Node.js version");
  });

  it("is a NO-OP when the manifest already declares the target version", () => {
    const root = repo();
    const contents = JSON.stringify({ dependencies: { express: "^5.1.0" } }, null, 2);
    writeFileSync(join(root, "package.json"), contents, "utf8");

    const { bump, written } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: true,
    });

    // Honest: no change claimed, file byte-identical.
    expect(bump.changed).toBe(false);
    expect(written).toBe(false);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(contents);
  });

  it("strips a leading caret so ^4.18.2 is recognised as already-bumped-or-not correctly", () => {
    const root = repo();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "^4.18.2" } }, null, 2),
      "utf8"
    );
    const { bump } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: true,
    });
    expect(bump.from).toBe("4.18.2"); // caret stripped before comparison
    expect(bump.changed).toBe(true);
  });

  it("dry-run computes the change but writes NOTHING", () => {
    const root = repo();
    const contents = JSON.stringify({ dependencies: { express: "4.18.2" } }, null, 2);
    writeFileSync(join(root, "package.json"), contents, "utf8");

    const { bump, written } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: false,
    });

    expect(bump.changed).toBe(true); // it knows what it WOULD do
    expect(written).toBe(false);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(contents); // but did not
  });

  it("does not crash when the manifest is missing or the dep is undeclared", () => {
    const root = repo();
    // No package.json at all.
    const a = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      write: true,
    });
    expect(a.bump.changed).toBe(false);

    // package.json present but does not declare the dependency.
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    const b = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      write: true,
    });
    expect(b.bump.changed).toBe(false);
  });

  it("bumps a dep declared in devDependencies too", () => {
    const root = repo();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { typescript: "5.7.3" } }, null, 2),
      "utf8"
    );
    const { bump, written } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "typescript",
      toVersion: "5.8.0",
      write: true,
    });
    expect(written).toBe(true);
    const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(after.devDependencies.typescript).toBe("5.8.0");
  });

  it("builds a §9.4-style commit message", () => {
    const root = repo();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { express: "4.18.2" } }, null, 2),
      "utf8"
    );
    const { bump } = bumpManifest({
      repoRoot: root,
      ecosystem: "npm",
      dependency: "express",
      toVersion: "5.1.0",
      planItem: PLAN_ITEM,
      write: true,
    });
    const msg = manifestCommitMessage(bump);
    expect(msg).toBe("majortom: EX-18 - bump package.json to 5.1.0");
  });
});

describe("manifest helpers", () => {
  it("reads a declared version out of each ecosystem", () => {
    expect(
      readDeclaredVersion(
        JSON.stringify({ dependencies: { express: "^4.18.2" } }),
        "npm",
        "express"
      )
    ).toBe("4.18.2");
    expect(readDeclaredVersion("express = 4.18.2", "go", "express")).toBe("4.18.2");
    expect(readDeclaredVersion('express = "4.18.2"', "pip", "express")).toBe("4.18.2");
    expect(readDeclaredVersion('express = "5.1.0"', "cargo", "express")).toBe("5.1.0");
    expect(readDeclaredVersion("", "npm", "express")).toBeNull();
  });

  it("knows each ecosystem's manifest filename", () => {
    expect(manifestCandidates("npm", "/repo")).toEqual(["package.json"]);
    expect(manifestCandidates("go", "/repo")).toEqual(["go.mod"]);
    expect(manifestCandidates("cargo", "/repo")).toEqual(["Cargo.toml"]);
    expect(manifestCandidates("pip", "/repo")).toContain("requirements.txt");
  });
});
