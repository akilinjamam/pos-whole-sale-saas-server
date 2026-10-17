import { config } from '../config/env.js';

import { formatMoney } from '../shared/money.js';

import type { MailMessage } from './mailer.service.js';

/**
 * The emails the platform sends, as plain functions: data in, `{ subject, text, html }` out.
 *
 * Kept deliberately plain — one column, no images, no tracking — because these are account emails
 * that must reach a Gmail inbox from a new sending domain, and every extra element costs
 * deliverability. Every value interpolated into HTML goes through `escape`.
 */

const PRODUCT = 'Optical Wholesale';

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout(heading: string, paragraphs: string[], action?: { label: string; url: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escape(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escape(action.url)}" style="background:#0f766e;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escape(action.label)}</a></p>` +
      `<p style="margin:0 0 16px;font-size:13px;color:#555">If the button does not work, copy this link into your browser:<br>${escape(action.url)}</p>`
    : '';
  return (
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:560px;margin:0 auto;padding:24px">` +
    `<h1 style="font-size:20px;margin:0 0 16px">${escape(heading)}</h1>${body}${button}` +
    `<p style="margin:32px 0 0;font-size:12px;color:#888">${PRODUCT}</p></body></html>`
  );
}

function text(paragraphs: string[], action?: { label: string; url: string }): string {
  return [...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : []), '', PRODUCT].join('\n\n');
}

export function link(path: string, token: string): string {
  return `${config.saas.publicUrl}${path}?token=${encodeURIComponent(token)}`;
}

export function verifyEmail(input: {
  to: string;
  name: string;
  businessName: string;
  token: string;
  hoursValid: number;
}): MailMessage {
  const action = { label: 'Verify my email', url: link('/verify-email', input.token) };
  const paragraphs = [
    `Hello ${input.name},`,
    `Welcome to ${PRODUCT}. Please confirm that ${input.to} is your email address for ${input.businessName}.`,
    `The link works for ${input.hoursValid} hours. If you did not sign up, you can ignore this email.`,
  ];
  return {
    to: input.to,
    subject: `Verify your email for ${PRODUCT}`,
    text: text(paragraphs, action),
    html: layout('Verify your email', paragraphs, action),
  };
}

export function resetPassword(input: {
  to: string;
  name: string;
  token: string;
  minutesValid: number;
}): MailMessage {
  const action = { label: 'Choose a new password', url: link('/reset-password', input.token) };
  const paragraphs = [
    `Hello ${input.name},`,
    `Someone asked to reset the password for ${input.to}. If it was you, use the link below.`,
    `The link works for ${input.minutesValid} minutes and only once. If it was not you, ignore this email — your password stays as it is.`,
  ];
  return {
    to: input.to,
    subject: `Reset your ${PRODUCT} password`,
    text: text(paragraphs, action),
    html: layout('Reset your password', paragraphs, action),
  };
}

export interface PlanRequestedInput {
  to: string;
  adminName: string;
  orgId: string;
  businessName: string;
  planName: string;
  cycle: 'MONTHLY' | 'YEARLY';
  priceMinor: number;
  note: string | null;
  requestedBy: string;
}

/** To the platform admins: a business has asked for a plan (Settings → Subscription). */
export function planRequested(input: PlanRequestedInput): MailMessage {
  const action = {
    label: 'Open the business',
    url: `${config.saas.publicUrl}/platform/tenants/${encodeURIComponent(input.orgId)}`,
  };
  const per = input.cycle === 'YEARLY' ? 'year' : 'month';
  const paragraphs = [
    `Hello ${input.adminName},`,
    `${input.businessName} has asked for the ${input.planName} plan, paid every ${per} (${formatMoney(input.priceMinor)} per ${per}).`,
    `Requested by ${input.requestedBy}.`,
    ...(input.note ? [`Their note: ${input.note}`] : []),
    'Nothing changes until you record their payment or change their plan.',
  ];
  return {
    to: input.to,
    subject: `Plan request: ${input.businessName} → ${input.planName}`,
    text: text(paragraphs, action),
    html: layout('A business has asked for a plan', paragraphs, action),
  };
}
