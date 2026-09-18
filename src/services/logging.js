/** Platform operational log — distinct from the tenant audit trail. */

import { ID } from '../utils/id.js';
import { nowIso } from '../utils/time.js';
import { Db } from '../db/client.js';

export async function logSystemEvent(env, {
  level = 'info', source = 'worker', event, message,
  tenantId = null, requestId = null, path = null, statusCode = null,
  durationMs = null, context = null, stack = null,
}) {
  if (!env?.DB) return null;
  try {
    const db = new Db(env.DB);
    const row = {
      id: ID.sysLog(),
      level, source, event,
      message: String(message ?? '').slice(0, 2000),
      tenant_id: tenantId,
      request_id: requestId,
      path: path ? String(path).slice(0, 300) : null,
      status_code: statusCode,
      duration_ms: durationMs,
      context_json: context ? JSON.stringify(context) : null,
      stack: stack ? String(stack).slice(0, 4000) : null,
      created_at: nowIso(),
    };
    await db.insert('system_logs', row);
    return row;
  } catch (err) {
    // Logging must never take the request down with it.
    console.error('system log write failed', err?.message);
    return null;
  }
}

export async function purgeSystemLogs(db, olderThanIso) {
  const meta = await db.run('DELETE FROM system_logs WHERE created_at < ?', [olderThanIso]);
  return meta?.changes ?? 0;
}
