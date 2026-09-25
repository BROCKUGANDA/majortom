// fixtures/express4/tests/users.test.js
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import request from "supertest";
const app = require("../src/app.js");

describe("GET /users/:id", () => {
  it("returns a user by id", async () => {
    const res = await request(app).get("/users/42");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "42");
  });
});

describe("GET /users/preferences", () => {
  it("returns content negotiation preferences", async () => {
    const res = await request(app)
      .get("/users/preferences")
      .set("Accept-Charset", "utf-8")
      .set("Accept-Encoding", "gzip")
      .set("Accept-Language", "en");
    expect(res.status).toBe(200);
  });
});
