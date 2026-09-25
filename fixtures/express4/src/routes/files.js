// fixtures/express4/src/routes/files.js
"use strict";

const express = require("express");
const path = require("path");
const router = express.Router();

// EX-06: res.sendfile() — second file for this pattern (multi-file coverage)
router.get("/:name", (req, res) => {
  const name = req.params["name"];
  res.sendfile(path.join("/public", name));
});

module.exports = router;
