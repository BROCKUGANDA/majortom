// fixtures/express4/src/config.js
"use strict";

module.exports = {
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || "development",
  uploadDir: process.env.UPLOAD_DIR || "/tmp/uploads",
  // Node engines requirement — deliberately old to seed EX-18
  nodeVersion: ">=14",
};
