/**
 * The public landing page.
 *
 * `/` used to redirect a signed-out visitor straight to /login, which is the
 * right behaviour for somebody who already has an account and the wrong one
 * for a practice deciding whether to open one. This is what they see instead;
 * anybody with a session still goes to their own dashboard.
 *
 * Every number and claim here is drawn from what the product actually does —
 * seven roles, thirty add-ons, the workflow the CRM enforces. Nothing on this
 * page describes a feature that does not exist, because a landing page that
 * oversells is a support ticket on day two.
 */

import { el } from '../core/dom.js';
import { icon } from '../core/icons.js';

/** The filing month, which is the spine of the whole product. */
const FLOW = [
  { n: '01', k: 'Collect', d: 'Every client gets a checklist for the month. They upload; you stop chasing.' },
  { n: '02', k: 'Verify', d: 'Approve, reject or raise a query against the document itself.' },
  { n: '03', k: 'Compute', d: 'GST and TDS calculated from the records you verified, not re-keyed.' },
  { n: '04', k: 'Sign off', d: 'The client reviews and signs the return before anything is filed.' },
  { n: '05', k: 'Bill', d: 'Invoice from the work, take payment, and close the month.' },
];

const PILLARS = [
  {
    icon: 'shield-check',
    title: 'Built for who does what',
    body: 'Seven roles with their own view of the practice — from the partner who sees '
      + 'everything to the client who sees only their own file. Enforced on the server, '
      + 'not by hiding buttons.',
  },
  {
    icon: 'layers',
    title: 'One trail, end to end',
    body: 'A document arrives, gets verified, feeds a computation, lands in a report and '
      + 'ends on an invoice — and every step of that is one chain you can follow backwards.',
  },
  {
    icon: 'lock',
    title: 'Evidence you can stand behind',
    body: 'A hash-chained audit trail, anchored nightly. Every approval, every edit, every '
      + 'sign-off, with who and when — because a filing you cannot evidence is a filing you '
      + 'cannot defend.',
  },
  {
    icon: 'plug',
    title: 'Connected when you have keys',
    body: 'WhatsApp, e-Sign, cloud storage, calling, payments. Each one says Not Connected '
      + 'until you add credentials — never a green tick over something nobody set up.',
  },
];

const ROLES = [
  ['Super Admin', 'The platform, across every practice on it'],
  ['Admin', 'One practice: people, plans, billing, settings'],
  ['Finance Manager', 'Approvals, the team, and what is running late'],
  ['Finance Executive', 'Their clients, their documents, their filings'],
  ['Accountant', 'Computation and reconciliation'],
  ['Auditor', 'Read-only, with the whole audit trail'],
  ['Client', 'Their own documents, queries, reports and invoices'],
];

/**
 * The pricing cards.
 *
 * A hand-written mirror of src/data/plans.js, because this file is served to
 * the browser and that one is not. tests/landing-content.test.js compares the
 * two and fails the build if a price or bullet drifts.
 */
const PRICING = [
  { key: 'basic', name: 'Basic', price: 'Free', per: '', tagline: 'For solo practitioners getting started',
    bullets: ['1 User', '1 Company', '5GB Storage', 'Basic Upload', 'Email Support'] },
  { key: 'standard', name: 'Standard', price: '₹2,999', per: '/month', tagline: 'For growing firms managing multiple clients', popular: true,
    bullets: ['5 Users', '5 Companies', '50GB Storage', 'Unlimited Uploads', 'GST Reports', 'Payment Tracking', 'Manager Approval', 'Email + Chat Support'] },
  { key: 'pro', name: 'Pro', price: '₹7,999', per: '/month', tagline: 'For established firms at scale',
    bullets: ['Unlimited Users', 'Unlimited Companies', '500GB Storage', 'OCR + AI Precheck', 'WhatsApp Integration', 'API Access', 'Advanced Reports', 'Priority Support'] },
  { key: 'enterprise', name: 'Enterprise', price: 'Custom', per: '', tagline: 'For networks and franchises',
    bullets: ['Everything in Pro', 'White Label', 'Franchise Management', 'Dedicated Support', 'Custom Terms'] },
];

/** Questions people actually ask, answered from what the product does. */
const FAQ = [
  ['Do my clients get their own sign-in?',
   'Yes. Every client company gets portal accounts that see only their own documents, queries, reports and invoices — nothing from any other client, enforced on the server.'],
  ['Does Meet Millions file returns for us?',
   'No. It runs the month up to filing: collection, verification, GST and TDS computation, client sign-off and billing. You file with your usual tools, with every number evidenced.'],
  ['What happens to integrations we have not set up?',
   'They say Not Connected until you add credentials. Nothing shows a green tick over something nobody configured.'],
  ['Can we try it before paying?',
   'The Basic plan is free for a solo practice, and Standard starts with a 14-day trial. Creating an organisation takes about two minutes.'],
  ['Who can see what inside the firm?',
   'Seven roles, from the partner who sees everything to the auditor who can read but never touch. Access is enforced on the server on every request, not by hiding buttons.'],
  ['Is there an audit trail?',
   'Every approval, edit and sign-off is recorded in a hash-chained audit log with who and when, anchored nightly.'],
];

export default async function landingScreen() {
  return el('div.mm-landing',
    el('div.mm-landing__bg', { 'aria-hidden': 'true' },
      el('span.mm-landing__orb.mm-landing__orb--1'),
      el('span.mm-landing__orb.mm-landing__orb--2'),
      el('span.mm-landing__grid')),

    // ---- Header -----------------------------------------------------------
    // The bar spans the window and the row inside it keeps the page measure,
    // so the sticky backdrop reaches the edges of the screen instead of
    // stopping at a centred 1200px box.
    el('header.mm-landing__navbar',
      el('div.mm-landing__nav',
        el('a.mm-landing__brand', { href: '/', 'aria-label': 'Meet Millions Finance CRM' },
          el('span.mm-brand-mark', { text: 'MM' }),
          el('div.mm-brand-text',
            el('span.mm-brand-text__name', { text: 'Meet Millions' }),
            el('span.mm-brand-text__sub', { text: 'Finance CRM' }))),
        el('nav.mm-landing__navlinks',
          el('a', { href: '#how', text: 'How it works' }),
          el('a', { href: '#platform', text: 'Platform' }),
          el('a', { href: '#roles', text: 'Roles' }),
          el('a', { href: '#pricing', text: 'Pricing' }),
          el('a', { href: '#faq', text: 'FAQ' })),
        el('div.mm-landing__navcta',
          el('a.mm-btn.mm-btn--ghost', { href: '/login', text: 'Sign in' }),
          el('a.mm-btn.mm-btn--primary', { href: '/register', text: 'Create an organisation' })))),

    // ---- Hero -------------------------------------------------------------
    el('section.mm-landing__hero',
      el('div.mm-landing__hero-copy',
        el('p.mm-landing__eyebrow',
          el('span.mm-landing__pip', { 'aria-hidden': 'true' }),
          el('span', { text: 'GST & TDS practice management' })),

        el('h1.mm-landing__h1',
          el('span', { text: 'The whole filing month,' }),
          el('span.mm-landing__h1-em', { text: 'in one workspace' })),

        el('p.mm-landing__lede', {
          text: 'Meet Millions keeps document collection, verification, tax computation, '
            + 'client sign-off and billing in a single trail — so nothing is chased twice, '
            + 'and nothing is filed twice.',
        }),

        el('div.mm-landing__cta',
          el('a.mm-btn.mm-btn--primary.mm-btn--lg', { href: '/register', text: 'Create your organisation' }),
          el('a.mm-btn.mm-btn--ghost.mm-btn--lg', { href: '/login', text: 'Sign in' })),

        el('p.mm-landing__note', {
          text: 'Two minutes to set up. Your first filing month is ready to collect.',
        })),

      // A quiet representation of the month, rather than a stock screenshot.
      el('div.mm-landing__panel', { 'aria-hidden': 'true' },
        el('div.mm-landing__panel-bar',
          el('span.mm-landing__dot'), el('span.mm-landing__dot'), el('span.mm-landing__dot'),
          el('span.mm-landing__panel-title', { text: 'September filing' })),
        el('div.mm-landing__panel-body',
          ...[
            ['Radiant Traders', 'Verified', 'ok'],
            ['Northline Textiles', 'In review', 'warn'],
            ['Vantara Foods', 'Query raised', 'warn'],
            ['Kestrel Logistics', 'Signed off', 'ok'],
            ['Solaris Apparel', 'Collecting', 'idle'],
          ].map(([name, state, tone]) => el('div.mm-landing__row',
            el('span.mm-landing__row-name', { text: name }),
            el('span.mm-landing__chip', { class: `mm-landing__chip--${tone}`, text: state }))),
          el('div.mm-landing__panel-foot',
            el('span', { text: '5 clients' }),
            el('span', { text: '4 of 5 ready to file' }))))),

    // ---- How it works -----------------------------------------------------
    el('section.mm-landing__section', { id: 'how' },
      el('div.mm-landing__head',
        el('p.mm-landing__kicker', { text: 'How it works' }),
        el('h2.mm-landing__h2', { text: 'Five steps, and the month is closed' })),
      el('ol.mm-landing__flow',
        ...FLOW.map((s, i) => el('li.mm-landing__step', { style: `--i:${i}` },
          el('span.mm-landing__step-n', { text: s.n }),
          el('h3.mm-landing__step-k', { text: s.k }),
          el('p.mm-landing__step-d', { text: s.d }))))),

    // ---- Platform ---------------------------------------------------------
    el('section.mm-landing__section', { id: 'platform' },
      el('div.mm-landing__head',
        el('p.mm-landing__kicker', { text: 'The platform' }),
        el('h2.mm-landing__h2', { text: 'Made for a practice, not a spreadsheet' })),
      el('div.mm-landing__pillars',
        ...PILLARS.map((p, i) => el('article.mm-landing__pillar', { style: `--i:${i}` },
          el('span.mm-landing__pillar-icon', icon(p.icon, { size: 'sm' })),
          el('h3.mm-landing__pillar-title', { text: p.title }),
          el('p.mm-landing__pillar-body', { text: p.body }))))),

    // ---- Roles ------------------------------------------------------------
    el('section.mm-landing__section', { id: 'roles' },
      el('div.mm-landing__head',
        el('p.mm-landing__kicker', { text: 'Roles' }),
        el('h2.mm-landing__h2', { text: 'Everybody sees their own practice' })),
      el('div.mm-landing__roles',
        ...ROLES.map(([name, what]) => el('div.mm-landing__role',
          el('span.mm-landing__role-name', { text: name }),
          el('span.mm-landing__role-what', { text: what }))))),

    // ---- Pricing ----------------------------------------------------------
    el('section.mm-landing__section', { id: 'pricing' },
      el('div.mm-landing__head',
        el('p.mm-landing__kicker', { text: 'Pricing' }),
        el('h2.mm-landing__h2', { text: 'Start free, grow when the practice does' })),
      el('div.mm-landing__plans',
        ...PRICING.map((plan, i) => el('article.mm-landing__plan', {
          class: plan.popular ? 'mm-landing__plan--popular' : '', style: `--i:${i}`,
        },
          plan.popular ? el('span.mm-landing__plan-flag', { text: 'Most popular' }) : null,
          el('h3.mm-landing__plan-name', { text: plan.name }),
          el('p.mm-landing__plan-price',
            el('span.mm-landing__plan-amount', { text: plan.price }),
            plan.per ? el('span.mm-landing__plan-per', { text: plan.per }) : null),
          el('p.mm-landing__plan-tag', { text: plan.tagline }),
          el('ul.mm-landing__plan-list',
            ...plan.bullets.map(b => el('li',
              el('span.mm-landing__plan-tick', { 'aria-hidden': 'true' }, icon('check', { size: 'sm' })),
              el('span', { text: b })))),
          el('a.mm-btn.mm-btn--block', {
            class: plan.popular ? 'mm-btn--primary' : 'mm-btn--outline',
            href: '/register',
            text: plan.key === 'enterprise' ? 'Talk to us' : 'Create your organisation',
          })))),
      el('p.mm-landing__plan-note', {
        text: 'Prices exclude GST. Annual billing gets two months free. Add-on modules are priced separately in the marketplace.',
      })),

    // ---- FAQ ----------------------------------------------------------------
    el('section.mm-landing__section', { id: 'faq' },
      el('div.mm-landing__head',
        el('p.mm-landing__kicker', { text: 'FAQ' }),
        el('h2.mm-landing__h2', { text: 'The questions practices ask first' })),
      el('div.mm-landing__faq',
        ...FAQ.map(([q, a]) => el('details.mm-landing__qa',
          el('summary.mm-landing__q',
            el('span', { text: q }),
            el('span.mm-landing__q-mark', { 'aria-hidden': 'true' }, icon('chevron-down', { size: 'sm' }))),
          el('p.mm-landing__a', { text: a }))))),

    // ---- Close ------------------------------------------------------------
    el('section.mm-landing__close',
      el('h2.mm-landing__h2', { text: 'Start with one filing month' }),
      el('p.mm-landing__lede', {
        text: 'Create your organisation, add a client, and collect a month of documents. '
          + 'Everything else follows from that.',
      }),
      el('div.mm-landing__cta',
        el('a.mm-btn.mm-btn--primary.mm-btn--lg', { href: '/register', text: 'Create your organisation' }))),

    el('footer.mm-landing__foot',
      el('span', { text: 'Meet Millions Finance CRM' }),
      el('span.mm-landing__foot-links',
        el('a', { href: '/login', text: 'Sign in' }),
        el('a', { href: '/register', text: 'Create an organisation' }),
        // The same door with the same lock: platform staff authenticate on
        // the ordinary sign-in form and their role decides what opens.
        el('a', { href: '/login', text: 'Super Admin' }))));
}
