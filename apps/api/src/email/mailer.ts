import { redact } from '@ar-creator/db';

export type EmailKind = 'verify-email' | 'reset-password';

export interface OutboundEmail {
  kind: EmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Prevents duplicate sends when a request is retried. */
  idempotencyKey: string;
}

export interface Mailer {
  readonly transport: 'resend' | 'dev-mailbox' | 'disabled';
  send(email: OutboundEmail): Promise<void>;
}

export class EmailDeliveryError extends Error {
  override name = 'EmailDeliveryError';
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(redact(message));
    this.status = status;
  }
}

/** Resend REST API (https://resend.com/docs/api-reference/emails/send-email). The key comes from a Worker secret. */
export class ResendMailer implements Mailer {
  readonly transport = 'resend' as const;
  private readonly apiKey: string;
  private readonly from: string;
  private readonly fetchImpl: typeof fetch;
  constructor(apiKey: string, from: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.from = from;
    this.fetchImpl = fetchImpl;
  }

  async send(email: OutboundEmail): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          tags: [{ name: 'category', value: email.kind }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new EmailDeliveryError(`resend request failed: ${String((e as Error).message ?? e)}`, null);
    }
    if (!res.ok) {
      // Resend error bodies are {name, message}; never include request headers (API key) in errors.
      const body = (await res.json().catch(() => null)) as { name?: string; message?: string } | null;
      throw new EmailDeliveryError(`resend ${res.status}: ${body?.name ?? 'error'} ${body?.message ?? ''}`.trim(), res.status);
    }
  }
}

/**
 * Local development only: keeps the last 50 messages in isolate memory so the UI flow and e2e tests can
 * follow verification / reset links without a real provider. Exposed via GET /api/dev/mailbox, which returns
 * 404 unless APP_ENV=development, EMAIL_TRANSPORT=dev-mailbox AND the request host is localhost.
 */
const DEV_MAILBOX: (OutboundEmail & { at: string })[] = [];
export class DevMailbox implements Mailer {
  readonly transport = 'dev-mailbox' as const;
  async send(email: OutboundEmail): Promise<void> {
    DEV_MAILBOX.push({ ...email, at: new Date().toISOString() });
    if (DEV_MAILBOX.length > 50) DEV_MAILBOX.shift();
    console.log(JSON.stringify({ level: 'info', event: 'dev-mailbox.send', kind: email.kind, to: email.to }));
  }
  static list(to?: string) {
    return DEV_MAILBOX.filter((m) => !to || m.to === to.toLowerCase()).map(({ kind, to: t, subject, text, at }) => ({ kind, to: t, subject, text, at }));
  }
}

/** Fail-closed placeholder when email is not configured: callers get an error, nothing is sent. */
export class DisabledMailer implements Mailer {
  readonly transport = 'disabled' as const;
  async send(): Promise<void> {
    throw new EmailDeliveryError('email delivery is not configured', null);
  }
}
