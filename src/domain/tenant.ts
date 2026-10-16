/**
 * Tenant rules that need no database — the slug a business gets and when its trial ends.
 *
 * Kept pure so the edge cases (Bangla-only names, punctuation, collisions) are unit-tested rather
 * than discovered on the signup page.
 */

/** Long enough to be readable in a URL, short enough to type. */
export const SLUG_MAX_LENGTH = 40;

/** The default length of a free trial, in days. */
export const DEFAULT_TRIAL_DAYS = 14;

/**
 * Slugs that would shadow a route or an obvious platform address if subdomains or vanity URLs
 * are ever introduced. Cheap to reserve now, painful to take back from a paying business later.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'billing',
  'help',
  'login',
  'platform',
  'signup',
  'support',
  'www',
]);

/**
 * `"Rahman Optical & Co."` → `"rahman-optical-co"`.
 *
 * Anything outside a–z / 0–9 becomes a separator, so a name written only in Bangla yields an
 * empty base — `baseSlug` then falls back to `"business"` and the collision suffix makes it unique.
 */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

/** The slug to try first: the slugified name, or `business` when nothing usable is left. */
export function baseSlug(name: string): string {
  const slug = slugify(name);
  return slug.length >= 2 && !RESERVED_SLUGS.has(slug) ? slug : 'business';
}

/**
 * The n-th candidate for a name: `base`, then `base-2`, `base-3`, … — trimmed so the suffix never
 * pushes it past `SLUG_MAX_LENGTH`.
 */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

/** The instant a trial started at `start` ends. */
export function trialEndsAt(start: Date, days: number = DEFAULT_TRIAL_DAYS): Date {
  if (!Number.isInteger(days) || days < 0) throw new Error(`Invalid trial length: ${days}`);
  return new Date(start.getTime() + days * 86_400_000);
}
