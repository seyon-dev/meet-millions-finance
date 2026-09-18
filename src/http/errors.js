/**
 * Error taxonomy.
 *
 * Every error the API returns is one of these. `expose` decides whether the
 * message reaches the client verbatim; anything else is replaced with a
 * generic string so internal details never leak through an API response.
 */

export class AppError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details = null, expose = false, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = expose;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed.', fields = null) {
    super(message, { status: 422, code: 'validation_failed', details: fields ? { fields } : null, expose: true });
    this.name = 'ValidationError';
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'The request could not be understood.', details = null) {
    super(message, { status: 400, code: 'bad_request', details, expose: true });
    this.name = 'BadRequestError';
  }
}

export class AuthRequiredError extends AppError {
  constructor(message = 'Sign in to continue.', code = 'auth_required') {
    super(message, { status: 401, code, expose: true });
    this.name = 'AuthRequiredError';
  }
}

export class TwoFactorRequiredError extends AppError {
  constructor(message = 'Two-factor verification is required.', details = null) {
    super(message, { status: 401, code: 'twofa_required', details, expose: true });
    this.name = 'TwoFactorRequiredError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.', details = null) {
    super(message, { status: 403, code: 'forbidden', details, expose: true });
    this.name = 'ForbiddenError';
  }
}

/**
 * Raised when a plan or add-on does not include the requested capability.
 * Carries what is missing so the UI can offer the right upgrade path
 * instead of a dead end.
 */
export class FeatureLockedError extends AppError {
  constructor(featureKey, { requiredPlan = null, requiredAddOn = null, message } = {}) {
    super(message || 'This feature is not included in your current plan.', {
      status: 402,
      code: 'feature_locked',
      details: { featureKey, requiredPlan, requiredAddOn },
      expose: true,
    });
    this.name = 'FeatureLockedError';
  }
}

export class LimitExceededError extends AppError {
  constructor(metric, limit, current, message) {
    super(message || `You have reached your plan limit for ${metric}.`, {
      status: 402,
      code: 'limit_exceeded',
      details: { metric, limit, current },
      expose: true,
    });
    this.name = 'LimitExceededError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource', message) {
    super(message || `${resource} not found.`, { status: 404, code: 'not_found', expose: true });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message = 'That conflicts with an existing record.', details = null) {
    super(message, { status: 409, code: 'conflict', details, expose: true });
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds = 60, message = 'Too many requests. Please slow down.') {
    super(message, { status: 429, code: 'rate_limited', details: { retryAfterSeconds }, expose: true });
    this.name = 'RateLimitError';
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes, message) {
    super(message || 'That file is larger than the allowed limit.', {
      status: 413, code: 'payload_too_large', details: { maxBytes }, expose: true,
    });
    this.name = 'PayloadTooLargeError';
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(allowed, message) {
    super(message || 'That file type is not accepted.', {
      status: 415, code: 'unsupported_media_type', details: { allowed }, expose: true,
    });
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * A third-party integration failed or has no credentials configured. The
 * status is 503 because the CRM itself is healthy; only the vendor leg is not.
 */
export class IntegrationError extends AppError {
  constructor(provider, message, { configured = true, details = null } = {}) {
    super(message || `${provider} is not available right now.`, {
      status: 503,
      code: configured ? 'integration_error' : 'integration_not_configured',
      details: { provider, configured, ...(details || {}) },
      expose: true,
    });
    this.name = 'IntegrationError';
  }
}

export class NotConfiguredError extends IntegrationError {
  constructor(provider, missingKeys = []) {
    super(provider, `${provider} is not connected. Add its credentials in Settings → Integrations.`, {
      configured: false,
      details: { missingKeys },
    });
    this.name = 'NotConfiguredError';
  }
}
