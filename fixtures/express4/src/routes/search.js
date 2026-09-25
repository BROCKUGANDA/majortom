// fixtures/express4/src/routes/search.js
"use strict";

const express = require("express");
const router = express.Router();

// EX-13: nested req.query access — default query parser changed in Express 5
router.get("/", (req, res) => {
  // In Express 4, this parses nested objects with qs. In Express 5 the default is "simple".
  const filters = req.query["filters"];
  const page = req.query["page"];
  const sort = req.query["sort"];

  // EX-13: nested query object access pattern
  const nestedFilters = req.query["filters"] && req.query["filters"]["category"];

  res.json({ filters, page, sort, nestedFilters });
});

// EX-11: bare * wildcard — not valid in Express 5
router.get("/*", (req, res) => {
  res.json({ path: req.path });
});

// EX-15: express.urlencoded without extended option
router.use(express.urlencoded());

module.exports = router;
