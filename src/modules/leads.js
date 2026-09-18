/**
 * Lead capture and the sales pipeline (add-ons: Meta Lead Ads, Google Forms,
 * Website Contact Forms, Lead Distribution).
 *
 * Leads arrive from several sources and the same person often arrives twice,
 * so duplicate detection runs on capture rather than being left to whoever
 * opens the list. A duplicate is linked, not deleted: the second submission is
 * itself information, and merging silently would lose the campaign it came
 * from.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso, addDays, monthKey } from '../utils/time.js';
import { formatINR } from '../utils/money.js';
import { audit, recordActivity } from '../services/audit.js';
import { assertFeature } from '../services/features.js';
import { provisionClient, openFilingPeriod } from '../services/provisioning.js';
import { hashPassword, generateTemporaryPassword } from '../auth/password.js';

const router = createRouter();

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost', 'duplicate', 'spam'];
const LEAD_SOURCES = ['meta_ads', 'google_form', 'website_form', 'sheet', 'whatsapp', 'call', 'referral', 'manual', 'api', 'other'];

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------
router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('leads', 'l');
  where.eqIf('l.source', ctx.q('source'));
  where.eqIf('l.campaign_id', ctx.q('campaignId'));
  where.eqIf('l.assigned_to', ctx.q('assignedTo'));
  where.betweenIf('l.created_at', ctx.q('from'), ctx.q('to'));
  where.searchIf(['l.full_name', 'l.email', 'l.phone', 'l.company_name'], ctx.q('q'));

  const statuses = ctx.qList('status');
  if (statuses.length) where.inIf('l.status', statuses);
  else if (!ctx.qBool('includeClosed')) where.inIf('l.status', ['new', 'contacted', 'qualified', 'proposal']);

  if (ctx.qBool('mine')) where.add('l.assigned_to = ?', ctx.userId);

  const { rows, total } = await scope.paginate('leads', where, {
    columns: `l.*, u.full_name AS owner_name, c.name AS campaign_name,
              cl.display_name AS converted_client_name`,
    joins: `LEFT JOIN users u ON u.id = l.assigned_to
            LEFT JOIN campaigns c ON c.id = l.campaign_id
            LEFT JOIN clients cl ON cl.id = l.converted_client_id`,
    alias: 'l',
    orderBy: `l.${safeOrder(ctx.q('sort', 'created_at'), ctx.q('dir', 'desc'), ['created_at', 'score', 'status'], 'created_at')}`,
    page, pageSize,
  });

  const byStatus = await scope.raw(
    'SELECT status, COUNT(*) AS n FROM leads WHERE tenant_id = ? GROUP BY status', [ctx.tenantId]);
  const bySource = await scope.raw(
    'SELECT source, COUNT(*) AS n FROM leads WHERE tenant_id = ? GROUP BY source ORDER BY n DESC',
    [ctx.tenantId]);

  return paginated(rows.map(toLead), {
    page, pageSize, total,
    pipeline: Object.fromEntries(byStatus.map(s => [s.status, Number(s.n)])),
    sources: bySource.map(s => ({ source: s.source, count: Number(s.n) })),
    statuses: LEAD_STATUSES,
  }, ctx);
}, { permission: 'leads.view' });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const lead = await scope.getOrFail('leads', ctx.params.id, { resource: 'Lead' });

  const duplicates = await scope.raw(
    `SELECT id, full_name, email, phone, source, status, created_at FROM leads
      WHERE tenant_id = ? AND id != ? AND (duplicate_of = ? OR id = ?)
      ORDER BY created_at`,
    [ctx.tenantId, lead.id, lead.id, lead.duplicate_of ?? '']);

  const calls = await scope.raw(
    `SELECT id, direction, status, duration_seconds, created_at FROM call_records
      WHERE tenant_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 20`,
    [ctx.tenantId, lead.id]);

  const owner = lead.assigned_to
    ? await scope.first('users', { id: lead.assigned_to }, 'id, full_name, email')
    : null;

  return ok({
    lead: toLead(lead),
    // The whole submission as it arrived, so nothing captured is lost just
    // because the form had a field this CRM does not model.
    submission: safeJson(lead.payload_json, null),
    duplicates: duplicates.map(toLead),
    calls,
    owner,
  }, { ctx });
}, { permission: 'leads.view' });

router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    fullName: { type: 'string', required: true, max: 160 },
    email: { type: 'email' },
    phone: { type: 'phone' },
    companyName: { type: 'string', max: 160 },
    city: { type: 'string', max: 80 },
    message: { type: 'text', max: 2000 },
    source: { type: 'enum', values: LEAD_SOURCES, default: 'manual' },
    campaignId: { type: 'id' },
    assignedTo: { type: 'id' },
  });

  if (!input.email && !input.phone) {
    throw new BadRequestError('A lead needs an email address or a phone number to be worth following up.');
  }

  const duplicate = await findDuplicate(scope, ctx.tenantId, input);
  const assignedTo = input.assignedTo ?? await pickAssignee(scope, ctx, input);

  const lead = await scope.insert('leads', {
    id: ID.lead(),
    source: input.source,
    campaign_id: input.campaignId ?? null,
    full_name: input.fullName,
    email: input.email ?? null,
    phone: input.phone ?? null,
    company_name: input.companyName ?? null,
    city: input.city ?? null,
    message: input.message ?? null,
    status: duplicate ? 'duplicate' : 'new',
    duplicate_of: duplicate?.id ?? null,
    assigned_to: assignedTo,
    assigned_at: assignedTo ? nowIso() : null,
    score: scoreLead(input),
  });

  await audit(ctx, {
    action: 'leads.created', category: 'general',
    entityType: 'lead', entityId: lead.id, entityLabel: input.fullName,
    newValue: { source: input.source, duplicateOf: duplicate?.id ?? null },
  });

  return created({
    lead: toLead(lead),
    duplicateOf: duplicate ? toLead(duplicate) : null,
  }, { ctx });
}, { permission: 'leads.manage' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const lead = await scope.getOrFail('leads', ctx.params.id, { resource: 'Lead' });

  const body = await ctx.body();
  const input = validate(body, {
    status: { type: 'enum', values: LEAD_STATUSES },
    assignedTo: { type: 'id' },
    fullName: { type: 'string', max: 160 },
    email: { type: 'email' },
    phone: { type: 'phone' },
    companyName: { type: 'string', max: 160 },
    city: { type: 'string', max: 80 },
    score: { type: 'int', min: 0, max: 100 },
    tags: { type: 'array', max: 10, of: { type: 'string', max: 40 } },
    note: { type: 'text', max: 2000 },
  });

  const patch = {};
  for (const [field, column] of Object.entries({
    status: 'status', assignedTo: 'assigned_to', fullName: 'full_name', email: 'email',
    phone: 'phone', companyName: 'company_name', city: 'city', score: 'score',
  })) {
    if (input[field] !== null && input[field] !== undefined) patch[column] = input[field];
  }
  if (input.tags) patch.tags_json = JSON.stringify(input.tags);
  if (patch.assigned_to && patch.assigned_to !== lead.assigned_to) patch.assigned_at = nowIso();
  if (patch.status === 'contacted') patch.last_contacted_at = nowIso();
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  // Won is reached by converting, not by declaring. Otherwise the pipeline
  // reports wins with no client record behind them.
  if (patch.status === 'won' && !lead.converted_client_id) {
    throw new ConflictError('Convert the lead to a client to mark it won.');
  }

  await scope.update('leads', lead.id, patch);
  await audit(ctx, {
    action: 'leads.updated', category: 'general',
    entityType: 'lead', entityId: lead.id, entityLabel: lead.full_name,
    oldValue: { status: lead.status, assigned_to: lead.assigned_to },
    newValue: { ...patch, note: input.note ?? null },
  });

  const fresh = await scope.first('leads', { id: lead.id });
  return ok({ lead: toLead(fresh) }, { ctx });
}, { permission: 'leads.manage' });

/** Turn a lead into a real client record. */
router.post('/:id/convert', async (ctx) => {
  const scope = scopeFor(ctx);
  const lead = await scope.getOrFail('leads', ctx.params.id, { resource: 'Lead' });
  if (lead.converted_client_id) {
    throw new ConflictError('That lead has already been converted.');
  }

  const body = await ctx.body();
  const input = validate(body, {
    displayName: { type: 'string', max: 160 },
    companyName: { type: 'string', max: 200 },
    gstin: { type: 'gstin' },
    pan: { type: 'pan' },
    stateCode: { type: 'string', max: 2 },
    createPortalLogin: { type: 'boolean', default: false },
    openCurrentPeriod: { type: 'boolean', default: true },
  });

  let passwordHash = null;
  let temporaryPassword = null;
  if (input.createPortalLogin) {
    if (!lead.email) {
      throw new BadRequestError('A portal login needs the lead\'s email address.');
    }
    temporaryPassword = generateTemporaryPassword();
    passwordHash = await hashPassword(temporaryPassword);
  }

  const db = new Db(ctx.env.DB);
  const result = await provisionClient(scope, db, {
    displayName: input.displayName ?? lead.company_name ?? lead.full_name,
    companyName: input.companyName ?? lead.company_name ?? lead.full_name,
    gstin: input.gstin,
    pan: input.pan,
    stateCode: input.stateCode ?? (input.gstin ? input.gstin.slice(0, 2) : '33'),
    contactName: lead.full_name,
    contactEmail: lead.email,
    contactPhone: lead.phone,
    passwordHash,
    assignedExecutiveId: lead.assigned_to ?? ctx.userId,
    source: 'referral',
    createdBy: ctx.userId,
  });

  const opened = input.openCurrentPeriod
    ? await openFilingPeriod(scope, db, {
        clientId: result.client.id,
        companyId: result.company.id,
        periodKey: monthKey(),
      })
    : null;
  const period = opened?.period ?? null;

  await scope.update('leads', lead.id, {
    status: 'won',
    converted_client_id: result.client.id,
    converted_at: nowIso(),
  });

  // Any duplicate submissions from the same person follow the original.
  await scope.updateWhere('leads', { duplicate_of: lead.id }, {
    converted_client_id: result.client.id,
  });

  if (lead.campaign_id) {
    const campaign = await scope.first('campaigns', { id: lead.campaign_id });
    if (campaign) {
      await scope.update('campaigns', campaign.id, {
        converted_count: (campaign.converted_count ?? 0) + 1,
      });
    }
  }

  await audit(ctx, {
    action: 'leads.converted', category: 'clients', severity: 'notice',
    entityType: 'lead', entityId: lead.id, entityLabel: lead.full_name,
    newValue: { clientId: result.client.id, clientCode: result.client.client_code },
  });
  await recordActivity(ctx, {
    clientId: result.client.id, companyId: result.company.id,
    verb: 'created', entityType: 'client', entityId: result.client.id,
    summary: `${result.client.display_name} was converted from a ${lead.source.replace(/_/g, ' ')} lead`,
    visibility: 'internal', icon: 'user-plus',
  });

  return created({
    lead: toLead(await scope.first('leads', { id: lead.id })),
    client: result.client,
    company: result.company,
    period,
    portalUser: result.portalUser ? { id: result.portalUser.id, email: result.portalUser.email } : null,
    // Returned once, here, and never stored in clear.
    temporaryPassword,
  }, { ctx });
}, { permission: 'leads.manage' });

/** Link a lead to an earlier one as a duplicate. */
router.post('/:id/duplicate-of/:originalId', async (ctx) => {
  const scope = scopeFor(ctx);
  const lead = await scope.getOrFail('leads', ctx.params.id, { resource: 'Lead' });
  const original = await scope.getOrFail('leads', ctx.params.originalId, { resource: 'Lead' });

  if (lead.id === original.id) throw new BadRequestError('A lead cannot be its own duplicate.');
  if (original.duplicate_of) {
    throw new BadRequestError('That lead is itself marked a duplicate. Link to the original instead.');
  }

  await scope.update('leads', lead.id, { status: 'duplicate', duplicate_of: original.id });
  await audit(ctx, {
    action: 'leads.updated', category: 'general',
    entityType: 'lead', entityId: lead.id, entityLabel: lead.full_name,
    newValue: { duplicateOf: original.id },
  });

  return ok({ lead: toLead(await scope.first('leads', { id: lead.id })) }, { ctx });
}, { permission: 'leads.manage' });

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
router.get('/campaigns/list', async (ctx) => {
  const scope = scopeFor(ctx);
  const rows = await scope.raw(
    `SELECT c.*,
            (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id) AS leads,
            (SELECT COUNT(*) FROM leads l WHERE l.campaign_id = c.id AND l.status = 'won') AS won
       FROM campaigns c WHERE c.tenant_id = ? ORDER BY c.started_at DESC LIMIT 100`,
    [ctx.tenantId]);

  return ok({
    campaigns: rows.map(c => {
      const leads = Number(c.leads) || 0;
      const won = Number(c.won) || 0;
      const spend = Number(c.spend_paise) || 0;
      return {
        id: c.id,
        name: c.name,
        platform: c.platform,
        source: c.source,
        status: c.status,
        spendPaise: spend,
        spendLabel: formatINR(spend),
        leads,
        won,
        // Cost per lead and per conversion, computed rather than stored, so
        // they cannot drift away from the leads actually recorded.
        costPerLeadPaise: leads ? Math.round(spend / leads) : null,
        costPerConversionPaise: won ? Math.round(spend / won) : null,
        conversionRatePct: leads ? Math.round((won / leads) * 100) : null,
        startedAt: c.started_at,
        endedAt: c.ended_at,
      };
    }),
  }, { ctx });
}, { permission: 'leads.view' });

router.post('/campaigns', async (ctx) => {
  await assertFeature(ctx, 'meta_lead_ads');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 160 },
    platform: { type: 'string', max: 40 },
    source: { type: 'enum', values: LEAD_SOURCES, default: 'meta_ads' },
    externalId: { type: 'string', max: 120 },
    spendPaise: { type: 'paise', min: 0 },
    startedAt: { type: 'date' },
  });

  const campaign = await scope.insert('campaigns', {
    id: ID.campaign(),
    name: input.name,
    platform: input.platform ?? 'meta',
    source: input.source,
    external_id: input.externalId ?? null,
    status: 'active',
    spend_paise: input.spendPaise ?? 0,
    lead_count: 0,
    converted_count: 0,
    started_at: input.startedAt ?? nowIso(),
  });

  return created({ campaign }, { ctx });
}, { permission: 'leads.manage' });

// ---------------------------------------------------------------------------
// Assignment rules — the Lead Distribution add-on
// ---------------------------------------------------------------------------
router.get('/rules/list', async (ctx) => {
  const scope = scopeFor(ctx);
  const rules = await scope.all('lead_assignment_rules', {}, { order: 'priority ASC', limit: 50 });
  const staff = await scope.raw(
    `SELECT u.id, u.full_name, u.email,
            (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = u.id
               AND l.status IN ('new','contacted','qualified','proposal')) AS open_leads
       FROM users u WHERE u.tenant_id = ? AND u.status = 'active' AND u.deleted_at IS NULL
      ORDER BY u.full_name`, [ctx.tenantId]);

  return ok({
    rules: rules.map(r => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      conditions: safeJson(r.conditions_json, {}),
      strategy: r.strategy,
      targetUserId: r.target_user_id,
      pool: safeJson(r.pool_json, []),
      isActive: !!r.is_active,
    })),
    staff: staff.map(s => ({
      id: s.id, name: s.full_name, email: s.email, openLeads: Number(s.open_leads) || 0,
    })),
    strategies: [
      { key: 'fixed', name: 'Always this person' },
      { key: 'round_robin', name: 'Round robin across a pool' },
      { key: 'least_loaded', name: 'Whoever has the fewest open leads' },
    ],
  }, { ctx });
}, { permission: 'leads.view' });

router.post('/rules', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 120 },
    priority: { type: 'int', min: 1, max: 999, default: 100 },
    conditions: { type: 'json' },
    strategy: { type: 'enum', required: true, values: ['fixed', 'round_robin', 'least_loaded'] },
    targetUserId: { type: 'id' },
    pool: { type: 'array', max: 50, of: { type: 'id' } },
    isActive: { type: 'boolean', default: true },
  });

  if (input.strategy === 'fixed' && !input.targetUserId) {
    throw new BadRequestError('A fixed rule needs someone to assign to.');
  }
  if (input.strategy === 'round_robin' && !(input.pool?.length > 1)) {
    throw new BadRequestError('Round robin needs a pool of at least two people.');
  }

  const rule = await scope.insert('lead_assignment_rules', {
    id: ID.rule(),
    name: input.name,
    priority: input.priority,
    conditions_json: JSON.stringify(input.conditions ?? {}),
    strategy: input.strategy,
    target_user_id: input.targetUserId ?? null,
    pool_json: input.pool ? JSON.stringify(input.pool) : null,
    last_assigned_index: 0,
    is_active: input.isActive ? 1 : 0,
  });

  return created({ rule }, { ctx });
}, { permission: 'leads.manage' });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Has this person already been captured?
 *
 * Matched on email, or on the last ten digits of the phone number, because the
 * same person will write +91 98765 43210 one day and 9876543210 the next.
 */
async function findDuplicate(scope, tenantId, input) {
  const digits = String(input.phone ?? '').replace(/\D/g, '').slice(-10);
  if (!input.email && !digits) return null;

  return scope.rawOne(
    `SELECT * FROM leads
      WHERE tenant_id = ? AND duplicate_of IS NULL
        AND ((? != '' AND LOWER(COALESCE(email,'')) = ?)
          OR (? != '' AND REPLACE(REPLACE(COALESCE(phone,''),' ',''),'+','') LIKE ?))
      ORDER BY created_at LIMIT 1`,
    [tenantId,
      input.email ?? '', (input.email ?? '').toLowerCase(),
      digits, `%${digits}`]);
}

/** Apply the first matching assignment rule. */
async function pickAssignee(scope, ctx, input) {
  const rules = await scope.all('lead_assignment_rules', { is_active: 1 }, { order: 'priority ASC', limit: 50 });

  for (const rule of rules) {
    const conditions = safeJson(rule.conditions_json, {});
    if (conditions.source && conditions.source !== input.source) continue;
    if (conditions.city && String(conditions.city).toLowerCase() !== String(input.city ?? '').toLowerCase()) continue;

    if (rule.strategy === 'fixed') return rule.target_user_id;

    const pool = safeJson(rule.pool_json, []);
    if (!pool.length) continue;

    if (rule.strategy === 'round_robin') {
      const next = ((rule.last_assigned_index ?? 0) + 1) % pool.length;
      await scope.update('lead_assignment_rules', rule.id, { last_assigned_index: next });
      return pool[next];
    }

    if (rule.strategy === 'least_loaded') {
      const counts = await scope.raw(
        `SELECT assigned_to, COUNT(*) AS n FROM leads
          WHERE tenant_id = ? AND assigned_to IN (${pool.map(() => '?').join(',')})
            AND status IN ('new','contacted','qualified','proposal')
          GROUP BY assigned_to`, [ctx.tenantId, ...pool]);
      const load = new Map(counts.map(c => [c.assigned_to, Number(c.n)]));
      return pool.reduce((best, id) => ((load.get(id) ?? 0) < (load.get(best) ?? 0) ? id : best), pool[0]);
    }
  }
  return null;
}

/**
 * A transparent score, not a black box.
 *
 * Each contributing factor is worth a stated number of points, so a user
 * looking at 70 can work out why it is 70.
 */
function scoreLead(input) {
  let score = 20;
  if (input.email) score += 20;
  if (input.phone) score += 25;
  if (input.companyName) score += 15;
  if (input.message && input.message.length > 40) score += 10;
  if (input.source === 'referral') score += 10;
  return Math.min(100, score);
}

function toLead(l) {
  return {
    id: l.id,
    fullName: l.full_name,
    email: l.email,
    phone: l.phone,
    companyName: l.company_name,
    city: l.city,
    message: l.message,
    source: l.source,
    campaignId: l.campaign_id,
    campaignName: l.campaign_name ?? null,
    status: l.status,
    score: l.score,
    tags: safeJson(l.tags_json, []),
    assignedTo: l.assigned_to,
    ownerName: l.owner_name ?? null,
    duplicateOf: l.duplicate_of,
    convertedClientId: l.converted_client_id,
    convertedClientName: l.converted_client_name ?? null,
    convertedAt: l.converted_at,
    utm: {
      source: l.utm_source, medium: l.utm_medium, campaign: l.utm_campaign,
      term: l.utm_term, content: l.utm_content,
    },
    pageUrl: l.page_url,
    lastContactedAt: l.last_contacted_at,
    createdAt: l.created_at,
  };
}

function safeJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export { router as leadsRouter };
