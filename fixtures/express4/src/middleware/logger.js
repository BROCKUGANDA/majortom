// fixtures/express4/src/middleware/logger.js
"use strict";

/**
 * Request logger middleware.
 *
 * NOTE: This file also contains a pattern inside a comment to test false-positive suppression:
 *   res.sendfile('/path')   <-- inside a comment, should NOT be detected as a real call
 *   res.send(404)           <-- inside a comment, should NOT be detected as a real call
 *   req.param('id')         <-- inside a comment, should NOT be detected
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
}

/**
 * A string-literal test: the following value contains patterns that should NOT be detected.
 * They are data, not code.
 */
const PATTERN_DOCS = "Use res.sendfile() for files; use req.param('x') for params; res.send(404) is deprecated";

module.exports = { requestLogger, PATTERN_DOCS };
