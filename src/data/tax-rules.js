/**
 * Default GST and TDS rules.
 *
 * These are seeded into `tax_rules` as platform defaults and can be amended
 * per tenant from Settings → Tax without a deploy. Every rule is date-bounded,
 * so a computation always resolves the rate that was in force for its period.
 *
 * `is_verified = 1` marks a rule an accountant has signed off. The AI Tax
 * Assistant may propose a rule, but it is written with is_verified = 0 and is
 * never used by the calculation engine until a human approves it.
 */

const R = (rupees) => rupees * 100;
const FROM = '2017-07-01T00:00:00.000Z';   // GST commencement

/** GST slabs. CGST/SGST split the rate in half for intra-state supply. */
export const GST_SLABS = [
  { code: 'GST_0',    name: 'GST 0% — Exempt / Nil rated', rate: 0 },
  { code: 'GST_0_25', name: 'GST 0.25%',                   rate: 0.25 },
  { code: 'GST_3',    name: 'GST 3%',                      rate: 3 },
  { code: 'GST_5',    name: 'GST 5%',                      rate: 5 },
  { code: 'GST_12',   name: 'GST 12%',                     rate: 12 },
  { code: 'GST_18',   name: 'GST 18%',                     rate: 18 },
  { code: 'GST_28',   name: 'GST 28%',                     rate: 28 },
];

export const GST_RULES = GST_SLABS.map(slab => ({
  regime: 'gst',
  code: slab.code,
  name: slab.name,
  rate_pct: slab.rate,
  cgst_pct: slab.rate / 2,
  sgst_pct: slab.rate / 2,
  igst_pct: slab.rate,
  cess_pct: 0,
  threshold_paise: 0,
  payee_type: null,
  effective_from: FROM,
  effective_to: null,
  is_verified: 1,
  source_note: 'CGST/SGST/IGST rate schedule.',
}));

/** A few common compensation-cess entries, illustrating the cess column. */
export const CESS_RULES = [
  { regime: 'cess', code: 'CESS_AERATED', name: 'Compensation cess — aerated drinks', rate_pct: 12, cess_pct: 12,
    hsn_sac: '2202', effective_from: FROM, is_verified: 1, source_note: 'Compensation cess schedule.' },
  { regime: 'cess', code: 'CESS_TOBACCO', name: 'Compensation cess — tobacco', rate_pct: 61, cess_pct: 61,
    hsn_sac: '2402', effective_from: FROM, is_verified: 1, source_note: 'Compensation cess schedule.' },
  { regime: 'cess', code: 'CESS_MOTOR', name: 'Compensation cess — motor vehicles', rate_pct: 15, cess_pct: 15,
    hsn_sac: '8703', effective_from: FROM, is_verified: 1, source_note: 'Compensation cess schedule.' },
];

/**
 * TDS sections. `threshold_paise` is the annual limit below which no tax is
 * deducted; `payee_type` distinguishes the individual/HUF rate from the
 * company/firm rate where the section provides for both.
 */
export const TDS_RULES = [
  { code: 'TDS_192',      section: '192',   name: 'Salary',                                   rate: 0,    threshold: 0,          payee: 'individual',
    note: 'Deducted at the average rate of income tax computed on estimated salary income.' },
  { code: 'TDS_194A',     section: '194A',  name: 'Interest other than on securities',        rate: 10,   threshold: R(40000),   payee: 'any' },
  { code: 'TDS_194C_IND', section: '194C',  name: 'Payment to contractor — individual / HUF', rate: 1,    threshold: R(30000),   payee: 'individual' },
  { code: 'TDS_194C_CO',  section: '194C',  name: 'Payment to contractor — others',           rate: 2,    threshold: R(30000),   payee: 'company' },
  { code: 'TDS_194H',     section: '194H',  name: 'Commission or brokerage',                  rate: 5,    threshold: R(15000),   payee: 'any' },
  { code: 'TDS_194I_PM',  section: '194I',  name: 'Rent — plant & machinery',                 rate: 2,    threshold: R(240000),  payee: 'any' },
  { code: 'TDS_194I_LB',  section: '194I',  name: 'Rent — land, building & furniture',        rate: 10,   threshold: R(240000),  payee: 'any' },
  { code: 'TDS_194J_PRO', section: '194J',  name: 'Professional fees',                        rate: 10,   threshold: R(30000),   payee: 'any' },
  { code: 'TDS_194J_TEC', section: '194J',  name: 'Technical services',                       rate: 2,    threshold: R(30000),   payee: 'any' },
  { code: 'TDS_194Q',     section: '194Q',  name: 'Purchase of goods',                        rate: 0.1,  threshold: R(5000000), payee: 'any' },
  { code: 'TDS_194O',     section: '194O',  name: 'E-commerce operator',                      rate: 1,    threshold: R(500000),  payee: 'any' },
  { code: 'TDS_194IB',    section: '194-IB',name: 'Rent by individual / HUF',                 rate: 5,    threshold: R(600000),  payee: 'individual' },
  { code: 'TDS_206AA',    section: '206AA', name: 'No PAN furnished — higher rate',           rate: 20,   threshold: 0,          payee: 'any',
    note: 'Applies where the deductee has not furnished a valid PAN.' },
].map(r => ({
  regime: 'tds',
  code: r.code,
  name: r.name,
  section_code: r.section,
  rate_pct: r.rate,
  cgst_pct: 0, sgst_pct: 0, igst_pct: 0, cess_pct: 0,
  threshold_paise: r.threshold,
  payee_type: r.payee,
  effective_from: '2021-04-01T00:00:00.000Z',
  effective_to: null,
  is_verified: 1,
  source_note: r.note ?? 'Chapter XVII-B rate schedule.',
}));

export const ALL_TAX_RULES = [...GST_RULES, ...CESS_RULES.map(normaliseCess), ...TDS_RULES];

function normaliseCess(r) {
  return {
    regime: r.regime, code: r.code, name: r.name,
    hsn_sac: r.hsn_sac ?? null, section_code: null,
    rate_pct: r.rate_pct, cgst_pct: 0, sgst_pct: 0, igst_pct: 0, cess_pct: r.cess_pct,
    threshold_paise: 0, payee_type: null,
    effective_from: r.effective_from, effective_to: null,
    is_verified: r.is_verified, source_note: r.source_note,
  };
}

/**
 * Indian state / UT GST codes. The first two digits of a GSTIN; used to decide
 * intra-state (CGST + SGST) versus inter-state (IGST) supply.
 */
export const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala',
  '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

export function stateName(code) { return STATE_CODES[String(code)] ?? null; }

/** GST return types and their statutory due dates within the following month. */
export const GST_RETURN_TYPES = [
  { key: 'gstr1',  name: 'GSTR-1',  dueDay: 11, frequency: 'monthly',   description: 'Outward supplies' },
  { key: 'gstr3b', name: 'GSTR-3B', dueDay: 20, frequency: 'monthly',   description: 'Summary return and payment' },
  { key: 'cmp08',  name: 'CMP-08',  dueDay: 18, frequency: 'quarterly', description: 'Composition dealers' },
  { key: 'gstr9',  name: 'GSTR-9',  dueDay: 31, frequency: 'yearly',    description: 'Annual return' },
];
