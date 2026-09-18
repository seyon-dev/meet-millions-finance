import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, registerOrg, createUserWithRole, setPlan, firstTenantId, testFile } from './helpers/app.js';

/**
 * Filters that actually filter.
 *
 * Every one of these was a control on a screen that sent a query name no
 * endpoint read: the dropdown moved, the list did not. Nothing reported it,
 * because an ignored query parameter is not an error. These tests are the
 * report.
 */
describe('List filters', () => {
  async function setup() {
    const app = await createApp();
    const { res } = await registerOrg(app);
    const adminToken = res.data.token;
    const tenantId = await firstTenantId(app);
    await setPlan(app, tenantId, 'pro');
    return { app, adminToken, tenantId };
  }

  test('the team list separates the people who work here from client logins', async () => {
    const { app, adminToken, tenantId } = await setup();

    await createUserWithRole(app, {
      tenantId, email: 'vikram@meridian.test', fullName: 'Vikram Rao', roleKey: 'finance_manager',
    });
    await createUserWithRole(app, {
      tenantId, email: 'sneha@meridian.test', fullName: 'Sneha Pillai', roleKey: 'finance_executive',
    });
    // A client's own login lives in the same table.
    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Radiant Traders Pvt Ltd',
        companyName: 'Radiant Traders Private Limited',
        gstin: '33AACCN5678K1Z3',
        pan: 'AACCN5678K',
        contactName: 'Priya Sharma',
        contactEmail: 'priya@radianttraders.test',
        contactPhone: '9845012233',
        createPortalLogin: true,
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));

    const everyone = await app.request('/api/users', { token: adminToken });
    const staff = await app.request('/api/users?staff=true', { token: adminToken });

    assert.ok(everyone.meta.pagination.total > staff.meta.pagination.total,
      'a client login is an account, but not a team member');
    assert.equal(staff.meta.summary.total, staff.meta.pagination.total,
      'the headline counts the same people as the rows beneath it');
    assert.ok(!staff.data.some(u => u.roles?.some(r => (r.key ?? r) === 'client')),
      'no client account survives the staff filter');
  });

  test('the role filter uses the name the endpoint reads', async () => {
    const { app, adminToken, tenantId } = await setup();
    await createUserWithRole(app, {
      tenantId, email: 'lakshmi@meridian.test', fullName: 'Lakshmi Iyer', roleKey: 'accountant',
    });

    const all = await app.request('/api/users', { token: adminToken });
    const accountants = await app.request('/api/users?role=accountant', { token: adminToken });

    assert.equal(accountants.meta.pagination.total, 1);
    assert.ok(all.meta.pagination.total > 1, 'the filter narrowed rather than matching everything');

    // The name the screen used to send, which nothing read.
    const ignored = await app.request('/api/users?roleKey=accountant', { token: adminToken });
    assert.equal(ignored.meta.pagination.total, all.meta.pagination.total,
      'an unknown query name is ignored — which is why the wrong one was invisible');
  });

  test('documents filter by type, under the name the endpoint reads', async () => {
    const { app, adminToken } = await setup();

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Northline Textiles Pvt Ltd',
        companyName: 'Northline Textiles Private Limited',
        gstin: '29AADCV9012L1ZX',
        pan: 'AADCV9012L',
        contactName: 'Rahul Nair',
        contactEmail: 'rahul@northlinetextiles.test',
        contactPhone: '9822011456',
        openCurrentPeriod: true,
      },
    });
    const clientId = client.data.client.id;

    const types = await app.request('/api/documents/types/list', { token: adminToken });
    assert.ok(types.data.length >= 2, 'there is more than one type to tell apart');
    const [first, second] = types.data;

    for (const [type, name] of [[first, 'first.pdf'], [second, 'second.pdf']]) {
      const form = new FormData();
      form.append('files', testFile(name));
      form.append('clientId', clientId);
      form.append('documentTypeId', type.id);
      const upload = await app.request('/api/documents/upload', {
        method: 'POST', token: adminToken, body: form,
      });
      assert.equal(upload.status, 201, JSON.stringify(upload.body));
    }

    const all = await app.request('/api/documents', { token: adminToken });
    const filtered = await app.request(`/api/documents?typeId=${first.id}`, { token: adminToken });

    assert.equal(all.meta.pagination.total, 2);
    assert.equal(filtered.meta.pagination.total, 1, 'typeId narrows to one type');
    assert.equal(filtered.data[0].typeId ?? filtered.data[0].documentTypeId, first.id);
  });

  test('the verification queue can be narrowed to what is past its SLA', async () => {
    const { app, adminToken } = await setup();

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Vantara Foods LLP',
        companyName: 'Vantara Foods LLP',
        gstin: '27AAECK3456N1Z3',
        pan: 'AAECK3456N',
        contactName: 'Meera Joshi',
        contactEmail: 'meera@vantarafoods.test',
        contactPhone: '9820044113',
        openCurrentPeriod: true,
      },
    });

    const form = new FormData();
    form.append('files', testFile('late.pdf'));
    form.append('clientId', client.data.client.id);
    const upload = await app.request('/api/documents/upload', {
      method: 'POST', token: adminToken, body: form,
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));

    const { Db } = await import('../src/db/client.js');
    const { addDays } = await import('../src/utils/time.js');
    const db = new Db(app.env.DB);

    const before = await app.request('/api/verification/queue?sla=breached', { token: adminToken });
    assert.equal(before.meta.pagination.total, 0, 'nothing is late yet');

    // Push the deadline into the past, the way the clock eventually does.
    await db.run('UPDATE documents SET sla_due_at = ?', [addDays(-2)]);

    const breached = await app.request('/api/verification/queue?sla=breached', { token: adminToken });
    const today = await app.request('/api/verification/queue?sla=today', { token: adminToken });
    const unfiltered = await app.request('/api/verification/queue', { token: adminToken });

    assert.equal(breached.meta.pagination.total, 1, 'the late document is found');
    assert.equal(today.meta.pagination.total, 0, 'and it is not also counted as due today');
    assert.equal(unfiltered.meta.pagination.total, 1);
  });

  test('payments filter by method, and the methods offered are ones the column allows', async () => {
    const { app, adminToken } = await setup();
    const { Db } = await import('../src/db/client.js');
    const db = new Db(app.env.DB);

    // The screen's own list of options; every one must be storable.
    const OFFERED = ['upi', 'credit_card', 'debit_card', 'net_banking', 'wallet',
      'emi', 'bank_transfer', 'cash', 'cheque'];

    const client = await app.request('/api/clients', {
      method: 'POST', token: adminToken,
      body: {
        displayName: 'Kestrel Logistics Pvt Ltd',
        companyName: 'Kestrel Logistics Private Limited',
        gstin: '24AAJCB1357S1Z7',
        pan: 'AAJCB1357S',
        contactName: 'Imran Qureshi',
        contactEmail: 'imran@kestrellogistics.test',
        contactPhone: '9898011224',
      },
    });
    assert.equal(client.status, 201, JSON.stringify(client.body));

    const invoice = await app.request('/api/billing/invoices', {
      method: 'POST', token: adminToken,
      body: {
        clientId: client.data.client.id,
        items: [{ description: 'Monthly retainer', quantity: 1, unitPricePaise: 1000000 }],
        dueInDays: 15,
      },
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));

    const { ID } = await import('../src/utils/id.js');
    const { nowIso } = await import('../src/utils/time.js');
    const tenantId = await firstTenantId(app);

    for (const method of OFFERED) {
      // The CHECK constraint refuses anything the column does not allow, so a
      // method the screen offers but the schema rejects fails right here.
      await db.insert('payments', {
        id: ID.payment(), tenant_id: tenantId, invoice_id: invoice.data.invoice.id,
        reference_no: `PAY-${method.toUpperCase()}`,
        amount_paise: 1000, currency: 'INR', status: 'success',
        gateway: 'offline', method, created_at: nowIso(), updated_at: nowIso(),
      });
    }

    const all = await app.request('/api/billing/payments', { token: adminToken });
    assert.equal(all.meta.pagination.total, OFFERED.length);

    for (const method of OFFERED) {
      const one = await app.request(`/api/billing/payments?method=${method}`, { token: adminToken });
      assert.equal(one.meta.pagination.total, 1, `${method} matches exactly its own payment`);
    }
  });
});
