// fixtures/express4/tests/search.test.js
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import request from "supertest";
const app = require("../src/app.js");

describe("GET /search", () => {
  it("returns search results with query params", async () => {
    const res = await request(app).get("/search?page=1&sort=name");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("page", "1");
  });

  it("handles wildcard routes", async () => {
    const res = await request(app).get("/search/anything/nested");
    expect(res.status).toBe(200);
  });
});
