import type { EmailKind, OutboundEmail } from './mailer.ts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Links in emails must point at our own origin (defence in depth: Better Auth builds them from baseURL).
 * Throws instead of sending a link to anywhere else.
 */
export function assertOwnOrigin(link: string, origin: string): string {
  const u = new URL(link);
  if (u.origin !== origin) throw new Error('refusing to email a link to a foreign origin');
  return u.toString();
}

function layout(title: string, intro: string, cta: string, link: string, outro: string) {
  const html = `<!doctype html><html><body style="margin:0;background:#f7f8fa;font-family:system-ui,sans-serif;color:#17202a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #dce2e8;border-radius:12px"><tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 20px;line-height:1.5">${esc(intro)}</p>
<p style="margin:0 0 20px"><a href="${esc(link)}" style="display:inline-block;background:#215cc5;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">${esc(cta)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#596676;line-height:1.5">${esc(outro)}</p>
<p style="margin:0;font-size:12px;color:#596676;word-break:break-all">${esc(link)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${title}\n\n${intro}\n\n${cta}: ${link}\n\n${outro}\n`;
  return { html, text };
}

export function buildEmail(kind: EmailKind, to: string, link: string, idempotencyKey: string): OutboundEmail {
  if (kind === 'verify-email') {
    const { html, text } = layout(
      'Confirm your email',
      'Confirm your email address to finish creating your AR Creator account.',
      'Confirm email',
      link,
      'This link expires in 1 hour. If you did not create an account, you can ignore this email.',
    );
    return { kind, to, subject: 'Confirm your AR Creator email', html, text, idempotencyKey };
  }
  const { html, text } = layout(
    'Reset your password',
    'We received a request to reset the password for your AR Creator account.',
    'Choose a new password',
    link,
    'This link expires in 1 hour and can be used once. If you did not request a reset, you can ignore this email; your password will not change.',
  );
  return { kind, to, subject: 'Reset your AR Creator password', html, text, idempotencyKey };
}
