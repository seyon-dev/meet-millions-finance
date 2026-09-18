# Integrations

Thirteen vendor categories, nineteen adapters. Every one is written against a
common interface, and every one behaves the same way when its credentials are
absent: it reports **Not Connected**, names the environment variables that are
missing, and does not pretend.

## The interface

Each provider extends `Provider` and answers:

| Method | What it does |
| --- | --- |
| `missingKeys()` | the environment variables this deployment has not set |
| `isConfigured()` | whether it can be called at all |
| `describe()` | its name, category, docs link and the keys it needs |
| `test()` | a live call against the vendor that proves the credentials work |

Every call returns the same envelope:

```js
{ ok: false, status: 'not_configured', providerId: 'ses', data: null,
  error: { message: 'Amazon SES has no credentials on this deployment.' } }
```

`not_configured` is a status in its own right, distinct from `failed`. The
difference matters: one is "nobody has set this up", the other is "the vendor
said no", and a screen that conflates them sends somebody debugging the wrong
thing.

## What is wired

| Category | Adapters | Environment variables |
| --- | --- | --- |
| Email | Amazon SES | `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS` |
| SMS | MSG91 (DLT) | `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `MSG91_DLT_TE_ID` |
| WhatsApp | Meta WhatsApp Cloud API | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` |
| Push | Firebase Cloud Messaging, APNs | `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY`, `APNS_*` |
| OCR | Google Cloud Vision | `GOOGLE_VISION_API_KEY` |
| Speech-to-text | Google Cloud Speech | `GOOGLE_SPEECH_API_KEY` |
| LLM | Claude API | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` |
| Cloud storage | Google Drive, Dropbox, OneDrive | OAuth client id/secret per vendor |
| Lead capture | Meta Lead Ads, Google Sheets, Google Forms, website forms | `META_*`, Google OAuth, webhook secret |
| Calendar | Google Calendar, Outlook Calendar | Google / Microsoft OAuth |
| e-Sign | Digio, Leegality | `DIGIO_*` or `LEEGALITY_AUTH_TOKEN`, `ESIGN_WEBHOOK_SECRET` |
| Payments | Razorpay, Cashfree, Stripe, PhonePe | per gateway, see below |
| Telephony | Exotel, Twilio, Plivo, Knowlarity, MyOperator, RingCentral, Aircall | per provider, see below |
| DNS | Cloudflare API, for white-label custom domains | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` |

`.env.example` lists every variable with an empty placeholder and a comment
saying what it is for. It never contains a real value.

## Payments

Four gateways behind one `PaymentProvider` interface. Razorpay is the default.

Card details never reach this origin. Each gateway's own SDK is loaded from that
gateway's own CDN and takes over at the point of payment — Razorpay's modal,
Cashfree's hosted page, Stripe's Payment Element, PhonePe's redirect. This
application sees an order id and, later, a verified webhook.

Two rules the payment code holds to:

- **A signature is verified before a payment is marked paid.** Every gateway
  signs its webhook; the signature is checked against the raw bytes, in constant
  time, before anything is written.
- **Accepted is not paid.** A gateway that has taken a payment but not confirmed
  it resolves as `pending`, and the invoice stays unpaid until the webhook
  confirms. Showing "Paid" on an optimistic response is how an unpaid invoice
  gets marked settled.

## Telephony

Seven providers behind one `TelephonyProvider` interface: click-to-call, call
masking, IVR, recording, voicemail, live status and webhook events. Provider
choice is `TELEPHONY_PROVIDER`; nothing else in the application names a vendor.

Recordings are stored in R2 under the tenant's own prefix, with a retention
window applied by the daily job.

## OAuth

Google, Microsoft and Dropbox use the authorisation-code flow. The `state`
parameter is stored hashed, single-use and time-limited, so a returned state
cannot be replayed. Tokens are encrypted with AES-GCM before they are written to
D1, using `ENCRYPTION_KEY`.

## Webhooks

Inbound webhooks are mounted at `/webhooks/*` and are **not** behind the session:
they are authenticated by their signature.

| Vendor | Verification |
| --- | --- |
| Razorpay | HMAC-SHA256 over the raw body, `X-Razorpay-Signature` |
| Cashfree | HMAC-SHA256 over timestamp + body |
| Stripe | `Stripe-Signature`, timestamp checked against replay window |
| PhonePe | SHA256 checksum with the salt key and index |
| WhatsApp | `X-Hub-Signature-256`, with the app secret |
| Meta Lead Ads | `X-Hub-Signature-256`, plus the verify-token handshake |
| Digio / Leegality | shared secret over the raw body |
| Telephony | provider secret, per provider |

Every webhook is idempotent on the vendor's own event id, so a redelivery does
not double-post a payment or duplicate a lead.

## Testing a connection

`Settings → Integrations` lists every provider with its real state:
**Connected**, **Not Connected** (with the exact missing keys named) or
**Failed** (with what the vendor said). The "Test connection" button makes a
real call. It is not a self-report — a provider that cannot be reached says so.
