// fixtures/express4/tests/items.test.js
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import request from "supertest";
const app = require("../src/app.js");

describe("GET /items", () => {
  it("returns a list of items with status 200", async () => {
    const res = await request(app).get("/items");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

describe("GET /items/:id", () => {
  it("returns a single item by id", async () => {
    const res = await request(app).get("/items/1");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", 1);
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app).get("/items/9999");
    expect(res.status).toBe(404);
  });
});

describe("POST /items", () => {
  it("creates a new item", async () => {
    const res = await request(app)
      .post("/items")
      .send({ name: "Widget D", price: 39.99 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("name", "Widget D");
  });
});
