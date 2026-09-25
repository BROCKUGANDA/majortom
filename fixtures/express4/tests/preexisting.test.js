// fixtures/express4/tests/preexisting.test.js
//
// This test file contains ONE DELIBERATELY FAILING TEST that is UNRELATED to Express.
// Its purpose is to prove that MajorTom's baseline classification correctly identifies
// and excludes pre-existing failures from migration accounting (SPEC.md §5.1, §8.2 I8).
//
// DO NOT FIX THIS TEST. It must stay failing.
import { describe, it, expect } from "vitest";

describe("pre-existing failure (unrelated to Express)", () => {
  it("INTENTIONALLY FAILS: arithmetic sanity check gone wrong", () => {
    // This test is deliberately wrong to seed a pre-existing failure.
    // It has nothing to do with Express; it tests our own internal invariant
    // that is known to be broken in this codebase.
    expect(1 + 1).toBe(3); // intentionally wrong — DO NOT FIX
  });

  it("passes: basic sanity", () => {
    expect(typeof "hello").toBe("string");
  });
});
