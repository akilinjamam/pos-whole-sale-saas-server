/**
 * The permission catalog — shared by the server's route guards and the client's UI guards.
 *
 * This is the first *value* export in `src/shared/`. Everything before it was a type and was
 * erased at compile time; this one is bundled and executed on both sides, so the `@shared`
 * alias now has to resolve at runtime as well as to the typechecker.
 *
 * Why a catalog and not 44 booleans on the user document (the retail system's approach):
 *
 *  - `Permission` below is a union type *derived* from the catalog, so `requirePermission('oder:read')`
 *    is a compile error on the server and `<RequirePermission need="oder:read">` is a compile
 *    error on the client. A misspelt boolean flag is silently `undefined`, i.e. silently denied.
 *  - Adding a capability touches exactly two places: an entry here, and the guard on the route.
 *  - Roles are data, so the client can re-scope a role without a deploy; the catalog is code,
 *    so the set of *possible* capabilities cannot drift from what the routes actually check.
 *
 * Naming is `subject:verb`, lowerCamel on both sides of the colon. The subject is the business
 * noun, not the collection — `dealer:*` rather than `party:*`, because a user who may edit
 * dealers must not thereby be able to edit suppliers.
 */

/** Grouped for the permission-matrix editor; the grouping has no runtime meaning. */
export const PERMISSIONS = {
  // `org:export` — download every record of the business (SaaS phase 7). Separate from reading the
  // profile: it hands over costs, dealers and the whole ledger in one file.
  ORG: ['org:read', 'org:update', 'settings:manage', 'org:export'],

  USER: ['user:read', 'user:create', 'user:update', 'user:delete', 'user:resetPassword'],

  ROLE: ['role:read', 'role:create', 'role:update', 'role:delete'],

  LOCATION: ['location:read', 'location:create', 'location:update', 'location:delete'],

  DEALER: [
    'dealer:read',
    'dealer:create',
    'dealer:update',
    'dealer:delete',
    // Deliberately separate: a sales rep maintains dealers but must not raise their own limit.
    'dealer:setCreditLimit',
    'dealer:creditHold',
  ],

  CUSTOMER: ['customer:read', 'customer:create', 'customer:update'],

  SUPPLIER: ['supplier:read', 'supplier:create', 'supplier:update', 'supplier:delete'],

  CATALOG: [
    'product:read',
    'product:create',
    'product:update',
    'product:delete',
    'product:import',
    'variant:manage',
    'brand:manage',
    'category:manage',
    'barcode:print',
  ],

  PRICING: ['price:read', 'price:update', 'price:import', 'priceTier:manage'],

  STOCK: [
    'stock:read',
    'stock:adjust',
    'stock:transfer',
    'stock:count',
    // Gates the cost columns everywhere, by stripping fields in the serializer — not by
    // hiding them in the UI.
    'stock:viewCost',
    'stock:opening',
    'stock:reconcile',
  ],

  ORDER: [
    'order:read',
    'order:create',
    'order:update',
    'order:confirm',
    'order:cancel',
    'order:discount',
    'order:priceOverride',
    'order:creditOverride',
    'order:approve',
    'order:shortClose',
  ],

  DISPATCH: [
    'dispatch:read',
    'dispatch:create',
    'dispatch:pack',
    'dispatch:post',
    'dispatch:deliver',
    'dispatch:cancel',
  ],

  INVOICE: ['invoice:read', 'invoice:create', 'invoice:cancel', 'invoice:print'],

  PAYMENT: [
    'payment:read',
    'payment:receipt',
    'payment:supplierPay',
    'payment:allocate',
    'payment:cheque',
    'payment:cancel',
  ],

  LEDGER: ['ledger:read', 'ledger:opening', 'ledger:adjust', 'ledger:reconcile'],

  PURCHASE: [
    'po:read',
    'po:create',
    'po:update',
    'po:approve',
    'po:cancel',
    'po:shortClose',
    'grn:read',
    'grn:create',
    'grn:cancel',
  ],

  RETURN: [
    'return:read',
    'return:create',
    'return:approve',
    'creditNote:read',
    'creditNote:create',
  ],

  POS: [
    'pos:sell',
    'pos:discount',
    'pos:return',
    'pos:openSession',
    'pos:closeSession',
    // A cashier sees their own shift; a manager sees everyone's.
    'pos:viewAllSessions',
    'pos:holdSale',
  ],

  REPORT: [
    'report:sales',
    'report:stock',
    'report:receivables',
    'report:purchase',
    'report:profit',
    'report:pos',
  ],

  AUDIT: ['audit:read'],
} as const;

/** The catalog's group keys — the row grouping in the permission-matrix editor. */
export type PermissionModule = keyof typeof PERMISSIONS;

/**
 * The point of the whole file: every permission string in the system, as one union type.
 * An unknown string will not typecheck anywhere it is used as a `Permission`.
 */
export type Permission = (typeof PERMISSIONS)[PermissionModule][number];

export const PERMISSION_MODULES = Object.keys(PERMISSIONS) as PermissionModule[];

/** Flat list, in catalog order. Used by the seed, the role editor and the coverage test. */
export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_MODULES.flatMap(
  (m) => PERMISSIONS[m] as readonly Permission[],
);

const PERMISSION_SET: ReadonlySet<string> = new Set<string>(ALL_PERMISSIONS);

/** Human labels for the matrix editor's row groups. */
export const PERMISSION_MODULE_LABELS: Record<PermissionModule, string> = {
  ORG: 'Company & settings',
  USER: 'Users',
  ROLE: 'Roles',
  LOCATION: 'Locations',
  DEALER: 'Dealers',
  CUSTOMER: 'Customers',
  SUPPLIER: 'Suppliers',
  CATALOG: 'Catalog',
  PRICING: 'Pricing',
  STOCK: 'Inventory',
  ORDER: 'Wholesale orders',
  DISPATCH: 'Dispatch',
  INVOICE: 'Billing',
  PAYMENT: 'Payments',
  LEDGER: 'Ledger',
  PURCHASE: 'Purchase',
  RETURN: 'Returns',
  POS: 'Counter (POS)',
  REPORT: 'Reports',
  AUDIT: 'Audit',
};

/**
 * Runtime narrowing for strings that arrive from outside the type system — request bodies,
 * seed data, a role document loaded from the database that predates a catalog change.
 */
export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Drop anything no longer in the catalog. A removed permission must not survive in a role. */
export function toPermissions(values: readonly string[]): Permission[] {
  return values.filter(isPermission);
}

/**
 * The effective set: `union(roles) ∪ grants \ revokes`.
 *
 * Pure, and shared, because it is computed in three places that must agree exactly — at login
 * (to embed in the token), in `authenticate` (re-derived from the database on every request so
 * a role change takes effect without waiting for the token to expire), and in the client's
 * user editor (to preview what a grant or revoke will actually do).
 *
 * Revokes win over grants: a revoke is the explicit exception, and the safe resolution of a
 * contradiction is to deny.
 */
export function effectivePermissions(
  rolePermissions: readonly string[],
  grants: readonly string[] = [],
  revokes: readonly string[] = [],
): Permission[] {
  const effective = new Set<Permission>(toPermissions(rolePermissions));
  for (const p of toPermissions(grants)) effective.add(p);
  for (const p of toPermissions(revokes)) effective.delete(p);

  // Catalog order, not insertion order, so the token payload is stable between logins.
  return ALL_PERMISSIONS.filter((p) => effective.has(p));
}

// ─── System roles ───────────────────────────────────────────────────────────────────────

/**
 * The seven seeded roles. Their permission sets live in the server's seed, not here — roles
 * are editable data — but the codes are shared so the client can recognise a system role and
 * refuse to let the user delete it.
 */
export const SYSTEM_ROLE_CODES = [
  'OWNER',
  'ADMIN',
  'SALES_MANAGER',
  'SALES_REP',
  'STORE_KEEPER',
  'ACCOUNTS',
  'POS_CASHIER',
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];

export function isSystemRoleCode(value: string): value is SystemRoleCode {
  return (SYSTEM_ROLE_CODES as readonly string[]).includes(value);
}
