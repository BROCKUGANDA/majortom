// fixtures/express4/src/middleware/errorHandler.js
"use strict";

// EX-17: async error handler — Express 5 forwards rejected promises automatically.
// The four-argument signature is correct for Express 4 and 5.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(err.stack);
  const status = err.status || 500;
  // EX-03: res.send(body, status) — deprecated in Express 5
  res.send({ error: err.message }, status);
}

module.exports = { errorHandler };
