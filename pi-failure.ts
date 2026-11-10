// ---------------------------------------------------------------------------
// Typed Pi failures (ADR 0015, R4).
//
// Pi can fail before it produces an assistant message: DNS/TLS/HTTP transport
// errors, an unwritable credential lock, a missing API key or a resume session
// that the new overlay does not contain. This module turns those strings into
// one stable category plus a redacted detail so receipts name the cause and the
// worker can retry only the safe, retryable transport failures.
// ---------------------------------------------------------------------------

export type PiFailureCategory =
  | 'transport_dns'
  | 'transport_tls'
  | 'transport_http'
  | 'transport_fetch'
  | 'credential_lock'
  | 'auth_missing'
  | 'resume_session_unavailable'
  | 'zero_messages'
  | 'unknown';

export interface PiFailure {
  category: PiFailureCategory;
  summary: string;
  retryable: boolean;
  detail: string;
  httpStatus?: number;
}

/** Everything classification may inspect. The receipt form is the public
 * worker shape; `assistantMessages` is accepted directly so a caller holding a
 * partial parse does not have to fabricate a receipt. */
export interface ClassifyPiFailureInput {
  exitCode: number | null;
  stderr: string;
  receipt?: { assistantMessages?: number } | null;
  assistantMessages?: number;
  /** Raw event JSONL or an equivalent text projection of assistant/event errors. */
  eventsText?: string | readonly string[] | readonly { errorMessage?: string }[];
  /** Error messages captured from assistant/event records. */
  errorMessages?: string | readonly string[] | readonly { errorMessage?: string }[];
}

const CREDENTIAL_REMEDIATION = 'Junior runs Pi with a run-local copy of your Pi credentials; if this path is your ambient Pi directory, set PI_CODING_AGENT_DIR to a writable directory or report it';

const REDACTED = '[REDACTED]';

/** Redact provider keys, bearer credentials, credential headers, JSON secret
 * values and HTTP response bodies. Safe on arbitrary logs; never throws. */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return '';
  let out = text;

  // JSON object members whose name says they hold a credential. Keep the key
  // so the log remains diagnosable; replace only the value.
  out = out.replace(
    /"([^"\\]*(?:token|key|secret|password)[^"\\]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
    `"$1":"${REDACTED}"`,
  );

  // Authorization / proxy authorization headers, with or without a scheme.
  out = out.replace(
    /\b((?:proxy-)?authorization)\s*:\s*(?:(?:bearer|basic)\s+)?[^\s,;]+/gi,
    `$1: ${REDACTED}`,
  );
  // API-key style headers.
  out = out.replace(
    /\b(x-api-key|api-key|api_key)\s*:\s*[^\s,;]+/gi,
    `$1: ${REDACTED}`,
  );
  // A bare bearer token after a non-header label.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);

  // Provider keys. Check the longer sk-or- prefix first so only one marker is
  // emitted for an OpenRouter key.
  out = out.replace(/\bsk-or-[A-Za-z0-9._-]+/gi, REDACTED);
  out = out.replace(/\bsk-[A-Za-z0-9._-]+/gi, REDACTED);

  // HTTP response bodies, both a JSON member and a textual `body: ...` tail.
  out = out.replace(
    /"([^"\\]*(?:body|response)[^"\\]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
    `"$1":"${REDACTED}"`,
  );
  out = out.replace(
    /\b((?:response\s*)?body)\s*:\s*[^\n]+/gi,
    `$1: ${REDACTED}`,
  );

  return out;
}

function eventText(input: ClassifyPiFailureInput): string {
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string') {
      out.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (value && typeof value === 'object' && typeof (value as { errorMessage?: unknown }).errorMessage === 'string') {
      out.push((value as { errorMessage: string }).errorMessage);
    }
  };
  add(input.eventsText);
  add(input.errorMessages);
  return out.join('\n');
}

/** The auth lock path named by a credential failure, for an actionable summary. */
function credentialLockPath(text: string): string | undefined {
  const quoted = text.match(/['"`]([^'"`]*auth\.json\.lock)[^'"`]*['"`]/i);
  if (quoted) return quoted[1];
  const bare = text.match(/([^\s:'"`]+auth\.json\.lock)\b/i);
  return bare?.[1];
}

function credentialFailure(text: string, detail: string): PiFailure {
  const path = credentialLockPath(text);
  const summary = path
    ? `Pi could not read or lock the credential store at ${path}; ${CREDENTIAL_REMEDIATION}`
    : `Pi could not read or lock its credential store; ${CREDENTIAL_REMEDIATION}`;
  return result('credential_lock', summary, false, detail);
}

function assistantCount(input: ClassifyPiFailureInput): number | undefined {
  if (typeof input.assistantMessages === 'number') return input.assistantMessages;
  const fromReceipt = input.receipt?.assistantMessages;
  return typeof fromReceipt === 'number' ? fromReceipt : undefined;
}

function httpStatusIn(stderr: string): number | undefined {
  const patterns = [
    /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:status\s+)?([45]\d{2})\b/i,
    /\bstatus(?:\s*code)?\s*[:=]?\s*([45]\d{2})\b/i,
    /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
    /\b(?:error|failed|failure|response|request)[^\n]{0,30}?\b([45]\d{2})\b/i,
  ];
  for (const pattern of patterns) {
    const match = stderr.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
    }
  }
  return undefined;
}

function retryableHttp(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function result(
  category: PiFailureCategory,
  summary: string,
  retryable: boolean,
  detail: string,
  httpStatus?: number,
): PiFailure {
  return httpStatus === undefined
    ? { category, summary, retryable, detail }
    : { category, summary, retryable, detail, httpStatus };
}

/** Classify one Pi process failure. Returns null when the process exited 0
 * with at least one assistant message (a successful run). */
export function classifyPiFailure(input: ClassifyPiFailureInput): PiFailure | null {
  const stderr = typeof input.stderr === 'string' ? input.stderr : '';
  const exitCode = input.exitCode;
  const messages = assistantCount(input);
  const combined = [stderr, eventText(input)].filter(Boolean).join('\n');
  const detail = redactSecrets(combined).slice(-500);

  // A process that produced an assistant message and exited cleanly is a
  // success even when its stderr mentions a transient transport warning.
  if (exitCode === 0 && typeof messages === 'number' && messages > 0) return null;

  // Credential-store failures are actionable and must be visible even when the
  // only evidence is an assistant/event error rather than stderr.
  if (/Credential store read failed/i.test(combined)
    || (/(EROFS|EACCES|EPERM)/i.test(combined) && /\.lock\b/i.test(combined))) {
    return credentialFailure(combined, detail);
  }
  if (/No session found matching/i.test(stderr)) {
    return result(
      'resume_session_unavailable',
      'The referenced Pi session is unavailable; start a fresh session or supply a valid session file.',
      false,
      detail,
    );
  }
  if (/No API key found/i.test(stderr)) {
    return result(
      'auth_missing',
      'Pi has no API key for the provider; run /login for that provider and retry.',
      false,
      detail,
    );
  }
  if (/\b(ENOTFOUND|EAI_AGAIN)\b/i.test(stderr)) {
    return result(
      'transport_dns',
      'Pi could not resolve the provider host; check DNS and network access, then retry.',
      false,
      detail,
    );
  }
  if (/(CERT_|SSL|TLS)/i.test(stderr)) {
    return result(
      'transport_tls',
      'Pi could not establish a trusted TLS connection; check certificates and proxy settings, then retry.',
      false,
      detail,
    );
  }

  const httpStatus = httpStatusIn(stderr);
  if (httpStatus !== undefined) {
    const retry = retryableHttp(httpStatus);
    return result(
      'transport_http',
      retry
        ? `Pi received HTTP ${httpStatus} from the provider; retry shortly.`
        : `Pi received HTTP ${httpStatus} from the provider; inspect the request and credentials.`,
      retry,
      detail,
      httpStatus,
    );
  }
  if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(stderr)) {
    return result(
      'transport_fetch',
      'Pi could not fetch the provider response; check network access and retry.',
      true,
      detail,
    );
  }

  if (exitCode === 0 && messages === 0) {
    return result(
      'zero_messages',
      'Pi exited cleanly without an assistant message; inspect worker.log and retry.',
      false,
      detail,
    );
  }
  if (exitCode !== 0 && exitCode !== null) {
    return result(
      'unknown',
      'Pi failed for an unclassified reason; inspect stderr and worker.log.',
      false,
      detail,
    );
  }
  return null;
}
