/**
 * The landing page's pricing is a hand-written mirror of src/data/plans.js,
 * because the landing file is served to the browser and the catalogue is not.
 * A mirror drifts unless something fails when it does — this is the
 * something. A visitor quoted ₹2,999 must not meet ₹3,499 at checkout.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PLANS } from '../src/data/plans.js';

const landing = readFileSync('public/assets/js/screens/landing.js', 'utf8');

describe('landing pricing mirrors the catalogue', () => {
  test('every paid plan price on the page matches monthlyPaise', () => {
    for (const plan of PLANS) {
      if (!plan.monthlyPaise) continue;
      const rupees = plan.monthlyPaise / 100;
      const printed = `₹${rupees.toLocaleString('en-IN')}`;
      assert.ok(landing.includes(printed),
        `${plan.name} costs ${printed} in the catalogue but the landing page does not say so`);
    }
  });

  test('every plan in the catalogue appears on the page', () => {
    for (const plan of PLANS) {
      assert.ok(new RegExp(`key: '${plan.key}'`).test(landing),
        `plan '${plan.key}' is missing from the landing pricing`);
    }
  });

  test('the page invents no plan the catalogue does not have', () => {
    const keys = [...landing.matchAll(/\{ key: '(\w+)', name:/g)].map(m => m[1]);
    for (const key of keys) {
      assert.ok(PLANS.some(p => p.key === key), `landing shows a plan '${key}' that does not exist`);
    }
    assert.equal(keys.length, PLANS.length);
  });

  test('the popular flag sits on the plan the catalogue marks popular', () => {
    const popular = PLANS.find(p => p.isPopular);
    assert.ok(popular, 'catalogue must mark one plan popular');
    const m = new RegExp(`key: '${popular.key}'[^}]*popular: true`).test(landing);
    assert.ok(m, `the catalogue marks ${popular.key} popular; the landing page flags something else`);
  });

  test('the trial claim matches the catalogue', () => {
    const standard = PLANS.find(p => p.key === 'standard');
    assert.ok(landing.includes(`${standard.trialDays}-day trial`),
      'the FAQ quotes a trial length; it must be the real one');
  });
});
