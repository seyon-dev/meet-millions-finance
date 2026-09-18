/**
 * AI providers: Google Cloud Vision (OCR), Google Cloud Speech-to-Text
 * (voice notes and call transcription) and the Claude API (tax assistant,
 * business insights, call summaries and sentiment) — the vendors the
 * Integration Stack addendum selects.
 *
 * A hard rule runs through this file: model output is *suggestion*, never
 * verified fact. Extracted fields carry a confidence score and land in a
 * review queue; the tax assistant is given the verified figures to reason
 * over and is told, in its system prompt, never to state a rate it was not
 * given. Nothing the model produces reaches a filing without a human.
 */

import { Provider, RESULT_STATUS } from './base.js';

// ===========================================================================
// OCR — Google Cloud Vision
// ===========================================================================

/** Field maps per document profile, used to structure raw OCR text. */
const OCR_PROFILES = {
  gst_invoice: {
    label: 'GST Invoice',
    fields: [
      { key: 'invoice_no', label: 'Invoice number', patterns: [/invoice\s*(?:no|number|#)\s*[:.\-]?\s*([A-Za-z0-9\/\-]+)/i] },
      { key: 'invoice_date', label: 'Invoice date', patterns: [/(?:invoice\s*)?date\s*[:.\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})/i] },
      { key: 'supplier_gstin', label: 'Supplier GSTIN', patterns: [/gstin\s*[:.\-]?\s*([0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])/i] },
      { key: 'taxable_value', label: 'Taxable value', patterns: [/taxable\s*(?:value|amount)\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'cgst', label: 'CGST', patterns: [/cgst\s*(?:@?\s*[\d.]+\s*%)?\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'sgst', label: 'SGST', patterns: [/sgst\s*(?:@?\s*[\d.]+\s*%)?\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'igst', label: 'IGST', patterns: [/igst\s*(?:@?\s*[\d.]+\s*%)?\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'total', label: 'Invoice total', patterns: [/(?:grand\s*)?total\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'place_of_supply', label: 'Place of supply', patterns: [/place\s*of\s*supply\s*[:.\-]?\s*([A-Za-z\s]+?)(?:\n|$)/i] },
    ],
  },
  bank_statement: {
    label: 'Bank Statement',
    fields: [
      { key: 'account_number', label: 'Account number', patterns: [/a\/?c\s*(?:no|number)?\s*[:.\-]?\s*([X\d]{6,20})/i] },
      { key: 'ifsc', label: 'IFSC', patterns: [/ifsc\s*(?:code)?\s*[:.\-]?\s*([A-Z]{4}0[A-Z0-9]{6})/i] },
      { key: 'bank_name', label: 'Bank', patterns: [/^([A-Z][A-Za-z&.\s]{3,40}(?:bank|BANK))/m] },
      { key: 'opening_balance', label: 'Opening balance', patterns: [/opening\s*balance\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'closing_balance', label: 'Closing balance', patterns: [/closing\s*balance\s*[:.\-]?\s*(?:₹|rs\.?)?\s*([\d,]+\.?\d*)/i] },
      { key: 'period', label: 'Statement period', patterns: [/(?:statement\s*)?period\s*[:.\-]?\s*(.{5,40}?)(?:\n|$)/i] },
    ],
  },
  pan: {
    label: 'PAN Card',
    fields: [
      { key: 'pan', label: 'PAN', patterns: [/\b([A-Z]{5}[0-9]{4}[A-Z])\b/] },
      { key: 'name', label: 'Name', patterns: [/name\s*[:.\-]?\s*([A-Z][A-Z\s]{3,50})/i] },
      { key: 'father_name', label: "Father's name", patterns: [/father'?s?\s*name\s*[:.\-]?\s*([A-Z][A-Z\s]{3,50})/i] },
      { key: 'dob', label: 'Date of birth', patterns: [/(?:date of birth|dob)\s*[:.\-]?\s*(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i] },
    ],
  },
  aadhaar: {
    label: 'Aadhaar',
    fields: [
      // Only the last four digits are retained; the full number is never stored.
      { key: 'aadhaar_last4', label: 'Aadhaar (last 4)', patterns: [/\b\d{4}\s?\d{4}\s?(\d{4})\b/] },
      { key: 'name', label: 'Name', patterns: [/^([A-Z][A-Za-z\s]{3,50})$/m] },
      { key: 'dob', label: 'Date of birth', patterns: [/(?:dob|year of birth)\s*[:.\-]?\s*([\d\/\-.]{4,10})/i] },
      { key: 'gender', label: 'Gender', patterns: [/\b(MALE|FEMALE|TRANSGENDER)\b/i] },
    ],
  },
};

export class VisionOcrProvider extends Provider {
  constructor(env) {
    super({
      key: 'google_vision',
      name: 'Google Cloud Vision',
      category: 'ocr',
      requiredKeys: ['GOOGLE_VISION_API_KEY'],
      env,
      docsUrl: 'https://cloud.google.com/vision/docs',
    });
  }

  /**
   * Run OCR and structure the result against a profile.
   * @param {ArrayBuffer|Uint8Array} bytes
   * @param {string} profile gst_invoice | bank_statement | pan | aadhaar
   */
  async extract(bytes, profile = 'gst_invoice') {
    if (!this.isConfigured()) return this.notConfigured('read that document');

    const base64 = arrayBufferToBase64(bytes);
    const res = await this.request(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(this.env.GOOGLE_VISION_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{
            image: { content: base64 },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
            imageContext: { languageHints: ['en', 'hi'] },
          }],
        }),
        timeoutMs: 30000,
      });

    if (!res.ok) return this.failure(res.error, { code: 'vision_error', raw: res.body });

    const annotation = res.body?.responses?.[0];
    if (annotation?.error) {
      return this.failure(annotation.error.message ?? 'Vision could not read that file.', { code: 'vision_rejected' });
    }

    const text = annotation?.fullTextAnnotation?.text ?? '';
    if (!text.trim()) {
      return this.failure('No readable text was found in that document.', { code: 'no_text' });
    }

    const pageConfidences = (annotation?.fullTextAnnotation?.pages ?? [])
      .map(p => p.confidence).filter(c => typeof c === 'number');
    const overall = pageConfidences.length
      ? pageConfidences.reduce((a, b) => a + b, 0) / pageConfidences.length
      : 0.7;

    return this.success({
      text,
      profile,
      fields: structureFields(text, profile, overall),
      overallConfidence: Number(overall.toFixed(3)),
      pageCount: annotation?.fullTextAnnotation?.pages?.length ?? 1,
    });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    // A 1×1 white PNG — the cheapest possible real round trip.
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await this.request(
      `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(this.env.GOOGLE_VISION_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ image: { content: pixel }, features: [{ type: 'TEXT_DETECTION' }] }] }),
      });
    if (!res.ok) return this.failure(res.error, { code: 'vision_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

/** Pull profile fields out of raw OCR text, each with its own confidence. */
export function structureFields(text, profileKey, baseConfidence = 0.7) {
  const profile = OCR_PROFILES[profileKey] ?? OCR_PROFILES.gst_invoice;
  return profile.fields.map(field => {
    let value = null;
    let matched = false;
    for (const pattern of field.patterns) {
      const m = pattern.exec(text);
      if (m?.[1]) { value = m[1].trim(); matched = true; break; }
    }
    return {
      key: field.key,
      label: field.label,
      value,
      // A pattern that did not match scores zero; a match inherits the page
      // confidence, discounted slightly because the regex is a heuristic.
      confidence: matched ? Number((baseConfidence * 0.92).toFixed(3)) : 0,
      needsReview: !matched || baseConfidence < 0.85,
    };
  });
}

export { OCR_PROFILES };

// ===========================================================================
// SPEECH-TO-TEXT — Google Cloud Speech
// ===========================================================================

export class SpeechProvider extends Provider {
  constructor(env) {
    super({
      key: 'google_speech',
      name: 'Google Cloud Speech-to-Text',
      category: 'speech',
      requiredKeys: ['GOOGLE_SPEECH_API_KEY'],
      env,
      docsUrl: 'https://cloud.google.com/speech-to-text/docs',
    });
  }

  /**
   * Transcribe short audio (under a minute) synchronously. Longer audio needs
   * the long-running endpoint plus a GCS object, which the caller is told.
   */
  async transcribe(bytes, { encoding = 'WEBM_OPUS', sampleRateHertz = 48000, languageCode = 'en-IN', durationSeconds = 0 } = {}) {
    if (!this.isConfigured()) return this.notConfigured('transcribe that recording');

    if (durationSeconds > 60) {
      return this.failure(
        'Recordings longer than a minute need the asynchronous transcription endpoint, which requires a Google Cloud Storage bucket to be configured.',
        { code: 'duration_exceeds_sync_limit' });
    }

    const res = await this.request(
      `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.env.GOOGLE_SPEECH_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            encoding, sampleRateHertz, languageCode,
            alternativeLanguageCodes: ['hi-IN'],
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: true,
            model: 'latest_long',
          },
          audio: { content: arrayBufferToBase64(bytes) },
        }),
        timeoutMs: 45000,
      });

    if (!res.ok) return this.failure(res.error, { code: 'speech_error', raw: res.body });

    const results = res.body?.results ?? [];
    if (!results.length) {
      return this.failure('No speech was detected in that recording.', { code: 'no_speech' });
    }

    const segments = results.map((r, i) => {
      const alt = r.alternatives?.[0] ?? {};
      const words = alt.words ?? [];
      return {
        index: i,
        text: alt.transcript ?? '',
        confidence: alt.confidence ?? null,
        start: words[0]?.startTime ? parseFloat(words[0].startTime) : null,
        end: words.at(-1)?.endTime ? parseFloat(words.at(-1).endTime) : null,
      };
    });

    const fullText = segments.map(s => s.text).join(' ').trim();
    const confidences = segments.map(s => s.confidence).filter(c => typeof c === 'number');

    return this.success({
      text: fullText,
      segments,
      languageCode: res.body?.results?.[0]?.languageCode ?? languageCode,
      confidence: confidences.length ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)) : null,
      wordCount: fullText.split(/\s+/).filter(Boolean).length,
    });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.request(
      `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.env.GOOGLE_SPEECH_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: 'en-IN' },
          audio: { content: '' },
        }),
      });
    // An empty-audio request returns 400 with a specific message when the key
    // is valid, and 403 when it is not — so 400 counts as a reachable service.
    if (res.httpStatus === 400) return this.success({ reachable: true, note: 'Credentials accepted.' });
    if (!res.ok) return this.failure(res.error, { code: 'speech_test_failed', raw: res.body });
    return this.success({ reachable: true });
  }
}

// ===========================================================================
// LLM — Claude API (Anthropic)
// ===========================================================================

export class ClaudeProvider extends Provider {
  constructor(env) {
    super({
      key: 'anthropic',
      name: 'Claude API',
      category: 'llm',
      requiredKeys: ['ANTHROPIC_API_KEY'],
      optionalKeys: ['ANTHROPIC_MODEL'],
      env,
      docsUrl: 'https://docs.anthropic.com/en/api/messages',
    });
  }

  get model() { return this.env.ANTHROPIC_MODEL || 'claude-sonnet-5'; }

  /**
   * A single completion.
   * @param {object} options
   * @param {string} options.system    system prompt
   * @param {Array} options.messages   [{role, content}]
   * @param {number} [options.maxTokens]
   * @param {object} [options.jsonSchema] when set, asks for structured JSON
   */
  async complete({ system, messages, maxTokens = 1500, temperature = 0.2, jsonSchema = null }) {
    if (!this.isConfigured()) return this.notConfigured('ask the assistant');

    const started = Date.now();
    const systemPrompt = jsonSchema
      ? `${system}\n\nRespond with a single JSON object matching this shape, and nothing else:\n${JSON.stringify(jsonSchema, null, 2)}`
      : system;

    const res = await this.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages,
      }),
      timeoutMs: 60000,
    });

    if (!res.ok) {
      return this.failure(res.error, {
        code: res.body?.error?.type ? `anthropic_${res.body.error.type}` : 'anthropic_error',
        raw: res.body,
        retryable: res.httpStatus === 429 || res.httpStatus >= 500,
      });
    }

    const text = (res.body?.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    let parsed = null;
    if (jsonSchema) {
      parsed = extractJson(text);
      if (!parsed) {
        return this.failure('The assistant did not return usable structured output.', {
          code: 'bad_json', raw: { text },
        });
      }
    }

    return this.success({
      text,
      json: parsed,
      model: res.body?.model ?? this.model,
      tokensIn: res.body?.usage?.input_tokens ?? null,
      tokensOut: res.body?.usage?.output_tokens ?? null,
      stopReason: res.body?.stop_reason ?? null,
      latencyMs: Date.now() - started,
    });
  }

  async test() {
    if (!this.isConfigured()) return this.notConfigured('run a connection test');
    const res = await this.complete({
      system: 'Reply with the single word: ok',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 16,
    });
    if (!res.ok) return res;
    return this.success({ model: res.data.model, reachable: true });
  }
}

/** Pull the first JSON object out of a model response. */
function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

function arrayBufferToBase64(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export { arrayBufferToBase64, extractJson, RESULT_STATUS };
