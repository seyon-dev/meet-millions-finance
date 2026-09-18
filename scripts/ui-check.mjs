/**
 * Browser checks.
 *
 * Drives the real application in Chromium against the development server, at
 * several viewport widths, and reports three things that are otherwise easy to
 * miss: console errors, failed requests, and horizontal overflow.
 *
 *   node scripts/ui-check.mjs [--base http://localhost:8787] [--shot]
 *
 * It is a development tool, not part of the test suite — it needs a running
 * server and a browser, which the unit tests deliberately do not.
 */

import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const base = readFlag('--base') ?? 'http://localhost:8787';
const shots = args.includes('--shot');
const only = readFlag('--only');
// A comma-separated allow-list, for walking one batch of screens at a time.
const onlyList = (readFlag('--routes') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const shotDir = '/tmp/mm-shots';

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const CREDENTIALS = { email: 'asha@meridiantax.example', password: 'Demo-Passw0rd!24' };
// The platform screens sit above every organisation, so the tenant owner
// cannot reach them — and should not be able to. They need their own session.
const PLATFORM_CREDENTIALS = { email: 'devika@meetmillions.example', password: 'Demo-Passw0rd!24' };
// The client portal is a different set of screens for a different person, and
// an admin session cannot see it. Walking it needs a client's own sign-in.
const CLIENT_CREDENTIALS = { email: 'priya@radianttraders.example', password: 'Demo-Passw0rd!24' };

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
];

/** Every screen worth walking, with something on it that proves it rendered. */
const ROUTES = [
  { path: '/admin/dashboard', expect: 'h1' },
  { path: '/clients', expect: 'h1' },
  { path: '/documents', expect: 'h1' },
  { path: '/verification', expect: 'h1' },
  { path: '/queries', expect: 'h1' },
  { path: '/tax', expect: 'h1' },
  { path: '/reports', expect: 'h1' },
  { path: '/approvals', expect: 'h1' },
  { path: '/tasks', expect: 'h1' },
  { path: '/activity', expect: 'h1' },
  { path: '/tax/reconciliation', expect: 'h1' },
  { path: '/billing/payments', expect: 'h1' },
  { path: '/ai/ocr', expect: 'h1' },
  { path: '/analytics/builder', expect: 'h1' },
  { path: '/team/performance', expect: 'h1' },
  { path: '/settings/profile', expect: 'h1' },
  { path: '/settings/password', expect: 'h1' },
  { path: '/settings/branches', expect: 'h1' },
  { path: '/billing/subscription', expect: 'h1' },
  { path: '/billing/invoices', expect: 'h1' },
  { path: '/marketplace', expect: 'h1' },
  { path: '/calls', expect: 'h1' },
  { path: '/messaging/inbox', expect: 'h1' },
  { path: '/leads', expect: 'h1' },
  { path: '/voice-notes', expect: 'h1' },
  { path: '/support', expect: 'h1' },
  { path: '/calendar', expect: 'h1' },
  { path: '/automation', expect: 'h1' },
  { path: '/ai/insights', expect: 'h1' },
  { path: '/ai/assistant', expect: 'h1' },
  { path: '/analytics', expect: 'h1' },
  { path: '/attendance', expect: 'h1' },
  { path: '/team', expect: 'h1' },
  { path: '/companies', expect: 'h1' },
  { path: '/audit', expect: 'h1' },
  { path: '/settings', expect: 'h1' },
  { path: '/settings/security', expect: 'h1' },
  { path: '/settings/integrations', expect: 'h1' },
  { path: '/settings/branding', expect: 'h1' },
  { path: '/settings/api', expect: 'h1' },
  { path: '/settings/backup', expect: 'h1' },
  { path: '/settings/notifications', expect: 'h1' },
  { path: '/platform/organisations', expect: 'h1', as: 'platform' },
  { path: '/platform/franchises', expect: 'h1', as: 'platform' },
  { path: '/platform/plans', expect: 'h1', as: 'platform' },
  { path: '/platform/revenue', expect: 'h1', as: 'platform' },
  { path: '/platform/logs', expect: 'h1', as: 'platform' },
  { path: '/settings/users', expect: 'h1' },
  { path: '/client/dashboard', expect: 'h1', as: 'client' },
  { path: '/client/upload', expect: 'h1', as: 'client' },
  { path: '/client/filings', expect: 'h1', as: 'client' },
  { path: '/client/queries', expect: 'h1', as: 'client' },
  { path: '/client/reports', expect: 'h1', as: 'client' },
  { path: '/client/invoices', expect: 'h1', as: 'client' },
  { path: '/client/payments', expect: 'h1', as: 'client' },
];

let sessionToken = null;
let platformToken = null;
let clientToken = null;

/**
 * The application limits a signed-in user to 300 requests a minute, and a full
 * sweep issues roughly six per screen. That limit is correct — walking every
 * screen at machine speed is exactly the shape of traffic it exists to blunt —
 * so the check paces itself against it rather than the limit being relaxed to
 * suit a tool.
 */
const BUDGET = { max: 240, windowMs: 60_000, count: 0, since: Date.now() };

async function spendRequestBudget(page, cost) {
  const elapsed = Date.now() - BUDGET.since;
  if (elapsed >= BUDGET.windowMs) {
    BUDGET.count = 0;
    BUDGET.since = Date.now();
  }
  if (BUDGET.count + cost > BUDGET.max) {
    const wait = BUDGET.windowMs - (Date.now() - BUDGET.since) + 1500;
    if (wait > 0) await page.waitForTimeout(wait);
    BUDGET.count = 0;
    BUDGET.since = Date.now();
  }
  BUDGET.count += cost;
}

const problems = [];
const record = (route, viewport, kind, detail) => {
  problems.push({ route, viewport, kind, detail });
};

const browser = await chromium.launch({
  // The environment pins its own Chromium; resolve it rather than letting
  // playwright-core look for a download it was told not to make.
  executablePath: resolveChromium(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

function resolveChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  const candidates = readdirSync(root)
    .filter(name => name.startsWith('chromium'))
    .sort()
    .reverse()
    .flatMap(name => [
      join(root, name, 'chrome-linux', 'chrome'),
      join(root, name, 'chrome-linux', 'headless_shell'),
    ]);
  const found = candidates.find(path => existsSync(path));
  if (!found) throw new Error(`No Chromium found under ${root}.`);
  return found;
}

try {
  if (shots) await mkdir(shotDir, { recursive: true });

  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    let currentRoute = '/login';
    let activeToken = null;
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Favicons and fonts are not the application's correctness.
      if (/favicon|manifest|fonts\.googleapis/i.test(text)) return;
      record(currentRoute, viewport.name, 'console', text.slice(0, 220));
    });
    page.on('pageerror', (err) => {
      record(currentRoute, viewport.name, 'exception', String(err.message).slice(0, 220));
    });
    page.on('requestfailed', (request) => {
      if (/favicon|manifest|fonts\./i.test(request.url())) return;
      // A navigation cancels whatever the previous screen still had in
      // flight. That is the router working, not a fault.
      if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
      record(currentRoute, viewport.name, 'request', `${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
    });
    page.on('response', (response) => {
      if (response.status() === 429) {
        record(currentRoute, viewport.name, 'paced',
          'The check outran the request budget; raise the pause in spendRequestBudget.');
        return;
      }
      if (response.status() < 500) return;
      record(currentRoute, viewport.name, 'server', `${response.status()} ${response.url()}`);
    });

    // ---- Sign in ---------------------------------------------------------
    // The form is driven once, at the first width, so the sign-in screen is
    // genuinely exercised. After that the token is injected: signing in four
    // times in a row trips the application's own login rate limit, which is
    // the rate limit working rather than a fault to design around.
    if (!sessionToken) {
      await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
      await page.fill('#mm-email', CREDENTIALS.email);
      await page.fill('#mm-password', CREDENTIALS.password);
      await page.click('button[type=submit]');

      try {
        await page.waitForSelector('.mm-shell', { timeout: 15000 });
      } catch {
        record('/login', viewport.name, 'blocked', 'The shell never appeared after signing in.');
        await context.close();
        continue;
      }
      sessionToken = await page.evaluate(() => localStorage.getItem('mm.token'));

      // The second sign-in goes through the API rather than the form: four
      // form sign-ins per run would trip the login rate limit, which is the
      // rate limit working rather than a fault to design around.
      const signInThroughApi = (creds) => page.evaluate(async (c) => {
        const response = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(c),
        });
        const envelope = await response.json().catch(() => null);
        return envelope?.data?.token ?? null;
      }, creds);

      platformToken = await signInThroughApi(PLATFORM_CREDENTIALS);
      if (!platformToken) {
        record('/login', viewport.name, 'blocked',
          'No platform session — the demo Super Admin did not sign in, so /platform/* was not walked.');
      }

      clientToken = await signInThroughApi(CLIENT_CREDENTIALS);
      if (!clientToken) {
        record('/login', viewport.name, 'blocked',
          'No client session — the demo client did not sign in, so /client/* was not walked.');
      }
    } else {
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(token => localStorage.setItem('mm.token', token), sessionToken);
      await page.goto(`${base}/admin/dashboard`, { waitUntil: 'networkidle' });

      try {
        await page.waitForSelector('.mm-shell', { timeout: 15000 });
      } catch {
        record('/login', viewport.name, 'blocked', 'The shell never appeared with a restored session.');
        await context.close();
        continue;
      }
    }

    activeToken = sessionToken;

    if (shots) {
      await page.screenshot({ path: `${shotDir}/${viewport.name}-login-done.png`, fullPage: false });
    }

    // ---- Walk the screens -------------------------------------------------
    for (const route of ROUTES) {
      if (only && !route.path.includes(only)) continue;
      if (onlyList.length && !onlyList.includes(route.path)) continue;
      currentRoute = route.path;

      const wanted = route.as === 'platform' ? platformToken
        : route.as === 'client' ? clientToken
        : sessionToken;
      if (!wanted) continue;
      if (wanted !== activeToken) {
        await page.evaluate(token => localStorage.setItem('mm.token', token), wanted);
        activeToken = wanted;
      }

      // A screen load costs the session bootstrap, the badge poll, the unread
      // count and whatever the screen itself fetches.
      await spendRequestBudget(page, 8);

      await page.goto(base + route.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(220);

      const heading = await page.$(route.expect);
      if (!heading) {
        const body = (await page.textContent('#mm-main')) ?? '';
        record(route.path, viewport.name, 'empty', `No ${route.expect}. Text: ${body.trim().slice(0, 140)}`);
      }

      // Horizontal overflow — the single most common responsive fault, and
      // invisible unless something is actually measured.
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        const slack = doc.scrollWidth - doc.clientWidth;
        if (slack <= 1) return null;

        const guilty = [];
        for (const node of document.querySelectorAll('body *')) {
          const rect = node.getBoundingClientRect();
          if (rect.width === 0) continue;
          if (rect.right > doc.clientWidth + 1 || rect.left < -1) {
            guilty.push(`${node.tagName.toLowerCase()}.${(node.className || '').toString().split(' ')[0]} (${Math.round(rect.left)}→${Math.round(rect.right)})`);
          }
          if (guilty.length >= 4) break;
        }
        return { slack, guilty };
      });
      if (overflow) {
        record(route.path, viewport.name, 'overflow',
          `${overflow.slack}px wider than the viewport: ${overflow.guilty.join(', ')}`);
      }

      // Anything still showing a skeleton has not finished, or never will.
      const stuck = await page.$$eval('.mm-skeleton', nodes => nodes.length);
      if (stuck > 0) record(route.path, viewport.name, 'stuck', `${stuck} skeleton(s) still on screen`);

      if (shots && viewport.name === 'desktop') {
        const name = route.path.replace(/\//g, '_').replace(/^_/, '');
        await page.screenshot({ path: `${shotDir}/${name || 'root'}.png`, fullPage: true });
      }
    }

    await context.close();
  }
} finally {
  await browser.close();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (!problems.length) {
  const walked = onlyList.length
    ? onlyList.length
    : only ? ROUTES.filter(r => r.path.includes(only)).length : ROUTES.length;
  console.log(`\n  All ${walked} screen(s) rendered at ${VIEWPORTS.length} widths with no console errors, no failed requests and no horizontal overflow.\n`);
  process.exit(0);
}

const byKind = {};
for (const p of problems) (byKind[p.kind] ??= []).push(p);

console.log(`\n  ${problems.length} problem(s):\n`);
for (const [kind, list] of Object.entries(byKind)) {
  console.log(`  ${kind.toUpperCase()} (${list.length})`);
  // Deduplicated: the same fault at four widths is one fault.
  const seen = new Set();
  for (const p of list) {
    const key = `${p.route}|${p.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`    ${p.route} [${p.viewport}] ${p.detail}`);
  }
  console.log('');
}
process.exit(1);
