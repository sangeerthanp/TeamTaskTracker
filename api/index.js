// Vercel entry point: wraps the Express app from server.js as a single
// serverless function. server.js never calls app.listen() when required
// like this (see the require.main === module guard at its bottom) - it just
// exports the app, which Express makes callable as (req, res) directly.
module.exports = require("../server");
