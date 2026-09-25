// fixtures/express4/src/server.js
"use strict";

const app = require("./app");
const config = require("./config");

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});

module.exports = server;
