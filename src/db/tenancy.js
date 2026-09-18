/**
 * Tenant isolation.
 *
 * This is the single most important guarantee in the product: a user of
 * Company A must never read or write Company B's data. Rather than trusting
 * each handler to remember a `tenant_id = ?` clause, handlers work through a
 * TenantScope bound to the caller's tenant. The scope injects tenant_id into
 * every read, write and delete it performs, and refuses to build a query
 * without one.
 *
 * Cross-tenant work (the platform Super Admin's Companies screen, cron jobs)
 * must opt in explicitly via `platformScope()`, which is auditable by grep.
 */

import { Db, Where, safeOrder, ident } from './client.js';
import { AppError, ForbiddenError, NotFoundError } from '../http/errors.js';
import { nowIso } from '../utils/time.js';

/** Tables that carry tenant_id and are therefore tenant-scoped. */
export const TENANT_TABLES = new Set([
  'branches', 'companies', 'users', 'roles', 'clients', 'client_contacts', 'document_types',
  'filing_periods', 'documents', 'document_versions', 'upload_batches', 'document_comments',
  'verification_records', 'queries', 'query_replies', 'checklist_items', 'tax_rules',
  'tax_computations', 'gst_records', 'tds_records', 'reports', 'report_items', 'approvals',
  'tasks', 'activities', 'subscriptions', 'subscription_usage', 'add_on_subscriptions',
  'add_on_usage', 'invoices', 'invoice_items', 'payments', 'payment_transactions',
  'notification_templates', 'notification_preferences', 'notifications', 'message_deliveries',
  'oauth_states',
  'automation_rules', 'automation_jobs', 'automation_runs',
  'whatsapp_templates', 'chat_threads', 'chat_messages', 'chatbot_flows',
  'broadcasts', 'broadcast_recipients', 'voice_notes', 'support_tickets', 'ticket_messages', 'integrations',
  'oauth_connections', 'integration_sync_logs', 'field_mappings', 'campaigns', 'leads',
  'lead_assignment_rules', 'webhook_endpoints', 'ocr_extractions', 'ai_verifications',
  'ai_conversations', 'ai_messages', 'ai_insights', 'esign_requests', 'esign_signers',
  'storage_folder_maps', 'storage_sync_items', 'calendar_events', 'api_keys', 'api_usage',
  'telephony_agents', 'call_dispositions', 'call_tags', 'call_records', 'call_recordings',
  'call_notes', 'call_transcripts', 'call_ai_analysis', 'ivr_flows', 'voicemails',
  'call_metrics_daily', 'audit_logs', 'backups', 'restore_jobs', 'attendance', 'gps_visits',
  'settings', 'feature_flags', 'saved_views', 'scheduled_reports', 'custom_dashboards',
  'push_tokens', 'offline_captures', 'ip_allowlist', 'devices', 'sessions', 'login_events',
  // Singleton configuration tables — tenant_id is their primary key.
  'security_policies', 'white_label_settings', 'telephony_settings',
]);

/** Tables additionally scoped by company when the user has a company scope. */
const COMPANY_SCOPED = new Set([
  'companies', 'clients', 'filing_periods', 'documents', 'queries', 'tax_computations',
  'reports', 'tasks', 'invoices', 'call_records',
]);

export class TenantScope {
  /**
   * @param {Db} db
   * @param {string|null} tenantId  null only for a platform-level scope
   * @param {object} opts
   */
  constructor(db, tenantId, opts = {}) {
    this.db = db;
    this.tenantId = tenantId ?? null;
    this.isPlatform = opts.platform === true;
    /** null = every company in the tenant; array = only these ids. */
    this.companyIds = opts.companyIds ?? null;
    this.actorId = opts.actorId ?? null;

    if (!this.isPlatform && !this.tenantId) {
      throw new AppError('A tenant scope requires a tenant id.', { code: 'scope_missing_tenant' });
    }
  }

  /** The tenant predicate appended to every scoped query. */
  _tenantClause(alias) {
    const col = alias ? `${ident(alias)}.tenant_id` : 'tenant_id';
    if (this.isPlatform) return { sql: null, params: [] };
    return { sql: `${col} = ?`, params: [this.tenantId] };
  }

  _companyClause(table, alias) {
    if (!this.companyIds || !COMPANY_SCOPED.has(table)) return { sql: null, params: [] };
    if (!this.companyIds.length) return { sql: '1 = 0', params: [] }; // scoped to nothing
    const col = table === 'companies'
      ? (alias ? `${ident(alias)}.id` : 'id')
      : (alias ? `${ident(alias)}.company_id` : 'company_id');
    return {
      sql: `${col} IN (${this.companyIds.map(() => '?').join(', ')})`,
      params: [...this.companyIds],
    };
  }

  /**
   * Build a Where seeded with the tenant (and company) predicates. Callers add
   * their own filters on top; they cannot remove these.
   */
  where(table, alias = null) {
    const w = new Where();
    if (!TENANT_TABLES.has(table) && !this.isPlatform) {
      throw new AppError(`Table ${table} is not tenant-scoped; use platformScope().`, { code: 'scope_misuse' });
    }
    const t = this._tenantClause(alias);
    if (t.sql) w.add(t.sql, ...t.params);
    const c = this._companyClause(table, alias);
    if (c.sql) w.add(c.sql, ...c.params);
    return w;
  }

  // ---- Reads ---------------------------------------------------------------

  async first(table, where = {}, columns = '*') {
    const w = this.where(table);
    for (const [k, v] of Object.entries(where)) w.eqIf(k, v);
    const rows = await this.db.many(
      `SELECT ${columns} FROM ${ident(table)} ${w.sql} LIMIT 1`, w.params);
    return rows[0] ?? null;
  }

  /** Fetch by id inside the scope, or throw a 404 (never a cross-tenant leak). */
  async getOrFail(table, id, { columns = '*', resource } = {}) {
    const row = await this.first(table, { id }, columns);
    if (!row) throw new NotFoundError(resource || humanise(table));
    return row;
  }

  /**
   * Every row matching a simple equality filter.
   *
   * The default ordering is `created_at DESC`, which most tables have — but
   * not all (notification_preferences and the singleton settings tables have
   * only `updated_at`). Rather than make every caller remember which, the
   * default is checked against the real schema and falls back, so asking for
   * rows never fails over a column that is merely the usual choice.
   */
  async all(table, where = {}, { columns = '*', order = null, limit = 500 } = {}) {
    const w = this.where(table);
    for (const [k, v] of Object.entries(where)) w.eqIf(k, v);
    const orderBy = order ?? await this.defaultOrder(table);
    return this.db.many(
      `SELECT ${columns} FROM ${ident(table)} ${w.sql} ORDER BY ${orderBy} LIMIT ?`,
      [...w.params, limit]);
  }

  async defaultOrder(table) {
    for (const column of ['created_at', 'updated_at']) {
      if (await this.db.hasColumn(table, column)) return `${column} DESC`;
    }
    return 'rowid';
  }

  async count(table, where = {}) {
    const w = this.where(table);
    for (const [k, v] of Object.entries(where)) w.eqIf(k, v);
    return this.db.count(`SELECT COUNT(*) FROM ${ident(table)} ${w.sql}`, w.params);
  }

  /**
   * Paginated list with a caller-supplied Where. Returns rows plus the total,
   * in two statements, both scoped.
   */
  async paginate(table, w, {
    columns = '*', orderBy = 'created_at DESC', page = 1, pageSize = 25, joins = '', alias = null,
  } = {}) {
    const from = `FROM ${ident(table)}${alias ? ` ${ident(alias)}` : ''} ${joins}`.trim();
    const total = await this.db.count(`SELECT COUNT(*) ${from} ${w.sql}`, w.params);
    const rows = await this.db.many(
      `SELECT ${columns} ${from} ${w.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...w.params, pageSize, (page - 1) * pageSize]);
    return { rows, total, page, pageSize };
  }

  /** Raw SQL that already contains its own scoping — used for reports/joins. */
  async raw(sql, params = []) { return this.db.many(sql, params); }
  async rawOne(sql, params = []) { return this.db.one(sql, params); }
  async rawCount(sql, params = []) { return this.db.count(sql, params); }

  // ---- Writes --------------------------------------------------------------

  /** Insert, stamping tenant_id and timestamps. */
  async insert(table, data) {
    const row = { ...data };
    if (TENANT_TABLES.has(table) && row.tenant_id === undefined) {
      if (!this.tenantId) throw new AppError('Cannot insert without a tenant.', { code: 'scope_missing_tenant' });
      row.tenant_id = this.tenantId;
    }
    if (!this.isPlatform && TENANT_TABLES.has(table) && row.tenant_id !== this.tenantId) {
      throw new ForbiddenError('Refusing to write a record outside your organisation.');
    }
    const ts = nowIso();
    const columns = await this.db.columnsOf(table);
    if (row.created_at === undefined && columns.has('created_at')) row.created_at = ts;
    if (row.updated_at === undefined && columns.has('updated_at')) row.updated_at = ts;
    await this.db.insert(table, row);
    return row;
  }

  /** Update by id within the scope. Returns the number of rows changed. */
  async update(table, id, data) {
    const patch = { ...data };
    delete patch.tenant_id;   // a record never changes owner through an update
    delete patch.id;
    if (patch.updated_at === undefined && (await this.db.hasColumn(table, 'updated_at'))) {
      patch.updated_at = nowIso();
    }

    const where = { id };
    if (!this.isPlatform && TENANT_TABLES.has(table)) where.tenant_id = this.tenantId;
    const changed = await this.db.update(table, where, patch);
    return changed;
  }

  async updateWhere(table, where, data) {
    const scopedWhere = { ...where };
    if (!this.isPlatform && TENANT_TABLES.has(table)) scopedWhere.tenant_id = this.tenantId;
    const patch = { ...data };
    if (patch.updated_at === undefined && (await this.db.hasColumn(table, 'updated_at'))) {
      patch.updated_at = nowIso();
    }
    return this.db.update(table, scopedWhere, patch);
  }

  async delete(table, id) {
    const where = { id };
    if (!this.isPlatform && TENANT_TABLES.has(table)) where.tenant_id = this.tenantId;
    return this.db.deleteWhere(table, where);
  }

  /** Soft delete — the default for anything a compliance auditor may need. */
  async softDelete(table, id) {
    return this.update(table, id, { deleted_at: nowIso() });
  }

  async batch(items) { return this.db.batch(items); }
}



function humanise(table) {
  return table.replace(/_/g, ' ').replace(/s$/, '').replace(/^./, c => c.toUpperCase());
}

/** Build the scope for an authenticated request. */
export function scopeFor(ctx) {
  return new TenantScope(new Db(ctx.env.DB), ctx.tenantId, {
    companyIds: ctx.companyScope,
    actorId: ctx.userId,
  });
}

/**
 * A scope with no tenant predicate. Reserved for the platform Super Admin and
 * for scheduled jobs; every call site is expected to be permission-checked.
 */
export function platformScope(envOrDb, actorId = null) {
  const d1 = envOrDb?.DB ?? envOrDb;
  return new TenantScope(new Db(d1), null, { platform: true, actorId });
}

export { Where, safeOrder };
