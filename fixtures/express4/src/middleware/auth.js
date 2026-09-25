// fixtures/express4/src/middleware/auth.js
"use strict";

function requireAuth(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) {
    // EX-02: res.send(status) — deprecated in Express 5
    res.send(401);
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  const role = req.headers["x-role"];
  if (role !== "admin") {
    // EX-02: res.send(status) — another instance
    res.send(403);
    return;
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
