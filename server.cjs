/**
 * The Hostinger entry point.
 *
 * Why this file exists
 * --------------------
 * Hostinger's Node runtime loads the configured entry file with `require()`.
 * This application is ESM ("type": "module"), and a `require()` of an ESM
 * module fails in two different ways depending on the Node version:
 *
 *   Node 20        ERR_REQUIRE_ESM
 *                  require() of an ES module is not supported
 *
 *   Node 22/24     ERR_REQUIRE_ASYNC_MODULE
 *                  require() cannot be used on an ESM graph with top-level
 *                  await — which is what took the deployment down with a 503
 *
 * The top-level await has since been removed from server.js, so on Node 22.12
 * and later `require('./server.js')` would now work. It still would not on
 * Node 20, and a deployment that depends on which Node version the host
 * happens to offer is a deployment waiting to break again.
 *
 * So: this file is CommonJS, which `require()` always accepts, and it reaches
 * the ESM application through `import()`, which every supported Node version
 * accepts from CommonJS.
 *
 * It contains no application logic. It imports the real server and calls the
 * `start()` it exports — one HTTP listener, one scheduler, one database pool,
 * all of them the existing ones.
 *
 *   Hostinger entry file:  server.cjs
 *   Equivalent locally:    node server.cjs
 */

'use strict';

/**
 * `start()` rather than just importing the module.
 *
 * server.js starts itself only when it is the process entry point
 * (`process.argv[1]`). Loaded from here it is not, so importing alone would
 * load the application and never listen — a process that stays up and answers
 * nothing, which is harder to diagnose than a crash.
 */
async function boot() {
  const app = await import('./server.js');

  if (typeof app.start !== 'function') {
    throw new Error(
      'server.js does not export start(). This bootstrap has drifted from the '
      + 'application it is supposed to launch.');
  }

  await app.start();
}

boot().catch((err) => {
  // The real error, not a summary of it: this output is the only diagnosis
  // available in Hostinger's runtime log.
  console.error('\n  The application failed to start.\n');
  console.error(`    ${err && err.message ? err.message : err}`);
  if (err && err.code) console.error(`    code: ${err.code}`);
  if (err && err.stack) console.error(`\n${err.stack}\n`);

  // Exit non-zero so the host reports a failed start rather than keeping a
  // dead process alive behind a 503.
  process.exit(1);
});
