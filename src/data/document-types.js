/**
 * The document catalogue. The proposal states "18+ document types supported";
 * these are the categories it names across the Product Overview, Client
 * Features and Document Checklist screens, plus the statutory documents a
 * filing cycle needs.
 */

export const DOCUMENT_TYPES = [
  // --- GST -----------------------------------------------------------------
  { key: 'gst_documents',    name: 'GST Documents',        category: 'gst',       periodicity: 'monthly',   required: true,  ocr: 'gst_invoice',     sort: 10,
    description: 'Registration certificates, notices and general GST correspondence.' },
  { key: 'gstr1',            name: 'GSTR-1',               category: 'returns',   periodicity: 'monthly',   required: true,  ocr: 'none',            sort: 20,
    description: 'Outward supplies return for the period.' },
  { key: 'gstr3b',           name: 'GSTR-3B',              category: 'returns',   periodicity: 'monthly',   required: true,  ocr: 'none',            sort: 30,
    description: 'Summary return and tax payment for the period.' },
  { key: 'gstr2a_2b',        name: 'GSTR-2A / 2B',         category: 'returns',   periodicity: 'monthly',   required: false, ocr: 'none',            sort: 40,
    description: 'Auto-drafted inward supply statement used for ITC reconciliation.' },
  { key: 'gst_returns',      name: 'GST Returns (Other)',  category: 'returns',   periodicity: 'quarterly', required: false, ocr: 'none',            sort: 50,
    description: 'Annual and other periodic GST returns.' },

  // --- Sales & purchase ----------------------------------------------------
  { key: 'sales_bills',      name: 'Sales Bills',          category: 'sales',     periodicity: 'monthly',   required: true,  ocr: 'gst_invoice',     sort: 60,
    description: 'Outward sales invoices raised during the period.' },
  { key: 'sales_register',   name: 'Sales Register',       category: 'sales',     periodicity: 'monthly',   required: false, ocr: 'none',            sort: 70,
    description: 'Consolidated sales register export.' },
  { key: 'purchase_bills',   name: 'Purchase Bills',       category: 'purchase',  periodicity: 'monthly',   required: true,  ocr: 'gst_invoice',     sort: 80,
    description: 'Inward purchase invoices received during the period.' },
  { key: 'purchase_register',name: 'Purchase Register',    category: 'purchase',  periodicity: 'monthly',   required: false, ocr: 'none',            sort: 90,
    description: 'Consolidated purchase register export.' },
  { key: 'invoices',         name: 'Invoices',             category: 'sales',     periodicity: 'monthly',   required: false, ocr: 'gst_invoice',     sort: 100,
    description: 'Any other invoices relevant to the filing.' },
  { key: 'credit_debit_notes', name: 'Credit / Debit Notes', category: 'sales',   periodicity: 'monthly',   required: false, ocr: 'gst_invoice',     sort: 110,
    description: 'Credit and debit notes issued or received.' },

  // --- Banking & expenses --------------------------------------------------
  { key: 'bank_statements',  name: 'Bank Statements',      category: 'banking',   periodicity: 'monthly',   required: true,  ocr: 'bank_statement',  sort: 120,
    description: 'Statements for every operating bank account.' },
  { key: 'expense_bills',    name: 'Expense Bills',        category: 'expense',   periodicity: 'monthly',   required: true,  ocr: 'gst_invoice',     sort: 130,
    description: 'Operating expense receipts and vendor bills.' },
  { key: 'payment_proofs',   name: 'Payment Proofs',       category: 'payment',   periodicity: 'monthly',   required: false, ocr: 'none',            sort: 140,
    description: 'Transfer confirmations and payment receipts.' },

  // --- TDS & payroll -------------------------------------------------------
  { key: 'tds_documents',    name: 'TDS Documents',        category: 'tds',       periodicity: 'quarterly', required: true,  ocr: 'none',            sort: 150,
    description: 'TDS deduction workings and supporting papers.' },
  { key: 'tds_challans',     name: 'TDS Challans',         category: 'tds',       periodicity: 'monthly',   required: false, ocr: 'none',            sort: 160,
    description: 'Challans evidencing TDS deposited with the treasury.' },
  { key: 'tds_returns',      name: 'TDS Returns',          category: 'tds',       periodicity: 'quarterly', required: false, ocr: 'none',            sort: 170,
    description: 'Quarterly TDS statements (24Q / 26Q).' },
  { key: 'payroll_files',    name: 'Payroll Files',        category: 'payroll',   periodicity: 'monthly',   required: false, ocr: 'none',            sort: 180,
    description: 'Salary register, PF and ESI workings.' },
  { key: 'form16',           name: 'Form 16 / 16A',        category: 'tds',       periodicity: 'yearly',    required: false, ocr: 'none',            sort: 190,
    description: 'TDS certificates issued to deductees.' },

  // --- Tax & statutory -----------------------------------------------------
  { key: 'tax_documents',    name: 'Tax Documents',        category: 'tax',       periodicity: 'yearly',    required: false, ocr: 'none',            sort: 200,
    description: 'Income-tax computations, notices and assessments.' },
  { key: 'advance_tax',      name: 'Advance Tax Challans', category: 'tax',       periodicity: 'quarterly', required: false, ocr: 'none',            sort: 210,
    description: 'Advance tax instalment payment challans.' },
  { key: 'pan_card',         name: 'PAN Card',             category: 'statutory', periodicity: 'one_time',  required: true,  ocr: 'pan',             sort: 220,
    description: 'Permanent Account Number card for the entity.' },
  { key: 'aadhaar',          name: 'Aadhaar',              category: 'statutory', periodicity: 'one_time',  required: false, ocr: 'aadhaar',         sort: 230,
    description: 'Aadhaar of the proprietor or authorised signatory.' },
  { key: 'gst_certificate',  name: 'GST Registration Certificate', category: 'statutory', periodicity: 'one_time', required: true, ocr: 'none',      sort: 240,
    description: 'Certificate of GST registration (Form REG-06).' },
  { key: 'incorporation',    name: 'Incorporation Documents', category: 'statutory', periodicity: 'one_time', required: false, ocr: 'none',          sort: 250,
    description: 'Certificate of incorporation, partnership deed or LLP agreement.' },
  { key: 'other',            name: 'Other Supporting Document', category: 'other', periodicity: 'ad_hoc',   required: false, ocr: 'none',            sort: 900,
    description: 'Anything else the filing needs.' },
];

/** Types that make up the default monthly checklist for a new filing period. */
export const DEFAULT_MONTHLY_CHECKLIST = [
  'sales_bills', 'purchase_bills', 'bank_statements', 'expense_bills',
  'payment_proofs', 'gstr1', 'gstr3b', 'tds_documents', 'payroll_files',
];

export const UPLOAD_LIMITS = {
  /** The prototype states PDF / JPG / PNG / ZIP up to 50MB. Configurable. */
  maxBytes: 50 * 1024 * 1024,
  allowedMime: [
    'application/pdf',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/zip', 'application/x-zip-compressed', 'multipart/x-zip',
    'text/csv', 'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
  allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'zip', 'csv', 'txt', 'xls', 'xlsx', 'doc', 'docx'],
  /** Extensions that are never accepted, whatever MIME type is claimed. */
  blockedExtensions: ['exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'dll', 'js', 'vbs', 'ps1', 'sh', 'jar', 'app', 'apk', 'html', 'htm', 'svg', 'php'],
  maxFilesPerUpload: 25,
  maxZipEntries: 200,
};

export const DOCUMENT_STATUSES = [
  { key: 'draft',          label: 'Draft',           tone: 'neutral' },
  { key: 'submitted',      label: 'Submitted',       tone: 'info' },
  { key: 'under_review',   label: 'Under Review',    tone: 'info' },
  { key: 'query_raised',   label: 'Query Raised',    tone: 'warning' },
  { key: 'awaiting_client',label: 'Awaiting Client', tone: 'warning' },
  { key: 'verified',       label: 'Verified',        tone: 'success' },
  { key: 'approved',       label: 'Approved',        tone: 'success' },
  { key: 'rejected',       label: 'Rejected',        tone: 'danger' },
  { key: 'archived',       label: 'Archived',        tone: 'neutral' },
];

export const FILING_STATUSES = [
  { key: 'collecting',      label: 'Collecting',       tone: 'neutral', step: 1 },
  { key: 'under_review',    label: 'Under Review',     tone: 'info',    step: 2 },
  { key: 'query_raised',    label: 'Query Raised',     tone: 'warning', step: 2 },
  { key: 'awaiting_client', label: 'Awaiting Client',  tone: 'warning', step: 2 },
  { key: 'verified',        label: 'Verified',         tone: 'success', step: 3 },
  { key: 'calculated',      label: 'Calculated',       tone: 'info',    step: 4 },
  { key: 'pending_approval',label: 'Pending Approval', tone: 'warning', step: 5 },
  { key: 'approved',        label: 'Approved',         tone: 'success', step: 5 },
  { key: 'client_review',   label: 'Client Review',    tone: 'info',    step: 6 },
  { key: 'signed_off',      label: 'Signed Off',       tone: 'success', step: 6 },
  { key: 'paid',            label: 'Paid',             tone: 'success', step: 7 },
  { key: 'filed',           label: 'Filed',            tone: 'success', step: 8 },
  { key: 'archived',        label: 'Archived',         tone: 'neutral', step: 9 },
  { key: 'rejected',        label: 'Rejected',         tone: 'danger',  step: 0 },
];

/** The ten workflow stages from the proposal's Complete CRM Workflow page. */
export const WORKFLOW_STAGES = [
  { no: 1,  key: 'registration',   label: 'Client Registration & Login', detail: 'Company profile, GSTIN, PAN, TAN captured with 2FA-secured login' },
  { no: 2,  key: 'upload',         label: 'Document Upload',             detail: 'GST documents, sales & purchase bills, invoices, bank statements uploaded via drag-and-drop or ZIP' },
  { no: 3,  key: 'verification',   label: 'Finance Executive Verification', detail: 'Documents reviewed line by line against source records' },
  { no: 4,  key: 'query',          label: 'Query Raised (if needed)',    detail: 'Executive flags discrepancies; client responds and re-uploads corrected files' },
  { no: 5,  key: 'verified',       label: 'Verification Complete',       detail: 'All documents locked and marked verified, ready for calculation' },
  { no: 6,  key: 'calculation',    label: 'GST & Tax Calculation',       detail: 'Automated summary generation across GST and TDS categories' },
  { no: 7,  key: 'approval',       label: 'Manager Approval',            detail: 'Finance Manager reviews and approves the generated report' },
  { no: 8,  key: 'client_review',  label: 'Report Generated & Client Review', detail: 'Client reviews the final report before filing sign-off' },
  { no: 9,  key: 'payment',        label: 'Payment Collection & Invoice', detail: 'Payment collected via gateway; invoice auto-generated and shared' },
  { no: 10, key: 'archive',        label: 'Archive',                     detail: 'Full filing package securely archived with complete audit trail' },
];
