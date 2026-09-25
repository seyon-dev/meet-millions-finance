/**
 * Identifier generation.
 *
 * IDs are ULID-style: 10 chars of base32 timestamp + 16 chars of base32
 * randomness. They sort chronologically as plain strings, which keeps
 * "newest first" listings cheap in D1 without a separate sort column.
 */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford, no I/L/O/U

function encodeTime(ms, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = ms % 32;
    out = B32[mod] + out;
    ms = (ms - mod) / 32;
  }
  return out;
}

function encodeRandom(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += B32[bytes[i] % 32];
  return out;
}

/** A fresh ULID. */
export function ulid(now = Date.now()) {
  return encodeTime(now, 10) + encodeRandom(16);
}

/**
 * A prefixed id, e.g. `doc_01J...`. The prefix makes log lines and audit
 * entries readable at a glance and catches "wrong id passed here" bugs early.
 */
export function newId(prefix) {
  return prefix ? `${prefix}_${ulid()}` : ulid();
}

export const ID = {
  tenant: () => newId('ten'),
  franchise: () => newId('frn'),
  branch: () => newId('brn'),
  company: () => newId('cmp'),
  user: () => newId('usr'),
  role: () => newId('rol'),
  session: () => newId('ses'),
  challenge: () => newId('chl'),
  device: () => newId('dev'),
  client: () => newId('cli'),
  contact: () => newId('cnt'),
  docType: () => newId('dty'),
  period: () => newId('per'),
  document: () => newId('doc'),
  version: () => newId('ver'),
  batch: () => newId('bch'),
  comment: () => newId('cmt'),
  verification: () => newId('vrf'),
  query: () => newId('qry'),
  reply: () => newId('rpy'),
  checklist: () => newId('chk'),
  taxRule: () => newId('trl'),
  computation: () => newId('cmu'),
  gstRecord: () => newId('gst'),
  tdsRecord: () => newId('tds'),
  report: () => newId('rpt'),
  reportItem: () => newId('rpi'),
  approval: () => newId('apr'),
  task: () => newId('tsk'),
  automationJob: () => newId('ajb'),
  subscriptionEvent: () => newId('sev'),
  automationRun: () => newId('arn'),
  broadcastRecipient: () => newId('bcr'),
  activity: () => newId('act'),
  plan: () => newId('pln'),
  subscription: () => newId('sub'),
  addOn: () => newId('add'),
  addOnSub: () => newId('ads'),
  invoice: () => newId('inv'),
  invoiceItem: () => newId('ivi'),
  payment: () => newId('pay'),
  transaction: () => newId('ptx'),
  webhookEvent: () => newId('whe'),
  notification: () => newId('ntf'),
  template: () => newId('tpl'),
  delivery: () => newId('dlv'),
  rule: () => newId('rul'),
  thread: () => newId('thr'),
  message: () => newId('msg'),
  broadcast: () => newId('bcs'),
  flow: () => newId('flw'),
  voiceNote: () => newId('vnt'),
  ticket: () => newId('tkt'),
  ticketMessage: () => newId('tms'),
  integration: () => newId('int'),
  oauth: () => newId('oau'),
  syncLog: () => newId('syn'),
  mapping: () => newId('map'),
  campaign: () => newId('cpn'),
  lead: () => newId('led'),
  endpoint: () => newId('end'),
  ocr: () => newId('ocr'),
  aiVerify: () => newId('aiv'),
  conversation: () => newId('cnv'),
  aiMessage: () => newId('aim'),
  insight: () => newId('ins'),
  esign: () => newId('esg'),
  signer: () => newId('sgn'),
  folderMap: () => newId('fmp'),
  syncItem: () => newId('sit'),
  event: () => newId('evt'),
  apiKey: () => newId('key'),
  apiUsage: () => newId('aus'),
  call: () => newId('cal'),
  recording: () => newId('rec'),
  callNote: () => newId('cnn'),
  transcript: () => newId('trs'),
  callAi: () => newId('cai'),
  disposition: () => newId('dsp'),
  tag: () => newId('tag'),
  ivr: () => newId('ivr'),
  voicemail: () => newId('vml'),
  metric: () => newId('mtr'),
  audit: () => newId('aud'),
  sysLog: () => newId('slg'),
  backup: () => newId('bkp'),
  restore: () => newId('rst'),
  attendance: () => newId('atd'),
  visit: () => newId('vst'),
  setting: () => newId('set'),
  flag: () => newId('flg'),
  view: () => newId('viw'),
  schedule: () => newId('sch'),
  dashboard: () => newId('dsh'),
  pushToken: () => newId('psh'),
  capture: () => newId('cap'),
  reset: () => newId('pwr'),
  agent: () => newId('agt'),
};

/**
 * Human-facing sequential references (INV-2026-000123, QRY-2026-000045).
 * The numeric part comes from a per-tenant count, so it is readable and
 * predictable inside a year without leaking global platform volume.
 */
export function formatReference(prefix, year, sequence, width = 6) {
  return `${prefix}-${year}-${String(sequence).padStart(width, '0')}`;
}
