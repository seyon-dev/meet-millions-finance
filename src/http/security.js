/**
 * Content Security Policy.
 *
 * Kept apart from response.js because the document and the API want different
 * policies, and conflating them produced a policy loose enough to be worth
 * little: the SPA shell must load four payment SDKs from four vendor CDNs,
 * while a JSON response should be able to load nothing at all.
 *
 * Every origin below is here because something in this codebase fetches it.
 * The lists are derived from `public/assets/js/core/checkout.js` (the gateway
 * SDKs) and `public/index.html` (Google Fonts). Nothing else is allowed.
 */

/**
 * SHA-256 of the inline theme script in public/index.html.
 *
 * That script reads the stored theme before first paint — moving it to an
 * external file would reintroduce the flash of the wrong palette it exists to
 * prevent, and 'unsafe-inline' would defeat the point of having a policy. A
 * hash keeps it inline and the policy strict.
 *
 * scripts/build.mjs recomputes this from the file and fails when the two
 * drift, so editing the script without updating the hash cannot ship a page
 * whose own theme script is blocked.
 */
export const INLINE_THEME_SCRIPT_HASH = 'sha256-vDPHVS3ZJTRS5rQp8TS+BcQzfbM8IiLMHbnQ363kK+4=';

/** Where each gateway's SDK is served from. */
const GATEWAY_SCRIPTS = [
  'https://checkout.razorpay.com',
  'https://js.stripe.com',
  'https://sdk.cashfree.com',
];

/** Where each gateway's SDK talks to, and what it frames. */
const GATEWAY_CONNECT = [
  'https://api.razorpay.com',
  'https://lumberjack.razorpay.com',
  'https://api.stripe.com',
  'https://sdk.cashfree.com',
  'https://api.cashfree.com',
];

const GATEWAY_FRAMES = [
  'https://api.razorpay.com',
  'https://checkout.razorpay.com',
  'https://js.stripe.com',
  'https://hooks.stripe.com',
  'https://sdk.cashfree.com',
  'https://payments.cashfree.com',
];

/**
 * PhonePe is a full-page redirect rather than an embedded SDK, so it needs a
 * form-action entry instead of script/frame permission.
 */
const GATEWAY_FORMS = [
  'https://api.phonepe.com',
  'https://mercury-t2.phonepe.com',
];

/**
 * The policy for the application shell.
 *
 * Notes on the deliberate loosenings, each of which is as narrow as it can be:
 *
 *   style-src 'unsafe-inline' — the UI sets style attributes directly
 *     (progress widths, chart bar heights). CSP has no hashing for style
 *     attributes, so the alternative is no inline styling at all.
 *
 *   img-src data: blob: — avatars, generated QR codes and document previews
 *     are built in the browser and handed to <img> as blobs.
 *
 *   media-src blob: — call recordings and voice notes are fetched through the
 *     authorised API and played from a blob, because a media element cannot
 *     send an Authorization header.
 */
export function documentCsp({ appUrl = null } = {}) {
  const self = "'self'";

  const directives = {
    'default-src': [self],
    'base-uri': [self],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'script-src': [self, `'${INLINE_THEME_SCRIPT_HASH}'`, ...GATEWAY_SCRIPTS],
    'style-src': [self, "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': [self, 'https://fonts.gstatic.com', 'data:'],
    'img-src': [self, 'data:', 'blob:'],
    'media-src': [self, 'blob:'],
    'connect-src': [self, ...GATEWAY_CONNECT],
    'frame-src': [self, ...GATEWAY_FRAMES],
    'form-action': [self, ...GATEWAY_FORMS],
    'worker-src': [self, 'blob:'],
    'manifest-src': [self],
    'upgrade-insecure-requests': [],
  };

  // A white-label deployment serves the same app from the firm's own domain;
  // it has to be allowed to talk to itself.
  if (appUrl && /^https:\/\//.test(appUrl)) {
    try {
      const origin = new URL(appUrl).origin;
      if (!directives['connect-src'].includes(origin)) directives['connect-src'].push(origin);
    } catch { /* a malformed APP_URL simply adds nothing */ }
  }

  return Object.entries(directives)
    .map(([key, values]) => (values.length ? `${key} ${values.join(' ')}` : key))
    .join('; ');
}

/**
 * The policy for an API or file response.
 *
 * A JSON body has no business loading anything, and a document served from
 * /files is attacker-influenced content — it gets the most restrictive policy
 * the format allows, plus sandboxing so an HTML file that somehow got stored
 * cannot execute.
 */
export function apiCsp() {
  return "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
}

/** Headers every response carries, whatever its kind. */
export const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=(self), payment=(self)',
};

/**
 * Strict-Transport-Security.
 *
 * Only ever sent over HTTPS: setting it on a plain-HTTP local development
 * response would pin localhost to HTTPS in the developer's browser, which is
 * both wrong and annoying to undo.
 */
export function hstsFor(url) {
  return url?.protocol === 'https:'
    ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
    : {};
}
