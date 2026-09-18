/**
 * Demonstration data.
 *
 * A worked example of a small Chennai practice: five client companies, a
 * month of documents at every stage of the workflow, computed GST, an invoice
 * that has been paid and one that has not, a query thread, and a few calls.
 *
 * Everything is invented. The organisation, the people and the figures are
 * fictional, every record is flagged `is_demo`, and the tenant is marked as a
 * demonstration so the interface can say so in a banner — a demo that looks
 * indistinguishable from real data is how somebody ends up filing it.
 */

import { Db } from '../src/db/client.js';
import { TenantScope } from '../src/db/tenancy.js';
import { provisionTenant, provisionClient, openFilingPeriod } from '../src/services/provisioning.js';
import { hashPassword } from '../src/auth/password.js';
import { ID } from '../src/utils/id.js';
import { nowIso, dayKey, monthKey, addDays, addHours } from '../src/utils/time.js';
import { PdfDocument } from '../src/services/pdf.js';
import { putObject, documentKey } from '../src/services/storage.js';

const PASSWORD = 'Demo-Passw0rd!24';

/** Five invented client companies, spread across states so GST varies. */
const CLIENTS = [
  {
    displayName: 'Radiant Traders', companyName: 'Radiant Traders Private Limited',
    gstin: '33AACCN5678K1Z3', pan: 'AACCN5678K', stateCode: '33',
    contactName: 'Priya Sharma', contactEmail: 'priya@radianttraders.example',
    contactPhone: '9845012233',
  },
  {
    displayName: 'Northline Textiles', companyName: 'Northline Textiles Private Limited',
    gstin: '29AADCV9012L1ZX', pan: 'AADCV9012L', stateCode: '29',
    contactName: 'Rahul Nair', contactEmail: 'rahul@northlinetextiles.example',
    contactPhone: '9822011456',
  },
  {
    displayName: 'Vantara Foods', companyName: 'Vantara Foods LLP',
    gstin: '27AAECK3456N1Z3', pan: 'AAECK3456N', stateCode: '27',
    contactName: 'Meera Joshi', contactEmail: 'meera@vantarafoods.example',
    contactPhone: '9820044113',
  },
  {
    displayName: 'Kestrel Logistics', companyName: 'Kestrel Logistics Private Limited',
    gstin: '24AAJCB1357S1Z7', pan: 'AAJCB1357S', stateCode: '24',
    contactName: 'Imran Qureshi', contactEmail: 'imran@kestrellogistics.example',
    contactPhone: '9898011224',
  },
  {
    displayName: 'Solaris Apparel', companyName: 'Solaris Apparel LLP',
    gstin: '33AAFCS7890P1ZJ', pan: 'AAFCS7890P', stateCode: '33',
    contactName: 'Divya Menon', contactEmail: 'divya@solarisapparel.example',
    contactPhone: '9840055221',
  },
];

const STAFF = [
  { fullName: 'Vikram Rao', email: 'vikram@meridiantax.example', role: 'finance_manager', title: 'Finance Manager' },
  { fullName: 'Sneha Pillai', email: 'sneha@meridiantax.example', role: 'finance_executive', title: 'Finance Executive' },
  { fullName: 'Arjun Das', email: 'arjun@meridiantax.example', role: 'finance_executive', title: 'Finance Executive' },
  { fullName: 'Lakshmi Iyer', email: 'lakshmi@meridiantax.example', role: 'accountant', title: 'Accountant' },
  { fullName: 'Nandini Rao', email: 'nandini@meridiantax.example', role: 'auditor', title: 'Internal Auditor' },
];

export async function seedDemoData(env) {
  const db = new Db(env.DB);
  const ctx = { env, tenantId: null, userId: null, user: null };

  const existing = await db.one("SELECT id FROM tenants WHERE slug LIKE 'meridian%' LIMIT 1");
  if (existing) return { email: 'asha@meridiantax.example', password: PASSWORD, reused: true };

  // ---- The practice --------------------------------------------------------
  const { tenant, company, user, scope } = await provisionTenant(ctx, {
    organisationName: 'Meridian Tax Associates',
    ownerName: 'Asha Menon',
    ownerEmail: 'asha@meridiantax.example',
    ownerPhone: '9845012200',
    passwordHash: await hashPassword(PASSWORD),
    companyName: 'Meridian Tax Associates LLP',
    gstin: '33AABCR1234M1ZK',
    pan: 'AABCR1234M',
    tan: 'CHEN12345A',
    stateCode: '33',
    planKey: 'pro',
    isDemo: true,
  });

  const tenantScope = new TenantScope(db, tenant.id);
  const ts = nowIso();

  // ---- Staff ---------------------------------------------------------------
  const staffIds = {};
  for (const person of STAFF) {
    const userId = ID.user();
    await db.insert('users', {
      id: userId,
      tenant_id: tenant.id,
      email: person.email,
      password_hash: await hashPassword(PASSWORD),
      full_name: person.fullName,
      job_title: person.title,
      status: 'active',
      theme: 'dark',
      is_demo: 1,
      created_at: ts,
      updated_at: ts,
    });
    const role = await db.one('SELECT id FROM roles WHERE key = ? AND tenant_id IS NULL', [person.role]);
    await db.insert('user_roles', {
      user_id: userId, role_id: role.id, assigned_by: user.id, assigned_at: ts,
    });
    staffIds[person.role] = staffIds[person.role] ?? [];
    staffIds[person.role].push(userId);
  }

  const executives = staffIds.finance_executive ?? [];
  const manager = staffIds.finance_manager?.[0] ?? user.id;

  // ---- Clients, each with an open filing period ----------------------------
  const created = [];
  for (const [i, spec] of CLIENTS.entries()) {
    const result = await provisionClient(tenantScope, db, {
      ...spec,
      passwordHash: await hashPassword(PASSWORD),
      assignedExecutiveId: executives[i % Math.max(1, executives.length)] ?? user.id,
      assignedManagerId: manager,
      createdBy: user.id,
      isDemo: true,
      source: 'referral',
    });
    const { period } = await openFilingPeriod(tenantScope, db, {
      clientId: result.client.id,
      companyId: result.company.id,
      periodKey: monthKey(),
    });
    created.push({ ...result, period });
  }

  // ---- Documents, spread across the workflow -------------------------------
  const docTypes = await db.many('SELECT id, key, name FROM document_types LIMIT 8');
  const STAGES = [
    { status: 'verified', count: 6 },
    { status: 'under_review', count: 3 },
    { status: 'submitted', count: 4 },
    { status: 'query_raised', count: 1 },
    { status: 'rejected', count: 1 },
  ];

  let docIndex = 0;
  for (const entry of created) {
    for (const stage of STAGES) {
      for (let i = 0; i < stage.count; i++) {
        const type = docTypes[docIndex % docTypes.length];
        docIndex += 1;
        const documentId = ID.document();
        const versionId = ID.version();
        const uploadedAt = addDays(-(docIndex % 20) - 1);

        await db.insert('documents', {
          id: documentId,
          tenant_id: tenant.id,
          company_id: entry.company.id,
          client_id: entry.client.id,
          filing_period_id: entry.period.id,
          document_type_id: type.id,
          title: `${type.name} — ${monthKey()}`,
          period_key: monthKey(),
          current_version_id: versionId,
          version_count: 1,
          status: stage.status,
          priority: 'normal',
          assigned_to: executives[docIndex % Math.max(1, executives.length)] ?? user.id,
          verified_by: stage.status === 'verified' ? (executives[0] ?? user.id) : null,
          verified_at: stage.status === 'verified' ? addDays(-(docIndex % 10)) : null,
          rejected_reason: stage.status === 'rejected'
            ? 'The invoice total does not match the GST charged. Please send a corrected copy.'
            : null,
          source: 'portal',
          sla_due_at: addHours(48, new Date(uploadedAt)),
          submitted_at: uploadedAt,
          created_by: entry.portalUser?.id ?? user.id,
          created_at: uploadedAt,
          updated_at: uploadedAt,
        });

        // A real, if plain, PDF is written to storage for each document. A
        // catalogue row with no bytes behind it would give the demo a download
        // button that does nothing, which is exactly what this project is not
        // allowed to ship.
        const fileName = `${type.key}-${monthKey()}.pdf`;
        const bytes = placeholderPdf({
          title: `${type.name} — ${monthKey()}`,
          client: entry.client.display_name,
          status: stage.status,
        });
        const key = documentKey({
          tenantId: tenant.id,
          companyId: entry.company.id,
          clientId: entry.client.id,
          documentId,
          versionId,
          fileName,
        });
        await putObject(env, key, bytes, { contentType: 'application/pdf', fileName });

        await db.insert('document_versions', {
          id: versionId,
          tenant_id: tenant.id,
          document_id: documentId,
          version_no: 1,
          file_name: fileName,
          mime_type: 'application/pdf',
          size_bytes: bytes.length,
          storage_key: key,
          checksum_sha256: null,
          uploaded_by: entry.portalUser?.id ?? user.id,
          created_at: uploadedAt,
        });
      }
    }
  }

  // ---- A query thread ------------------------------------------------------
  const queried = await db.one(
    "SELECT * FROM documents WHERE tenant_id = ? AND status = 'query_raised' LIMIT 1", [tenant.id]);
  if (queried) {
    const queryId = ID.query();
    await db.insert('queries', {
      id: queryId,
      tenant_id: tenant.id,
      client_id: queried.client_id,
      company_id: queried.company_id,
      document_id: queried.id,
      filing_period_id: queried.filing_period_id,
      reference_no: 'QRY-00001',
      subject: 'Purchase invoice is missing its GSTIN',
      body: 'The supplier GSTIN is not printed on this invoice, so input credit cannot be claimed against it. Could you send a copy that shows it?',
      category: 'missing',
      priority: 'high',
      status: 'client_responded',
      reply_count: 1,
      raised_by: executives[0] ?? user.id,
      created_at: addDays(-2),
      updated_at: addDays(-1),
    });
    await db.insert('query_replies', {
      id: ID.reply(),
      tenant_id: tenant.id,
      query_id: queryId,
      author_id: null,
      body: 'Thank you — I have asked the supplier for a corrected invoice and will upload it this week.',
      visibility: 'shared',
      channel: 'portal',
      created_at: addDays(-1),
    });
  }

  // ---- Computed GST for one client ----------------------------------------
  const first = created[0];
  const computationId = ID.computation();
  await db.insert('tax_computations', {
    id: computationId,
    tenant_id: tenant.id,
    company_id: first.company.id,
    client_id: first.client.id,
    filing_period_id: first.period.id,
    regime: 'gst',
    period_type: 'monthly',
    period_key: monthKey(),
    status: 'draft',
    taxable_value_paise: 421860000,
    cgst_paise: 37967400,
    sgst_paise: 37967400,
    igst_paise: 11242000,
    cess_paise: 0,
    total_tax_paise: 87176800,
    itc_total_paise: 31240000,
    net_payable_paise: 55936800,
    computed_by: staffIds.accountant?.[0] ?? user.id,
    computed_at: ts,
    created_at: ts,
    updated_at: ts,
  });

  // ---- Invoices: one paid, one outstanding --------------------------------
  const paidInvoice = ID.invoice();
  await db.insert('invoices', {
    id: paidInvoice,
    tenant_id: tenant.id,
    client_id: first.client.id,
    company_id: first.company.id,
    invoice_no: 'MM/2026-27/0001',
    direction: 'tenant_to_client',
    kind: 'service',
    status: 'paid',
    subtotal_paise: 1500000,
    tax_paise: 270000,
    cgst_paise: 135000,
    sgst_paise: 135000,
    total_paise: 1770000,
    amount_paid_paise: 1770000,
    amount_due_paise: 0,
    issue_date: dayKey(addDays(-35)),
    due_date: dayKey(addDays(-20)),
    paid_at: addDays(-22),
    billing_name: first.client.display_name,
    place_of_supply: '33',
    created_by: user.id,
    created_at: addDays(-35),
    updated_at: addDays(-22),
  });
  await db.insert('payments', {
    id: ID.payment(),
    tenant_id: tenant.id,
    invoice_id: paidInvoice,
    client_id: first.client.id,
    reference_no: 'PAY-000001',
    gateway: 'offline',
    method: 'bank_transfer',
    amount_paise: 1770000,
    currency: 'INR',
    status: 'success',
    receipt_no: 'RCP-000001',
    paid_at: addDays(-22),
    initiated_by: user.id,
    created_at: addDays(-22),
    updated_at: addDays(-22),
  });

  await db.insert('invoices', {
    id: ID.invoice(),
    tenant_id: tenant.id,
    client_id: created[1].client.id,
    company_id: created[1].company.id,
    invoice_no: 'MM/2026-27/0002',
    direction: 'tenant_to_client',
    kind: 'service',
    status: 'sent',
    subtotal_paise: 2500000,
    tax_paise: 450000,
    igst_paise: 450000,
    total_paise: 2950000,
    amount_paid_paise: 0,
    amount_due_paise: 2950000,
    issue_date: dayKey(addDays(-8)),
    due_date: dayKey(addDays(7)),
    billing_name: created[1].client.display_name,
    place_of_supply: '29',
    created_by: user.id,
    created_at: addDays(-8),
    updated_at: addDays(-8),
  });

  // ---- A few calls ---------------------------------------------------------
  for (const [i, entry] of created.slice(0, 3).entries()) {
    await db.insert('call_records', {
      id: ID.call(),
      tenant_id: tenant.id,
      company_id: entry.company.id,
      client_id: entry.client.id,
      agent_id: executives[i % Math.max(1, executives.length)] ?? user.id,
      provider: 'exotel',
      direction: i === 1 ? 'inbound' : 'outbound',
      from_number: '+919845012200',
      to_number: `+91${CLIENTS[i].contactPhone}`,
      status: i === 2 ? 'missed' : 'completed',
      answered: i === 2 ? 0 : 1,
      started_at: addDays(-i - 1),
      ended_at: addDays(-i - 1),
      duration_seconds: i === 2 ? 0 : 180 + i * 95,
      talk_seconds: i === 2 ? 0 : 170 + i * 90,
      created_at: addDays(-i - 1),
      updated_at: addDays(-i - 1),
    });
  }

  // ---- Refresh the derived period counters --------------------------------
  const { refreshFilingPeriod } = await import('../src/services/workflow.js');
  for (const entry of created) {
    await refreshFilingPeriod(tenantScope, entry.period.id);
  }

  return {
    email: 'asha@meridiantax.example',
    password: PASSWORD,
    tenantId: tenant.id,
    clients: created.length,
    staff: STAFF.length,
    reused: false,
  };
}

/**
 * A one-page PDF standing in for a scanned document.
 *
 * It says on its face that it is demonstration data, so a page printed or
 * forwarded from this organisation cannot be mistaken for a real filing.
 */
function placeholderPdf({ title, client, status }) {
  const doc = new PdfDocument({ title, subject: 'Demonstration document' });
  doc.heading(title, { size: 16 });
  doc.text(client, 56, doc.y, { size: 11, colour: '#4A5B7A' });
  doc.y -= 28;
  doc.text(`Status: ${status.replace(/_/g, ' ')}`, 56, doc.y, { size: 10 });
  doc.y -= 18;
  doc.text(`Period: ${monthKey()}`, 56, doc.y, { size: 10 });
  doc.y -= 40;
  doc.text('DEMONSTRATION DATA', 56, doc.y, { size: 20, bold: true, colour: '#B45309' });
  doc.y -= 24;
  doc.text('This file was generated to populate a demonstration organisation.', 56, doc.y, { size: 10, colour: '#4A5B7A' });
  doc.y -= 14;
  doc.text('It is not a real invoice, return or statement, and must not be filed.', 56, doc.y, { size: 10, colour: '#4A5B7A' });
  return doc.render();
}
