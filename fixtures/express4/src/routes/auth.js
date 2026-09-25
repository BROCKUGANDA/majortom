// fixtures/express4/src/routes/auth.js
"use strict";

const express = require("express");
const router = express.Router();

// EX-07: res.redirect('back') — removed in Express 5
router.get("/login", (req, res) => {
  res.redirect("back");
});

// EX-07: res.location('back') — removed in Express 5
router.post("/logout", (req, res) => {
  res.location("back");
  res.send(200);
});

// EX-10: optional route param :format? — not valid in Express 5
router.get("/profile/:id/:format?", (req, res) => {
  const id = req.params["id"];
  const fmt = req.params["format"] || "json";
  res.json({ id, format: fmt });
});

// EX-17: async handler without try/catch — Express 5 handles rejected promises
router.get("/whoami", async (req, res) => {
  const user = await Promise.resolve({ id: 1, name: "Admin" });
  res.json(user);
});

module.exports = router;
