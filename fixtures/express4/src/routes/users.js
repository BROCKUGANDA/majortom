// fixtures/express4/src/routes/users.js
"use strict";

const express = require("express");
const router = express.Router();

// EX-08: req.param(name) — another instance
router.get("/:id", (req, res) => {
  const id = req.param("id");
  res.json({ id, name: "Test User" });
});

// EX-09: acceptsCharset singular — removed in Express 5
router.get("/preferences", (req, res) => {
  const charset = req.acceptsCharset("utf-8");
  const encoding = req.acceptsEncoding("gzip");
  const lang = req.acceptsLanguage("en");
  res.json({ charset, encoding, lang });
});

// EX-06: res.sendfile() — removed in Express 5
router.get("/:id/avatar", (req, res) => {
  const id = req.param("id");
  res.sendfile(`/avatars/${id}.png`);
});

module.exports = router;
