import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The browser API client's error shapes.
 *
 * These are asserted against the file rather than by importing it, because it
 * is browser code that reaches for `window` and `fetch` at module scope. What
 * matters here is one specific contract between the two halves of the system,
 * and it was broken in a way no test could see: the server nests field errors
 * as `details: { fields: {…} }`, the client read `details`, and every caller
 * that took the first entry got an object where it expected a string.
 *
 * The visible result was "[object Object]" in place of the error message —
 * on every validation failure in the application, not merely one form.
 */
describe('API client error contract', () => {
  const client = readFileSync('public/assets/js/core/api.js', 'utf8');
  const server = readFileSync('src/http/errors.js', 'utf8');

  test('the server nests field errors under details.fields', () => {
    const ctor = server.slice(server.indexOf('export class ValidationError'));
    assert.match(ctor.slice(0, 400), /details:\s*fields\s*\?\s*\{\s*fields\s*\}/,
      'if the server stops nesting them, the client below must change with it');
  });

  test('the client unwraps details.fields, not details', () => {
    const block = client.slice(client.indexOf('export class ValidationError'));
    const assignment = /this\.fields\s*=\s*([^;]+);/.exec(block.slice(0, 900));
    assert.ok(assignment, 'ValidationError must assign this.fields');
    assert.match(assignment[1], /details\?\.fields/,
      'reading `details` alone yields { fields: {…} }, which renders as [object Object]');
  });

  test('field messages are strings by the time a form reads them', () => {
    // The shape both consumers rely on: register.js takes Object.entries()[0][1]
    // and puts it straight into a banner; ui.js takes Object.values()[0].
    const serverPayload = { details: { fields: { gstin: 'GSTIN must be a valid 15-character GSTIN.' } } };
    const fields = serverPayload?.details?.fields ?? {};

    const [name, message] = Object.entries(fields)[0];
    assert.equal(name, 'gstin', 'the field name is what the form focuses');
    assert.equal(typeof message, 'string', 'a banner needs a string, not an object');
    assert.equal(String(message), message, 'and must not stringify to [object Object]');

    // The bug, written out: one level too shallow.
    const broken = Object.entries(serverPayload.details)[0][1];
    assert.equal(String(broken), '[object Object]',
      'this is what the application showed before the fix');
  });

  test('both consumers reach for the field message the same way', () => {
    const register = readFileSync('public/assets/js/screens/auth/register.js', 'utf8');
    const ui = readFileSync('public/assets/js/core/ui.js', 'utf8');
    assert.match(register, /err\.fields/, 'the registration form reads err.fields');
    assert.match(ui, /err\.fields/, 'notifyError reads err.fields for every other form');
  });
});
