// fixtures/express4/tests/app.test.js
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import request from "supertest";
const app = require("../src/app.js");

describe("DELETE /legacy/:id", () => {
  it("deletes a legacy resource via app.del()", async () => {
    const res = await request(app).delete("/legacy/42");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deleted", "42");
  });
});

describe("GET /api/(v1|v2)/status", () => {
  it("handles regex-ish routes in Express 4", async () => {
    const res = await request(app).get("/api/v1/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });
});
