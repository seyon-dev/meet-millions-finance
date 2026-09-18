/**
 * The last-resort view for an error that escaped a screen.
 *
 * Kept in its own module so the router can import it lazily: it must not be
 * part of the code path that might itself be what failed to load.
 */

import { el } from '../core/dom.js';
import { errorState, lockedState, pageHead } from '../core/ui.js';
import * as fmt from '../core/format.js';

export function renderRouteError(err) {
  // A plan gate is not a fault. It gets the locked state, which explains what
  // would unlock it, rather than an apology for a failure that did not happen.
  if (err?.name === 'FeatureLocked') {
    return el('div.mm-page',
      lockedState({
        featureName: fmt.label(err.featureKey ?? 'This feature'),
        requiredPlan: err.requiredPlan,
        requiredAddOn: err.requiredAddOn,
        message: err.message,
      }));
  }

  if (err?.status === 403) {
    return el('div.mm-page',
      pageHead({ title: 'Not available to your role' }),
      errorState({
        message: err.message ?? 'Your role does not include this screen. If you need it, ask an administrator.',
      }));
  }

  if (err?.status === 404) {
    return el('div.mm-page',
      pageHead({ title: 'Not found' }),
      errorState({ message: err.message ?? 'That record does not exist, or has been removed.' }));
  }

  return el('div.mm-page',
    errorState(err, { onRetry: () => window.location.reload() }));
}

export function renderNotFound() {
  return el('div.mm-page',
    pageHead({ title: 'Page not found' }),
    errorState(
      { message: 'That address does not match a screen in this application.' },
      { onRetry: null }));
}
