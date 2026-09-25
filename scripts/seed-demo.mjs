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
import { ensureBootstrapped } from '../src/services/bootstrap.js';
import { hashPassword } from '../src/auth/password.js';
import { ID } from '../src/utils/id.js';
import { nowIso, dayKey, monthKey, addDays, addHours } from '../src/utils/time.js';
import { PdfDocument } from '../src/services/pdf.js';
import { putObject, documentKey, tenantAssetKey } from '../src/services/storage.js';

/**
 * The password every demonstration account gets.
 *
 * Overridable so a deployed demonstration is not sitting behind a password
 * published in this repository — the seed refuses to write to a production
 * database unless DEMO_PASSWORD is set.
 *
 * Read per call, not once at import. As a module-level constant this was
 * captured the moment the file was first imported, while scripts/seed-guard.mjs
 * reads the variable when it decides. The two could disagree, and the way they
 * disagreed was the dangerous one: the guard saw DEMO_PASSWORD set and allowed
 * the seed, and every account was then created with the password below —
 * published, in this repository, on a Super Admin who can see every
 * organisation. Exactly what the guard exists to stop.
 */
export const PUBLISHED_DEMO_PASSWORD = 'Demo-Passw0rd!24';

export function demoPassword(env = process.env) {
  return env.DEMO_PASSWORD || process.env.DEMO_PASSWORD || PUBLISHED_DEMO_PASSWORD;
}
/** Sits above every organisation, so it belongs to no tenant. */
const PLATFORM_EMAIL = 'devika@meetmillions.example';

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
  // Resolved here, from the environment this call was handed, so it cannot
  // drift from what the guard checked.
  const PASSWORD = demoPassword(env);
  const db = new Db(env.DB);
  const ctx = { env, tenantId: null, userId: null, user: null };

  // A freshly migrated database has tables but no platform catalogue (roles,
  // plans, permissions) — that is seeded by the bootstrap, which the server
  // runs at boot. The CLI must not depend on the server having started once:
  // run it here. It is idempotent and returns immediately once its version
  // marker is written.
  await ensureBootstrapped(env);

  const existing = await db.one("SELECT id FROM tenants WHERE slug LIKE 'meridian%' LIMIT 1");
  if (existing) {
    // "Already seeded" must mean COMPLETE, not merely started: a crash mid
    // seed leaves the tenant row without its owner, and calling that state
    // reused would hide the failure forever.
    const owner = await db.one(
      `SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.tenant_id = ? AND u.email = ? LIMIT 1`,
      [existing.id, 'asha@meridiantax.example']);
    if (!owner) {
      throw new Error(
        'A previous demonstration seed did not finish: the organisation exists but its owner account does not. ' +
        'Fix the original cause, remove the partial organisation (the tenant whose slug starts with "meridian" ' +
        'and its rows), and seed again.');
    }
    return { email: 'asha@meridiantax.example', password: PASSWORD, reused: true };
  }

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

  // ---- A demonstration platform Super Admin --------------------------------
  // The platform screens sit above every organisation, so nobody inside one
  // can reach them. Without this account the demonstration has six screens
  // that cannot be opened. It is created only when no Super Admin exists —
  // a real owner seeded from the environment is never displaced by a demo.
  const superAdminRole = await db.one("SELECT id FROM roles WHERE key = 'super_admin' AND tenant_id IS NULL");
  const platformOwner = await db.one(
    `SELECT u.id FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.tenant_id IS NULL AND ur.role_id = ? LIMIT 1`, [superAdminRole.id]);

  if (!platformOwner) {
    const superAdminId = ID.user();
    await db.insert('users', {
      id: superAdminId,
      tenant_id: null,
      email: PLATFORM_EMAIL,
      password_hash: await hashPassword(PASSWORD),
      full_name: 'Devika Ramanathan',
      job_title: 'Platform Operations',
      status: 'active',
      theme: 'dark',
      is_demo: 1,
      created_at: ts,
      updated_at: ts,
    });
    await db.insert('user_roles', {
      user_id: superAdminId, role_id: superAdminRole.id, assigned_by: user.id, assigned_at: ts,
    });
  }

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

  // ---- The add-ons -----------------------------------------------------------
  // Every module is subscribed, so a demonstration shows the whole product
  // rather than thirty locked cards. Each one still reports its own vendor
  // honestly: subscribed is not the same as connected, and the screens say so.
  const addOns = await db.many('SELECT * FROM add_ons WHERE is_available = 1');
  for (const addOn of addOns) {
    await db.insert('add_on_subscriptions', {
      id: ID.addOnSub(),
      tenant_id: tenant.id,
      add_on_id: addOn.id,
      status: 'active',
      activated_at: addDays(-20),
      activated_by: user.id,
      billing_cycle: 'monthly',
      monthly_price_paise: addOn.monthly_price_paise,
      setup_fee_paise: addOn.setup_fee_paise,
      setup_fee_charged: 1,
      current_period_start: addDays(-20),
      current_period_end: addDays(10),
      created_at: addDays(-20),
      updated_at: addDays(-20),
    });
  }

  // ---- Voice notes ---------------------------------------------------------
  // Real playable audio, so the player on the screen is a player and not a
  // decoration. Speech-to-text has no credentials on a demo deployment, so the
  // transcript status says exactly that rather than pretending.
  const VOICE_NOTE_SECONDS = [14, 9, 21];
  for (const [i, seconds] of VOICE_NOTE_SECONDS.entries()) {
    const entry = created[i % created.length];
    const noteId = ID.voiceNote();
    const key = tenantAssetKey({
      tenantId: tenant.id, kind: 'voice-notes', id: noteId, fileName: 'voice-note.wav',
    });
    const audio = silentWav(seconds);
    const stored = await putObject(env, key, audio, {
      contentType: 'audio/wav', fileName: 'voice-note.wav',
      metadata: { tenantId: tenant.id, voiceNoteId: noteId },
    });
    await db.insert('voice_notes', {
      id: noteId,
      tenant_id: tenant.id,
      client_id: entry.client.id,
      entity_type: 'client',
      entity_id: entry.client.id,
      author_id: executives[i % Math.max(1, executives.length)] ?? user.id,
      storage_key: key,
      mime_type: 'audio/wav',
      duration_seconds: seconds,
      size_bytes: stored.size,
      // A demo cannot be transcribed without speech credentials, and saying so
      // is the point: the screen has to show that state honestly.
      transcript_status: 'not_configured',
      created_at: addDays(-i - 1),
    });
  }

  // ---- The working week: tasks, tickets, leads, chat and the calendar -----
  // These exist so every screen has something honest to show. Without them a
  // demonstration ends at the first empty board, and an empty board teaches
  // nobody what the product does.
  const executive = executives[0] ?? user.id;

  const TASKS = [
    { title: 'Chase the missing bank statement for March', client: 0, status: 'todo', priority: 'high', due: 1, type: 'follow_up', assignee: executive },
    { title: 'Reconcile GSTR-2B against the purchase register', client: 0, status: 'in_progress', priority: 'normal', due: 3, type: 'reconciliation', assignee: executive },
    { title: 'Waiting on the client to confirm the GSTIN correction', client: 1, status: 'blocked', priority: 'high', due: -1, type: 'follow_up', assignee: executive },
    { title: 'Review the September GST computation before filing', client: 0, status: 'review', priority: 'urgent', due: 2, type: 'filing', assignee: user.id },
    { title: 'Send the signed engagement letter to the new client', client: 4, status: 'todo', priority: 'normal', due: 5, type: 'onboarding', assignee: user.id },
    { title: 'Collect the outstanding invoice from Northline', client: 1, status: 'todo', priority: 'normal', due: 7, type: 'collection', assignee: executive },
    { title: 'File GSTR-1 for Vantara Foods', client: 2, status: 'done', priority: 'normal', due: -3, type: 'filing', assignee: executive },
  ];

  for (const task of TASKS) {
    const entry = created[task.client];
    await db.insert('tasks', {
      id: ID.task(),
      tenant_id: tenant.id,
      company_id: entry.company.id,
      client_id: entry.client.id,
      filing_period_id: entry.period.id,
      title: task.title,
      type: task.type,
      status: task.status,
      priority: task.priority,
      assigned_to: task.assignee,
      created_by: user.id,
      due_at: addDays(task.due),
      completed_at: task.status === 'done' ? addDays(task.due) : null,
      created_at: addDays(-4),
      updated_at: addDays(-1),
    });
  }

  const TICKETS = [
    {
      subject: 'Cannot upload a 30MB scanned ledger',
      description: 'The upload stops at about 80% every time. The file is a single PDF of about 30MB scanned from our accounts ledger.',
      category: 'technical', priority: 'high', status: 'open', client: 0,
    },
    {
      subject: 'Invoice MM/2026-27/0002 shows the wrong GSTIN',
      description: 'Our GSTIN on the invoice is the old one from before we moved offices. Could this be corrected and reissued?',
      category: 'billing', priority: 'normal', status: 'in_progress', client: 1,
    },
    {
      subject: 'Request: add a second login for our accounts assistant',
      description: 'We would like our accounts assistant to upload documents without sharing my login.',
      category: 'account', priority: 'low', status: 'waiting_internal', client: 3,
    },
  ];

  for (const [i, ticket] of TICKETS.entries()) {
    const entry = created[ticket.client];
    await db.insert('support_tickets', {
      id: ID.ticket(),
      tenant_id: tenant.id,
      client_id: entry.client.id,
      company_id: entry.company.id,
      ticket_no: `TKT-${String(i + 1).padStart(5, '0')}`,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      raised_by: entry.portalUser?.id ?? null,
      assigned_to: ticket.status === 'open' ? null : executive,
      channel: 'portal',
      first_response_at: ticket.status === 'open' ? null : addDays(-i),
      sla_due_at: addHours(ticket.priority === 'high' ? 8 : 24),
      message_count: ticket.status === 'open' ? 1 : 2,
      created_at: addDays(-i - 1),
      updated_at: addDays(-i),
    });
  }

  const LEADS = [
    { fullName: 'Harish Venkatesh', company: 'Anvaya Exports', city: 'Coimbatore', source: 'website_form', status: 'new', message: 'Looking for monthly GST filing for a small export business.' },
    { fullName: 'Fatima Sheikh', company: 'Blue Meridian Interiors', city: 'Hyderabad', source: 'meta_ads', status: 'contacted', message: 'Need help with TDS returns and bookkeeping.' },
    { fullName: 'Deepak Chandra', company: 'Chandra & Sons Hardware', city: 'Chennai', source: 'referral', status: 'qualified', message: 'Referred by Radiant Traders. Two GSTINs across two states.' },
    { fullName: 'Ritu Malhotra', company: 'Saffron Studio', city: 'Pune', source: 'google_form', status: 'new', message: 'Freelance design studio, first year of GST registration.' },
  ];

  for (const [i, lead] of LEADS.entries()) {
    await db.insert('leads', {
      id: ID.lead(),
      tenant_id: tenant.id,
      source: lead.source,
      full_name: lead.fullName,
      email: `${lead.fullName.split(' ')[0].toLowerCase()}@${lead.company.split(' ')[0].toLowerCase()}.example`,
      phone: `98${String(45012000 + i * 137).padStart(8, '0')}`,
      company_name: lead.company,
      city: lead.city,
      message: lead.message,
      status: lead.status,
      assigned_to: lead.status === 'new' ? null : manager,
      assigned_at: lead.status === 'new' ? null : addDays(-i),
      score: 40 + i * 15,
      last_contacted_at: lead.status === 'new' ? null : addDays(-i),
      created_at: addDays(-i - 1),
      updated_at: addDays(-i),
    });
  }

  // One WhatsApp conversation, so the inbox is not an empty shell.
  const threadId = ID.thread();
  await db.insert('chat_threads', {
    id: threadId,
    tenant_id: tenant.id,
    channel: 'whatsapp',
    client_id: created[0].client.id,
    phone: `+91${CLIENTS[0].contactPhone}`,
    display_name: CLIENTS[0].contactName,
    assigned_to: executive,
    status: 'open',
    unread_count: 1,
    last_message_at: addHours(-2),
    last_message_preview: 'Sending the corrected invoice now.',
    created_at: addDays(-2),
    updated_at: addHours(-2),
  });

  const CHAT = [
    { direction: 'outbound', body: 'Good morning Priya — the purchase invoice from Anand Traders is missing its GSTIN. Could you send a corrected copy?', at: addDays(-2) },
    { direction: 'inbound', body: 'Morning. Let me check with them and come back to you.', at: addDays(-1) },
    { direction: 'inbound', body: 'Sending the corrected invoice now.', at: addHours(-2) },
  ];

  for (const message of CHAT) {
    await db.insert('chat_messages', {
      id: ID.message(),
      tenant_id: tenant.id,
      thread_id: threadId,
      direction: message.direction,
      type: 'text',
      body: message.body,
      sent_by: message.direction === 'outbound' ? executive : null,
      status: message.direction === 'outbound' ? 'delivered' : 'received',
      created_at: message.at,
    });
  }

  const EVENTS = [
    { title: 'GSTR-1 filing deadline', kind: 'filing_deadline', client: 0, inDays: 3, hours: 0, allDay: 1 },
    { title: 'Quarterly review with Northline Textiles', kind: 'meeting', client: 1, inDays: 5, hours: 11 },
    { title: 'Site visit — Kestrel Logistics warehouse', kind: 'visit', client: 3, inDays: 8, hours: 15 },
    { title: 'Call Solaris Apparel about onboarding documents', kind: 'call', client: 4, inDays: 1, hours: 16 },
    { title: 'Partners’ review of the month’s filings', kind: 'meeting', client: 0, inDays: 2, hours: 10, owner: 'admin' },
  ];

  for (const event of EVENTS) {
    const start = event.allDay
      ? `${dayKey(addDays(event.inDays))}T00:00:00.000Z`
      : addHours(event.inDays * 24 + event.hours);
    await db.insert('calendar_events', {
      id: ID.event(),
      tenant_id: tenant.id,
      client_id: created[event.client].client.id,
      owner_id: event.owner === 'admin' ? user.id : (event.kind === 'meeting' ? manager : executive),
      title: event.title,
      kind: event.kind,
      starts_at: start,
      ends_at: event.allDay ? start : addHours(event.inDays * 24 + event.hours + 1),
      all_day: event.allDay ?? 0,
      status: 'confirmed',
      sync_status: 'local',
      created_at: addDays(-2),
      updated_at: addDays(-2),
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
    platformEmail: PLATFORM_EMAIL,
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

/**
 * A playable WAV of silence.
 *
 * Demonstration audio has to be real audio: a fake byte string would give the
 * player something it cannot decode, and a broken player looks like a broken
 * feature. 8kHz mono PCM is the smallest thing every browser will play.
 */
function silentWav(seconds) {
  const rate = 8000;
  const samples = Math.max(1, Math.round(rate * seconds));
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM header length
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);    // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  // The samples themselves stay zero — silence.
  return buffer;
}
