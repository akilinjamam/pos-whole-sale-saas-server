import nodemailer from 'nodemailer';

import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

import type { Transporter } from 'nodemailer';

/**
 * Outgoing email — SaaS phase 3.
 *
 * With `SMTP_HOST` set, mail goes out through it. Without it (development), each message is
 * written to the log instead, link included, so signup and password reset can be exercised end to
 * end with no mail server. Production refuses to start without SMTP (`config/env.ts`).
 *
 * Sending is **never** done inside a transaction: `withTransaction` may run its body more than
 * once, and a customer should not get two verification emails because a counter was busy. Callers
 * commit first, then send.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

let transporter: Transporter | null = null;

function transport(): Transporter | null {
  if (!config.mail.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    ...(config.mail.user ? { auth: { user: config.mail.user, pass: config.mail.pass ?? '' } } : {}),
  });
  return transporter;
}

/** Test hook: messages "sent" while no SMTP is configured, newest last. */
export const outbox: MailMessage[] = [];

/**
 * Send one message. Resolves `false` rather than throwing when delivery fails: a signup has already
 * committed by the time its email goes out, and failing the request would tell the user their
 * account was not created when it was. The failure is logged loudly; the user can ask for a resend.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  const smtp = transport();

  if (!smtp) {
    outbox.push(message);
    if (outbox.length > 50) outbox.shift();
    logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      'Email (not sent — no SMTP_HOST configured)',
    );
    return true;
  }

  try {
    await smtp.sendMail({ from: config.mail.from, ...message });
    logger.info({ to: message.to, subject: message.subject }, 'Email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: message.to, subject: message.subject }, 'Email delivery failed');
    return false;
  }
}
