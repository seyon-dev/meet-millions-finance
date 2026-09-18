/**
 * Gateway checkout.
 *
 * Each gateway's own SDK is loaded from that gateway's own CDN and opened with
 * the session the Worker created. Card details are entered inside the
 * gateway's iframe and never touch this application, this origin, or its
 * logs — which is the entire reason for doing it this way rather than posting
 * a card number to our own API.
 *
 * The Worker returns a `checkout` object whose shape depends on the provider;
 * each branch below understands exactly one of them. A provider with no branch
 * is reported honestly rather than silently doing nothing.
 */

import { api } from './api.js';

const SDK = {
  razorpay: 'https://checkout.razorpay.com/v1/checkout.js',
  stripe: 'https://js.stripe.com/v3/',
  cashfree: 'https://sdk.cashfree.com/js/v3/cashfree.js',
};

const loaded = new Map();

/** Load a script once, and reuse the same promise on every later call. */
function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(
      'The payment provider’s script could not be loaded. Check the connection and try again.'));
    document.head.append(script);
  });

  loaded.set(src, promise);
  return promise;
}

/**
 * Run a checkout to completion.
 *
 * Resolves to { status: 'paid' | 'pending' | 'cancelled', message }.
 * 'pending' means the gateway took the payment but our own confirmation has
 * not landed yet — the webhook settles it, and saying "paid" before that would
 * be claiming something we have not verified.
 */
export async function runCheckout({ payment, checkout, invoice, returnUrl }) {
  if (!checkout?.provider) {
    throw new Error('The gateway did not return a checkout session. Nothing has been charged.');
  }

  switch (checkout.provider) {
    case 'razorpay': return razorpay({ payment, checkout, invoice });
    case 'cashfree': return cashfree({ payment, checkout, returnUrl });
    case 'stripe': return stripe({ payment, checkout, returnUrl });
    case 'phonepe': return phonepe({ checkout });
    default:
      throw new Error(`This build does not know how to open a ${checkout.provider} checkout.`);
  }
}

/** Razorpay opens a modal over the page and hands back a signed result. */
async function razorpay({ payment, checkout, invoice }) {
  await loadScript(SDK.razorpay);
  if (!window.Razorpay) throw new Error('Razorpay’s checkout did not load.');

  return new Promise((resolve, reject) => {
    const instance = new window.Razorpay({
      key: checkout.key,
      order_id: checkout.orderId,
      amount: checkout.amount,
      currency: checkout.currency ?? 'INR',
      name: document.title,
      description: invoice?.invoiceNo ? `Invoice ${invoice.invoiceNo}` : undefined,
      handler: async (response) => {
        try {
          // The signature is verified by the Worker against the key secret.
          // Nothing here decides whether the payment succeeded.
          const { data } = await api.post(`/billing/payments/${payment.id}/verify`, {
            gatewayPaymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          });
          resolve(data?.payment?.status === 'success'
            ? { status: 'paid', message: 'Payment received.' }
            : { status: 'pending', message: data?.error ?? 'The gateway took the payment; confirmation is still pending.' });
        } catch (err) {
          reject(err);
        }
      },
      modal: {
        ondismiss: () => resolve({ status: 'cancelled', message: 'Payment cancelled. Nothing was charged.' }),
      },
    });

    instance.on('payment.failed', (event) => {
      resolve({
        status: 'failed',
        message: event?.error?.description ?? 'The payment was declined.',
      });
    });

    instance.open();
  });
}

/** Cashfree redirects to its own hosted page and returns to `returnUrl`. */
async function cashfree({ checkout, returnUrl }) {
  await loadScript(SDK.cashfree);
  if (!window.Cashfree) throw new Error('Cashfree’s checkout did not load.');

  const instance = window.Cashfree({ mode: checkout.mode ?? 'production' });
  await instance.checkout({
    paymentSessionId: checkout.paymentSessionId,
    redirectTarget: '_self',
    returnUrl,
  });
  // The redirect has been handed to the SDK; this page is on its way out.
  return { status: 'pending', message: 'Taking you to Cashfree…' };
}

/**
 * Stripe's Payment Element, mounted in a dialog.
 *
 * Stripe requires its own element rather than a redirect for a PaymentIntent,
 * so this opens one, confirms against it, and lets Stripe redirect back.
 */
async function stripe({ checkout, returnUrl }) {
  await loadScript(SDK.stripe);
  if (!window.Stripe) throw new Error('Stripe’s checkout did not load.');
  if (!checkout.publishableKey) {
    throw new Error('Stripe is connected but its publishable key is not configured, so the payment form cannot be shown.');
  }

  const { modal } = await import('./ui.js');
  const { el } = await import('./dom.js');

  const instance = window.Stripe(checkout.publishableKey);
  const elements = instance.elements({ clientSecret: checkout.clientSecret });

  const result = await modal({
    title: 'Pay by card',
    description: 'Your card details are entered in Stripe’s own form and are never sent to this application.',
    body: ({ close }) => {
      const mount = el('div', { id: 'mm-stripe-element' });
      const errorHost = el('div');
      const submit = el('button.mm-btn.mm-btn--primary', { type: 'submit', text: 'Pay' });

      const form = el('form.mm-form', {
        novalidate: true,
        onSubmit: async (e) => {
          e.preventDefault();
          submit.disabled = true;
          submit.textContent = 'Confirming…';

          const outcome = await instance.confirmPayment({
            elements,
            confirmParams: { return_url: returnUrl },
            redirect: 'if_required',
          });

          if (outcome.error) {
            errorHost.replaceChildren(el('p.mm-field__error', {
              role: 'alert', text: outcome.error.message,
            }));
            submit.disabled = false;
            submit.textContent = 'Pay';
            return;
          }
          close({ intentStatus: outcome.paymentIntent?.status ?? 'processing' });
        },
      },
        errorHost,
        mount,
        el('div.mm-row.mm-end.mm-gap-2.mm-mt-4',
          el('button.mm-btn.mm-btn--ghost', { type: 'button', text: 'Cancel', onClick: () => close(null) }),
          submit));

      // Mounted after the dialog is in the document, or Stripe has nothing to
      // attach to.
      queueMicrotask(() => elements.create('payment').mount(mount));
      return form;
    },
  });

  if (!result) return { status: 'cancelled', message: 'Payment cancelled. Nothing was charged.' };
  return result.intentStatus === 'succeeded'
    ? { status: 'pending', message: 'Stripe accepted the payment. It is marked paid once confirmed.' }
    : { status: 'pending', message: `Stripe reports the payment as ${result.intentStatus}.` };
}

/** PhonePe is a plain redirect to its hosted page. */
function phonepe({ checkout }) {
  if (!checkout.redirectUrl) {
    throw new Error('PhonePe did not return a payment page. Nothing has been charged.');
  }
  window.location.href = checkout.redirectUrl;
  return { status: 'pending', message: 'Taking you to PhonePe…' };
}
