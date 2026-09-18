/**
 * Global search — what the command palette (Ctrl/Cmd-K) queries.
 *
 * Every source is filtered by the caller's own permissions before it is
 * searched, not after. A result list that omits rows the caller may not see is
 * correct; one that returns them and hides them in the UI is a leak waiting
 * for someone to open dev tools.
 */

import { createRouter } from '../http/router.js';
import { ok } from '../http/response.js';
import { Db } from '../db/client.js';
import { scopeFor, platformScope } from '../db/tenancy.js';
import { loadClientIdsForUser } from '../auth/identity.js';
import { formatINR } from '../utils/money.js';
import { navigationFor } from '../services/navigation.js';

const router = createRouter();

router.get('/', async (ctx) => {
  const term = (ctx.q('q') ?? '').trim();
  const limitPerGroup = Math.min(ctx.qInt('limit', 5), 20);

  if (term.length < 2) {
    return ok({
      term,
      groups: [],
      // With nothing typed the palette still has something useful to offer:
      // the screens this particular person is allowed to open.
      suggestions: await navigationSuggestions(ctx),
      message: term ? 'Type at least two characters.' : null,
    }, { ctx });
  }

  const like = `%${term.toLowerCase()}%`;
  const groups = [];

  // The platform Super Admin belongs to no organisation, so there is no tenant
  // scope to search within. What they are actually looking for is an
  // organisation, so that is what the palette finds for them.
  if (!ctx.tenantId) {
    if (!ctx.has('platform.manage')) return ok({ term, groups: [], suggestions: [] }, { ctx });
    const rows = await platformScope(ctx.env, ctx.userId).raw(
      `SELECT id, name, slug, status, gstin
         FROM tenants
        WHERE deleted_at IS NULL
          AND (LOWER(name) LIKE ? OR LOWER(slug) LIKE ?
               OR LOWER(COALESCE(legal_name,'')) LIKE ?
               OR LOWER(COALESCE(gstin,'')) LIKE ?
               OR LOWER(email) LIKE ?)
        ORDER BY name LIMIT ?`,
      [like, like, like, like, like, limitPerGroup]);
    push(groups, 'Organisations', 'building', rows.map(r => ({
      id: r.id,
      title: r.name,
      subtitle: [r.slug, r.gstin].filter(Boolean).join(' · '),
      badge: r.status,
      // There is no per-organisation URL — the list opens each one in place —
      // so this lands on the list already filtered to it.
      path: `/platform/organisations?q=${encodeURIComponent(r.name)}`,
    })));
    return ok({ term, groups, suggestions: await navigationSuggestions(ctx) }, { ctx });
  }

  const scope = scopeFor(ctx);

  // A client user is confined to their own records, whatever they search for.
  const clientIds = ctx.isClient
    ? await loadClientIdsForUser(new Db(ctx.env.DB), ctx.userId, ctx.tenantId)
    : null;
  if (ctx.isClient && !clientIds.length) {
    return ok({ term, groups: [], suggestions: [] }, { ctx });
  }
  const clientParams = clientIds ?? [];

  if (ctx.has('clients.view') || ctx.has('clients.view.own') || ctx.isClient) {
    const rows = await scope.raw(
      `SELECT c.id, c.display_name, c.client_code, c.status, co.gstin
         FROM clients c LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.tenant_id = ? AND c.deleted_at IS NULL
          ${clientIds ? `AND c.id IN (${clientIds.map(() => '?').join(',')})` : ''}
          AND (LOWER(c.display_name) LIKE ? OR LOWER(c.client_code) LIKE ?
               OR LOWER(COALESCE(co.gstin,'')) LIKE ?
               OR LOWER(COALESCE(c.primary_contact_name,'')) LIKE ?
               OR LOWER(COALESCE(c.primary_contact_email,'')) LIKE ?
               OR COALESCE(c.primary_contact_phone,'') LIKE ?)
        ORDER BY c.display_name LIMIT ?`,
      [ctx.tenantId, ...clientParams, like, like, like, like, like, `%${term}%`, limitPerGroup]);
    push(groups, 'Clients', 'users', rows.map(r => ({
      id: r.id,
      title: r.display_name,
      subtitle: [r.client_code, r.gstin].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/clients/${r.id}`,
    })));
  }

  if (ctx.has('documents.view') || ctx.has('documents.view.own') || ctx.isClient) {
    const rows = await scope.raw(
      `SELECT d.id, d.title, d.status, d.created_at, c.display_name AS client_name,
              v.file_name
         FROM documents d
         LEFT JOIN clients c ON c.id = d.client_id
         LEFT JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.tenant_id = ? AND d.deleted_at IS NULL
          ${clientIds ? `AND d.client_id IN (${clientIds.map(() => '?').join(',')})` : ''}
          AND (LOWER(d.title) LIKE ? OR LOWER(COALESCE(v.file_name,'')) LIKE ?
               OR LOWER(COALESCE(d.description,'')) LIKE ?)
        ORDER BY d.created_at DESC LIMIT ?`,
      [ctx.tenantId, ...clientParams, like, like, like, limitPerGroup]);
    push(groups, 'Documents', 'file', rows.map(r => ({
      id: r.id,
      title: r.title,
      subtitle: [r.client_name, r.file_name].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/documents/${r.id}`,
    })));
  }

  if (ctx.has('reports.view') || ctx.has('reports.view.own') || ctx.isClient) {
    const rows = await scope.raw(
      `SELECT r.id, r.title, r.reference_no, r.status, r.period_key, c.display_name AS client_name
         FROM reports r LEFT JOIN clients c ON c.id = r.client_id
        WHERE r.tenant_id = ? ${clientIds ? `AND r.client_id IN (${clientIds.map(() => '?').join(',')})` : ''}
          ${ctx.isClient ? "AND r.status IN ('approved','signed_off','archived')" : ''}
          AND (LOWER(r.title) LIKE ? OR LOWER(r.reference_no) LIKE ?)
        ORDER BY r.created_at DESC LIMIT ?`,
      [ctx.tenantId, ...clientParams, like, like, limitPerGroup]);
    push(groups, 'Reports', 'report', rows.map(r => ({
      id: r.id,
      title: r.title,
      subtitle: [r.reference_no, r.period_key, r.client_name].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/reports/${r.id}`,
    })));
  }

  if (ctx.has('invoices.view') || ctx.isClient) {
    const rows = await scope.raw(
      `SELECT i.id, i.invoice_no, i.status, i.total_paise, i.due_date, c.display_name AS client_name
         FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
        WHERE i.tenant_id = ? ${clientIds ? `AND i.client_id IN (${clientIds.map(() => '?').join(',')})` : ''}
          AND (LOWER(i.invoice_no) LIKE ? OR LOWER(COALESCE(i.billing_name,'')) LIKE ?)
        ORDER BY i.issue_date DESC LIMIT ?`,
      [ctx.tenantId, ...clientParams, like, like, limitPerGroup]);
    push(groups, 'Invoices', 'rupee', rows.map(r => ({
      id: r.id,
      title: r.invoice_no,
      subtitle: [r.client_name, formatINR(r.total_paise)].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/billing/invoices/${r.id}`,
    })));
  }

  if (ctx.has('users.view')) {
    const rows = await scope.raw(
      `SELECT id, full_name, email, job_title, status FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL
          AND (LOWER(full_name) LIKE ? OR LOWER(email) LIKE ?)
        ORDER BY full_name LIMIT ?`,
      [ctx.tenantId, like, like, limitPerGroup]);
    push(groups, 'Team', 'team', rows.map(r => ({
      id: r.id,
      title: r.full_name,
      subtitle: [r.job_title, r.email].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/users/${r.id}`,
    })));
  }

  if (ctx.has('queries.view') || ctx.isClient) {
    const rows = await scope.raw(
      `SELECT q.id, q.subject, q.status, q.priority, c.display_name AS client_name
         FROM queries q LEFT JOIN clients c ON c.id = q.client_id
        WHERE q.tenant_id = ? ${clientIds ? `AND q.client_id IN (${clientIds.map(() => '?').join(',')})` : ''}
          AND LOWER(q.subject) LIKE ?
        ORDER BY q.created_at DESC LIMIT ?`,
      [ctx.tenantId, ...clientParams, like, limitPerGroup]);
    push(groups, 'Queries', 'message', rows.map(r => ({
      id: r.id,
      title: r.subject,
      subtitle: r.client_name ?? '',
      badge: r.status,
      path: `/queries/${r.id}`,
    })));
  }

  if (ctx.has('calls.view')) {
    const rows = await scope.raw(
      `SELECT cr.id, cr.from_number, cr.to_number, cr.status, cr.direction,
              cr.created_at, c.display_name AS client_name
         FROM call_records cr LEFT JOIN clients c ON c.id = cr.client_id
        WHERE cr.tenant_id = ?
          AND (cr.from_number LIKE ? OR cr.to_number LIKE ?)
        ORDER BY cr.created_at DESC LIMIT ?`,
      [ctx.tenantId, `%${term}%`, `%${term}%`, limitPerGroup]);
    push(groups, 'Calls', 'phone', rows.map(r => ({
      id: r.id,
      title: r.direction === 'inbound' ? r.from_number : r.to_number,
      subtitle: [r.client_name, r.created_at?.slice(0, 10)].filter(Boolean).join(' · '),
      badge: r.status,
      path: `/calls/${r.id}`,
    })));
  }

  // Screens the caller may open, matched by name — often the fastest route.
  const screens = (await navigationSuggestions(ctx))
    .filter(s => s.title.toLowerCase().includes(term.toLowerCase()));
  if (screens.length) groups.unshift({ group: 'Go to', icon: 'compass', items: screens.slice(0, limitPerGroup) });

  return ok({
    term,
    groups,
    totalResults: groups.reduce((n, g) => n + g.items.length, 0),
  }, { ctx });
}, { auth: true });

async function navigationSuggestions(ctx) {
  const nav = await navigationFor(ctx);
  const out = [];
  for (const group of nav.groups ?? []) {
    for (const item of group.items ?? []) {
      // A locked item is offered and marked, so the palette can explain why it
      // will not open rather than pretending the screen does not exist.
      out.push({
        id: item.key,
        title: item.label,
        subtitle: group.label,
        path: item.path,
        icon: item.icon,
        locked: !!item.locked,
        lock: item.lock ?? null,
      });
    }
  }
  return out;
}

function push(groups, label, icon, items) {
  if (items.length) groups.push({ group: label, icon, items });
}

export { router as searchRouter };
