// fixtures/express4/src/app.js
"use strict";

const express = require("express");
const { requestLogger } = require("./middleware/logger");
const { errorHandler } = require("./middleware/errorHandler");
const itemsRouter = require("./routes/items");
const usersRouter = require("./routes/users");
const authRouter = require("./routes/auth");
const filesRouter = require("./routes/files");
const searchRouter = require("./routes/search");

const app = express();

// Middleware
app.use(express.json());
app.use(requestLogger);

// Routes
app.use("/items", itemsRouter);
app.use("/users", usersRouter);
app.use("/auth", authRouter);
app.use("/files", filesRouter);
app.use("/search", searchRouter);

// EX-01: app.del() — removed in Express 5
app.del("/legacy/:id", (req, res) => {
  res.json({ deleted: req.params["id"] });
});

// EX-12: regex-ish route string — not valid in Express 5
app.get("/api/(v1|v2)/status", (req, res) => {
  res.json({ status: "ok" });
});

// EX-18: engines field — seeded in package.json (node >=14, should be >=18 for Express 5)

// Error handler (must be last)
app.use(errorHandler);

module.exports = app;
