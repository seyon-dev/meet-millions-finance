/**
 * Company (GSTIN) management and the multi-company switcher.
 *
 * A "company" here is a registered entity with its own GSTIN, PAN and filing
 * calendar. A firm holds many; a client company is one of them. The switcher
 * decides which one the rest of the UI is scoped to, and that choice lives on
 * the session so it survives a reload and cannot be spoofed by the client.
 */

import { createRouter } from '../http/router.js';
import { ok, created, paginated } from '../http/response.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { Db, safeOrder } from '../db/client.js';
import { scopeFor } from '../db/tenancy.js';
import { validate } from '../utils/validate.js';
import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { audit } from '../services/audit.js';
import { assertFeature, assertWithinLimit, hasFeature } from '../services/features.js';
import { setActiveCompany } from '../auth/session.js';
import { STATE_CODES, stateName } from '../data/tax-rules.js';

const router = createRouter();

const ENTITY_TYPES = [
  'proprietorship', 'partnership', 'llp', 'private_limited',
  'public_limited', 'trust', 'society', 'huf', 'other',
];

router.get('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const { page, pageSize } = ctx.pagination();

  const where = scope.where('companies', 'co');
  where.add('co.deleted_at IS NULL');
  where.eqIf('co.status', ctx.q('status'));
  where.eqIf('co.branch_id', ctx.q('branchId'));
  where.eqIf('co.entity_type', ctx.q('entityType'));
  where.eqIf('co.state_code', ctx.q('stateCode'));
  where.searchIf(['co.name', 'co.legal_name', 'co.gstin', 'co.pan'], ctx.q('q'));

  // A user restricted to certain companies sees only those.
  if (!ctx.has('companies.view') || ctx.isClient) {
    where.add(`EXISTS (SELECT 1 FROM user_companies uc
                        WHERE uc.company_id = co.id AND uc.user_id = ?)`, ctx.userId);
  }

  const { rows, total } = await scope.paginate('companies', where, {
    columns: `co.*, b.name AS branch_name,
              (SELECT COUNT(*) FROM clients cl WHERE cl.company_id = co.id AND cl.deleted_at IS NULL) AS client_count,
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = co.id AND d.deleted_at IS NULL) AS document_count`,
    joins: 'LEFT JOIN branches b ON b.id = co.branch_id',
    alias: 'co',
    orderBy: `co.${safeOrder(ctx.q('sort', 'name'), ctx.q('dir', 'asc'), ['name', 'created_at', 'status'], 'name')}`,
    page, pageSize,
  });

  return paginated(rows.map(toCompany), {
    page, pageSize, total,
    entityTypes: ENTITY_TYPES,
    stateCodes: Object.entries(STATE_CODES).map(([code, name]) => ({ code, name })),
  }, ctx);
}, { permission: 'companies.view' });

/** The switcher's payload — small, and ordered the way the menu shows it. */
router.get('/switcher', async (ctx) => {
  const scope = scopeFor(ctx);
  const multiCompany = await hasFeature(ctx, 'multi_company');

  const rows = ctx.has('companies.view') && !ctx.isClient
    ? await scope.all('companies', {}, { columns: 'id, name, gstin, state_code, status, logo_key', order: 'name ASC', limit: 500 })
    : await scope.raw(
      `SELECT c.id, c.name, c.gstin, c.state_code, c.status, c.logo_key, uc.is_default
         FROM user_companies uc JOIN companies c ON c.id = uc.company_id
        WHERE uc.user_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
        ORDER BY uc.is_default DESC, c.name`, [ctx.userId, ctx.tenantId]);

  return ok({
    companies: rows.filter(c => !c.deleted_at).map(c => ({
      id: c.id, name: c.name, gstin: c.gstin, stateCode: c.state_code,
      status: c.status, logoKey: c.logo_key, isDefault: !!c.is_default,
    })),
    activeCompanyId: ctx.session?.active_company_id ?? null,
    // The switcher is shown either way; without the feature it explains why
    // it cannot be used, rather than vanishing from the interface.
    switchingEnabled: multiCompany && ctx.has('companies.switch'),
    lockedReason: multiCompany ? null : 'Multi-company management is a Pro feature.',
  }, { ctx });
}, { auth: true });

router.post('/switch', async (ctx) => {
  await assertFeature(ctx, 'multi_company');
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, { companyId: { type: 'id', required: true } });

  const company = await scope.first('companies', { id: input.companyId });
  if (!company || company.deleted_at) throw new NotFoundError('Company');

  if (!ctx.has('companies.view') || ctx.isClient) {
    const link = await new Db(ctx.env.DB).one(
      'SELECT 1 AS ok FROM user_companies WHERE user_id = ? AND company_id = ?',
      [ctx.userId, company.id]);
    if (!link) throw new ForbiddenError('You are not assigned to that company.');
  }

  await setActiveCompany(new Db(ctx.env.DB), ctx.session.id, company.id);
  await audit(ctx, {
    action: 'companies.switched', category: 'companies',
    entityType: 'company', entityId: company.id, entityLabel: company.name,
  });

  return ok({ activeCompanyId: company.id, company: toCompany(company) }, { ctx });
}, { permission: 'companies.switch' });

router.get('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const company = await scope.first('companies', { id: ctx.params.id });
  if (!company || company.deleted_at) throw new NotFoundError('Company');

  const users = await scope.raw(
    `SELECT u.id, u.full_name, u.email, uc.relationship
       FROM user_companies uc JOIN users u ON u.id = uc.user_id
      WHERE uc.company_id = ? AND u.deleted_at IS NULL ORDER BY u.full_name`, [company.id]);
  const periods = await scope.all('filing_periods', { company_id: company.id },
    { order: 'period_start DESC', limit: 12 });
  const stats = await scope.rawOne(
    `SELECT
       (SELECT COUNT(*) FROM clients WHERE company_id = ? AND deleted_at IS NULL) AS clients,
       (SELECT COUNT(*) FROM documents WHERE company_id = ? AND deleted_at IS NULL) AS documents,
       (SELECT COUNT(*) FROM reports WHERE company_id = ?) AS reports,
       (SELECT COALESCE(SUM(size_bytes),0) FROM documents WHERE company_id = ? AND deleted_at IS NULL) AS storage_bytes`,
    [company.id, company.id, company.id, company.id]);

  return ok({
    company: toCompany(company),
    users,
    filingPeriods: periods,
    stats: {
      clients: Number(stats?.clients) || 0,
      documents: Number(stats?.documents) || 0,
      reports: Number(stats?.reports) || 0,
      storageBytes: Number(stats?.storage_bytes) || 0,
    },
  }, { ctx });
}, { permission: 'companies.view' });

router.post('/', async (ctx) => {
  const scope = scopeFor(ctx);
  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', required: true, max: 200 },
    legalName: { type: 'string', max: 200 },
    entityType: { type: 'enum', values: ENTITY_TYPES, default: 'private_limited' },
    gstin: { type: 'gstin' },
    pan: { type: 'pan' },
    tan: { type: 'tan' },
    cin: { type: 'string', max: 25 },
    email: { type: 'email' },
    phone: { type: 'phone' },
    website: { type: 'string', max: 200 },
    addressLine1: { type: 'string', max: 200 },
    addressLine2: { type: 'string', max: 200 },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    stateCode: { type: 'string', max: 2 },
    pincode: { type: 'string', max: 10 },
    branchId: { type: 'id' },
    gstRegistrationType: { type: 'enum', values: ['regular', 'composition', 'casual', 'non_resident', 'sez', 'unregistered'], default: 'regular' },
    gstFilingFrequency: { type: 'enum', values: ['monthly', 'quarterly'], default: 'monthly' },
    financialYearStart: { type: 'string', max: 5, default: '04-01' },
  });

  await assertWithinLimit(ctx, 'companies', 1);

  const stateCode = deriveStateCode(input);
  if (input.gstin) {
    const clash = await scope.first('companies', { gstin: input.gstin });
    if (clash && !clash.deleted_at) {
      throw new ConflictError(`${clash.name} is already registered under GSTIN ${input.gstin}.`);
    }
    if (input.gstin.slice(0, 2) !== stateCode) {
      throw new BadRequestError(
        `The GSTIN begins with state code ${input.gstin.slice(0, 2)}, which does not match the state you selected (${stateCode}).`);
    }
  }
  if (input.branchId) await scope.getOrFail('branches', input.branchId, { resource: 'Branch' });

  const company = await scope.insert('companies', {
    id: ID.company(),
    branch_id: input.branchId ?? null,
    name: input.name,
    legal_name: input.legalName ?? input.name,
    entity_type: input.entityType,
    gstin: input.gstin ?? null,
    pan: input.pan ?? (input.gstin ? input.gstin.slice(2, 12) : null),
    tan: input.tan ?? null,
    cin: input.cin ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    address_line1: input.addressLine1 ?? null,
    address_line2: input.addressLine2 ?? null,
    city: input.city ?? null,
    state: input.state ?? stateName(stateCode),
    state_code: stateCode,
    pincode: input.pincode ?? null,
    gst_registration_type: input.gstRegistrationType,
    gst_filing_frequency: input.gstFilingFrequency,
    financial_year_start: input.financialYearStart,
    status: 'active',
  });

  // Whoever creates a company can work on it without a second step.
  await new Db(ctx.env.DB).insert('user_companies', {
    user_id: ctx.userId, company_id: company.id, relationship: 'member',
    is_default: 0, created_at: nowIso(),
  });

  await audit(ctx, {
    action: 'companies.created', category: 'companies',
    entityType: 'company', entityId: company.id, entityLabel: company.name,
    newValue: { gstin: company.gstin, stateCode: company.state_code },
  });

  return created({ company: toCompany(company) }, { ctx });
}, { permission: 'companies.create' });

router.patch('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const company = await scope.getOrFail('companies', ctx.params.id, { resource: 'Company' });

  const body = await ctx.body();
  const input = validate(body, {
    name: { type: 'string', max: 200 },
    legalName: { type: 'string', max: 200 },
    entityType: { type: 'enum', values: ENTITY_TYPES },
    gstin: { type: 'gstin' },
    pan: { type: 'pan' },
    tan: { type: 'tan' },
    cin: { type: 'string', max: 25 },
    email: { type: 'email' },
    phone: { type: 'phone' },
    website: { type: 'string', max: 200 },
    addressLine1: { type: 'string', max: 200 },
    addressLine2: { type: 'string', max: 200 },
    city: { type: 'string', max: 80 },
    state: { type: 'string', max: 80 },
    stateCode: { type: 'string', max: 2 },
    pincode: { type: 'string', max: 10 },
    branchId: { type: 'id' },
    status: { type: 'enum', values: ['active', 'trial', 'inactive', 'suspended'] },
    gstRegistrationType: { type: 'enum', values: ['regular', 'composition', 'casual', 'non_resident', 'sez', 'unregistered'] },
    gstFilingFrequency: { type: 'enum', values: ['monthly', 'quarterly'] },
    financialYearStart: { type: 'string', max: 5 },
  });

  if (input.gstin && input.gstin !== company.gstin) {
    const clash = await scope.first('companies', { gstin: input.gstin });
    if (clash && clash.id !== company.id && !clash.deleted_at) {
      throw new ConflictError(`${clash.name} already uses GSTIN ${input.gstin}.`);
    }
  }

  const patch = prune({
    name: input.name,
    legal_name: input.legalName,
    entity_type: input.entityType,
    gstin: input.gstin,
    pan: input.pan,
    tan: input.tan,
    cin: input.cin,
    email: input.email,
    phone: input.phone,
    website: input.website,
    address_line1: input.addressLine1,
    address_line2: input.addressLine2,
    city: input.city,
    state: input.state,
    state_code: input.stateCode,
    pincode: input.pincode,
    branch_id: input.branchId,
    status: input.status,
    gst_registration_type: input.gstRegistrationType,
    gst_filing_frequency: input.gstFilingFrequency,
    financial_year_start: input.financialYearStart,
  });
  if (!Object.keys(patch).length) throw new BadRequestError('Nothing to update.');

  // A GSTIN whose state code contradicts the address makes every later tax
  // computation wrong, so the two are kept consistent at the point of entry.
  const finalGstin = patch.gstin ?? company.gstin;
  const finalState = patch.state_code ?? company.state_code;
  if (finalGstin && finalGstin.slice(0, 2) !== finalState) {
    throw new BadRequestError(
      `GSTIN ${finalGstin} belongs to state ${finalGstin.slice(0, 2)}, but this company is set to state ${finalState}.`);
  }

  await scope.update('companies', company.id, patch);
  await audit(ctx, {
    action: 'companies.updated', category: 'companies',
    entityType: 'company', entityId: company.id, entityLabel: company.name,
    oldValue: pick(company, Object.keys(patch)), newValue: patch,
  });

  const fresh = await scope.first('companies', { id: company.id });
  return ok({ company: toCompany(fresh) }, { ctx });
}, { permission: 'companies.update' });

router.delete('/:id', async (ctx) => {
  const scope = scopeFor(ctx);
  const company = await scope.getOrFail('companies', ctx.params.id, { resource: 'Company' });

  const clients = await scope.count('clients', { company_id: company.id });
  if (clients > 0) {
    throw new ConflictError(
      `${company.name} still has ${clients} client${clients === 1 ? '' : 's'}. Move or archive them first.`);
  }

  await scope.update('companies', company.id, { status: 'archived' });
  await scope.softDelete('companies', company.id);
  await audit(ctx, {
    action: 'companies.archived', category: 'companies', severity: 'warning',
    entityType: 'company', entityId: company.id, entityLabel: company.name,
  });

  return ok({ id: company.id, status: 'archived' }, { ctx });
}, { permission: 'companies.delete' });

function deriveStateCode(input) {
  if (input.stateCode) return input.stateCode;
  if (input.gstin) return input.gstin.slice(0, 2);
  if (input.state) {
    const wanted = input.state.trim().toLowerCase();
    const match = Object.entries(STATE_CODES).find(([, name]) => name.toLowerCase() === wanted);
    if (match) return match[0];
  }
  return '33';
}

function toCompany(c) {
  return {
    id: c.id,
    branchId: c.branch_id ?? null,
    branchName: c.branch_name ?? null,
    name: c.name,
    legalName: c.legal_name ?? null,
    entityType: c.entity_type,
    gstin: c.gstin ?? null,
    pan: c.pan ?? null,
    tan: c.tan ?? null,
    cin: c.cin ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    website: c.website ?? null,
    address: {
      line1: c.address_line1 ?? null,
      line2: c.address_line2 ?? null,
      city: c.city ?? null,
      state: c.state ?? null,
      stateCode: c.state_code,
      pincode: c.pincode ?? null,
      country: c.country ?? 'IN',
    },
    gstRegistrationType: c.gst_registration_type,
    gstFilingFrequency: c.gst_filing_frequency,
    financialYearStart: c.financial_year_start,
    logoKey: c.logo_key ?? null,
    status: c.status,
    isDemo: !!c.is_demo,
    clientCount: c.client_count === undefined ? undefined : Number(c.client_count),
    documentCount: c.document_count === undefined ? undefined : Number(c.document_count),
    createdAt: c.created_at,
  };
}

function prune(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}
function pick(obj, keys) {
  return Object.fromEntries(keys.filter(k => k in obj).map(k => [k, obj[k]]));
}

export { router as companiesRouter };
