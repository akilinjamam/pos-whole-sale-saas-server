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

// ─── Subscription lifecycle (SaaS phase 6) ──────────────────────────────────────────────

/** "24 Oct 2026", in the app's time zone — the day a customer would call it. */
export function dateText(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.locale.timezone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

const subscriptionLink = () => ({
  label: 'Open my subscription',
  url: `${config.saas.publicUrl}/settings/subscription`,
});

/** How to pay, when the platform has said — every money email ends with it. */
function howToPay(): string[] {
  const how = config.saas.billingInstructions;
  return how ? [`How to pay: ${how}`] : ['Reply to this email and we will tell you how to pay.'];
}

interface OwnerMail {
  to: string;
  name: string;
  businessName: string;
}

/** Welcome, once the owner has confirmed their address (signup → verify). */
export function welcome(input: OwnerMail & { trialEndsAt: Date | null }): MailMessage {
  const action = { label: 'Open my dashboard', url: `${config.saas.publicUrl}/` };
  const paragraphs = [
    `Hello ${input.name},`,
    `Your email is confirmed and ${input.businessName} is ready on ${PRODUCT}.`,
    ...(input.trialEndsAt
      ? [`Your free trial runs until ${dateText(input.trialEndsAt)}. Everything is open to try — products, dealers, orders, dispatch, invoices, the counter POS and reports.`]
      : []),
    'A good first hour: add your company details, your first products, and one dealer. The checklist on your dashboard walks you through it.',
  ];
  return {
    to: input.to,
    subject: `Welcome to ${PRODUCT}`,
    text: text(paragraphs, action),
    html: layout(`Welcome, ${input.businessName}`, paragraphs, action),
  };
}

/** 7, 3 and 1 days before a trial or paid period ends. */
export function subscriptionEnding(
  input: OwnerMail & {
    isTrial: boolean;
    daysLeft: number;
    endsAt: Date;
    planName: string | null;
    priceMonthlyMinor: number | null;
  },
): MailMessage {
  const when = input.daysLeft <= 1 ? 'tomorrow' : `in ${input.daysLeft} days`;
  const what = input.isTrial ? 'free trial' : 'subscription';
  const plan =
    input.planName && input.priceMonthlyMinor !== null
      ? `To keep using it, renew the ${input.planName} plan (${formatMoney(input.priceMonthlyMinor)} a month), or choose another plan on your subscription page.`
      : 'To keep using it, choose a plan on your subscription page.';
  const paragraphs = [
    `Hello ${input.name},`,
    `The ${what} for ${input.businessName} ends ${when}, on ${dateText(input.endsAt)}.`,
    plan,
    ...howToPay(),
    'Your data stays safe either way.',
  ];
  return {
    to: input.to,
    subject: `Your ${what} ends ${when}`,
    text: text(paragraphs, subscriptionLink()),
    html: layout(`Your ${what} ends ${when}`, paragraphs, subscriptionLink()),
  };
}

/** The day after the end: payment is due, and the account still works until the grace end. */
export function subscriptionExpired(
  input: OwnerMail & { isTrial: boolean; graceEndsAt: Date },
): MailMessage {
  const what = input.isTrial ? 'free trial' : 'subscription';
  const paragraphs = [
    `Hello ${input.name},`,
    `The ${what} for ${input.businessName} has ended and payment is now due.`,
    `Everything keeps working until ${dateText(input.graceEndsAt)}. After that the account becomes read-only: you can still see and print everything, but not add or change anything until you pay.`,
    ...howToPay(),
  ];
  return {
    to: input.to,
    subject: `Payment due — your ${what} has ended`,
    text: text(paragraphs, subscriptionLink()),
    html: layout('Payment due', paragraphs, subscriptionLink()),
  };
}

/** The grace period is over: the account is read-only until a payment is recorded. */
export function subscriptionReadOnly(input: OwnerMail): MailMessage {
  const paragraphs = [
    `Hello ${input.name},`,
    `${input.businessName} is now read-only because payment has not arrived. You can still sign in, look things up and print, but sales, orders and other changes are paused.`,
    'As soon as your payment is recorded, everything works again — nothing has been lost.',
    ...howToPay(),
  ];
  return {
    to: input.to,
    subject: `${input.businessName} is now read-only`,
    text: text(paragraphs, subscriptionLink()),
    html: layout('Your account is read-only', paragraphs, subscriptionLink()),
  };
}

/** After the platform records a payment. */
export function paymentReceived(
  input: OwnerMail & {
    receiptNo: string;
    amountMinor: number;
    planName: string;
    periodEnd: Date;
  },
): MailMessage {
  const paragraphs = [
    `Hello ${input.name},`,
    `Thank you — we have received ${formatMoney(input.amountMinor)} for ${input.businessName} (receipt ${input.receiptNo}).`,
    `You are on the ${input.planName} plan, paid until ${dateText(input.periodEnd)}.`,
  ];
  return {
    to: input.to,
    subject: `Payment received — ${input.receiptNo}`,
    text: text(paragraphs, subscriptionLink()),
    html: layout('Payment received', paragraphs, subscriptionLink()),
  };
}

/** After the platform suspends a business. The reason stays internal; they are asked to call. */
export function accountSuspended(input: OwnerMail): MailMessage {
  const paragraphs = [
    `Hello ${input.name},`,
    `The ${PRODUCT} account for ${input.businessName} has been suspended, so no one in the business can use it for now. Your data is kept.`,
    'Please reply to this email or contact us to sort it out.',
  ];
  return {
    to: input.to,
    subject: `${input.businessName} has been suspended`,
    text: text(paragraphs),
    html: layout('Your account is suspended', paragraphs),
  };
}

/** Monday-morning numbers for the platform admins. */
export function weeklySummary(input: {
  to: string;
  adminName: string;
  weekOf: string;
  lines: string[];
  lists: { heading: string; items: string[] }[];
}): MailMessage {
  const action = { label: 'Open the platform', url: `${config.saas.publicUrl}/platform` };
  const listText = input.lists.flatMap((l) =>
    l.items.length ? [`${l.heading}:\n${l.items.map((i) => `  • ${i}`).join('\n')}`] : [],
  );
  const listHtml = input.lists
    .filter((l) => l.items.length)
    .map(
      (l) =>
        `<p style="margin:0 0 8px;font-weight:bold">${escape(l.heading)}</p><ul style="margin:0 0 16px;padding-left:20px">${l.items.map((i) => `<li>${escape(i)}</li>`).join('')}</ul>`,
    )
    .join('');
  const intro = [`Hello ${input.adminName},`, ...input.lines];
  return {
    to: input.to,
    subject: `${PRODUCT} — week of ${input.weekOf}`,
    text: text([...intro, ...listText], action),
    html: layout(`Week of ${input.weekOf}`, intro, action).replace(
      '<p style="margin:24px 0">',
      `${listHtml}<p style="margin:24px 0">`,
    ),
  };
}
