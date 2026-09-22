import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { getEnv } from '../../config/env';
import { logger } from '../../utils/logger';
import { safeHeader } from '../../utils/escapeHtml';

/**
 * Rewritten mailer. Fixes vs legacy `server/services/mailer.ts` (BACKEND_PLAN §6, SECURITY_RISKS #19-#22):
 *  1. OTP codes/HTML bodies are never logged - only a masked recipient and the message id.
 *  2. TLS certificate verification is ON (legacy switched certificate checking off); STARTTLS is required on non-implicit-TLS ports.
 *  3. Templates escape every interpolated value (see templates.ts).
 *  4. ONE configured sender/credential set (legacy looped several hard-coded identities against one password and rewrote typos).
 *  5. Failures are failures: `sendMail` throws `MailDeliveryError`; there is no "delivered: true" fallback when SMTP is missing.
 */
export class MailDeliveryError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'MailDeliveryError';
  }
}

export interface MailMessage { to: string | string[]; subject: string; text: string; html: string }
export interface SentMail extends MailMessage { messageId: string; from: string }

/** In-memory outbox used when MAIL_TRANSPORT=memory (refused in production by env validation) - tests read from here. */
export const memoryOutbox: SentMail[] = [];

let transporter: Transporter | undefined;
let overrideTransport: Pick<Transporter, 'sendMail'> | undefined;
export const __setTransportForTests = (t?: Pick<Transporter, 'sendMail'>) => {
  overrideTransport = t;
  transporter = undefined;
};

export function buildSmtpOptions(): SMTPTransport.Options {
  const e = getEnv();
  const secure = e.SMTP_SECURE; // implicit TLS (465)
  return {
    host: e.SMTP_HOST,
    port: e.SMTP_PORT,
    secure,
    requireTLS: !secure, // never fall back to plaintext on 587
    auth: { user: e.SMTP_USER, pass: e.SMTP_PASS }, // exactly one identity
    tls: { minVersion: 'TLSv1.2' }, // certificate + hostname verification stay at nodemailer's secure defaults (verification ON)
    connectionTimeout: 10_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  };
}

function getTransporter(): Pick<Transporter, 'sendMail'> {
  if (overrideTransport) return overrideTransport;
  return (transporter ??= nodemailer.createTransport(buildSmtpOptions()));
}

const maskRecipient = (to: string | string[]) =>
  (Array.isArray(to) ? to : [to]).map((a) => a.replace(/^(.).*(@.*)$/, '$1***$2')).join(', ');

export async function sendMail(msg: MailMessage): Promise<{ messageId: string }> {
  const env = getEnv();
  const from = env.SMTP_FROM ?? 'no-reply@localhost';
  const subject = safeHeader(msg.subject);
  const to = Array.isArray(msg.to) ? msg.to : [msg.to];
  if (to.some((a) => /[\r\n,;<>]/.test(a))) throw new MailDeliveryError('Invalid recipient address');

  if (!overrideTransport && env.MAIL_TRANSPORT === 'memory') {
    if (env.NODE_ENV === 'production') throw new MailDeliveryError('memory mail transport is not allowed in production');
    const messageId = `<memory-${memoryOutbox.length + 1}@local>`;
    memoryOutbox.push({ ...msg, subject, to, messageId, from });
    logger.info({ to: maskRecipient(to), messageId }, 'mail queued (memory transport)');
    return { messageId };
  }
  if (!overrideTransport && !(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM)) {
    throw new MailDeliveryError('SMTP is not configured'); // never pretend it was delivered
  }
  try {
    const info = await getTransporter().sendMail({ from, to, subject, text: msg.text, html: msg.html });
    logger.info({ to: maskRecipient(to), messageId: info.messageId }, 'mail sent');
    return { messageId: info.messageId };
  } catch (err) {
    logger.warn({ to: maskRecipient(to), reason: (err as Error).message }, 'mail delivery failed');
    throw new MailDeliveryError('Mail delivery failed', err);
  }
}
