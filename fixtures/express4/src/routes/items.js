// fixtures/express4/src/routes/items.js
"use strict";

const express = require("express");
const router = express.Router();
const itemService = require("../services/itemService");

// GET /items
router.get("/", (req, res) => {
  const items = itemService.getAll();
  // EX-04: res.json(obj, status) — deprecated in Express 5
  res.json(items, 200);
});

// GET /items/:id
router.get("/:id", (req, res) => {
  // EX-08: req.param(name) — removed in Express 5
  const id = req.param("id");
  const item = itemService.getById(id);
  if (!item) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(item);
});

// POST /items
router.post("/", express.json(), (req, res) => {
  // EX-14: req.body — will be undefined in Express 5 without a body parser
  const data = req.body;
  const item = itemService.create(data);
  res.status(201).json(item);
});

module.exports = router;
