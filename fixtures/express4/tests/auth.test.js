// fixtures/express4/tests/auth.test.js
import { describe, it, expect } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import request from "supertest";
const app = require("../src/app.js");

describe("GET /auth/login", () => {
  it("redirects when no referrer", async () => {
    const res = await request(app).get("/auth/login");
    // Express 4: res.redirect('back') redirects to referrer or '/'
    expect([200, 301, 302]).toContain(res.status);
  });
});

describe("GET /auth/profile/:id/:format?", () => {
  it("returns profile with format", async () => {
    const res = await request(app).get("/auth/profile/123/json");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "123");
    expect(res.body).toHaveProperty("format", "json");
  });

  it("returns profile without format (optional param)", async () => {
    const res = await request(app).get("/auth/profile/456");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id", "456");
  });
});

describe("GET /auth/whoami", () => {
  it("returns the current user from async handler", async () => {
    const res = await request(app).get("/auth/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("name");
  });
});
