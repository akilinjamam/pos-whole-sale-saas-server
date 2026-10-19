import { Types } from 'mongoose';
import { ZodError } from 'zod';

import { ApiError } from '../../lib/ApiError.js';
import { paginate } from '../../lib/paginate.js';
import { assertProductBarcodesFree } from '../../services/barcode.service.js';
import { assertWithinLimit } from '../../services/subscription.service.js';
import { AXES_BY_TYPE, normaliseAttrs, productAttrsSchema } from '../../shared/catalog.js';
import { validatePacks } from '../../shared/uom.js';
import { Brand } from '../brand/brand.model.js';
import { Category } from '../category/category.model.js';

import { Product, toProductPayload } from './product.model.js';

import type {
  CreateProductInput,
  ListProductsQuery,
  UpdateProductInput,
} from './product.schema.js';
import type { ProductDoc } from './product.model.js';
import type { ProductAttrs } from '@shared/catalog.js';
import type { ProductType } from '@shared/enums.js';
import type { PageMeta, ProductPayload } from '@shared/types.js';
import type { FilterQuery } from 'mongoose';
import { User } from '../user/user.model.js';

const SORTABLE = ['sku', 'name', 'type', 'defaultSellPriceMinor', 'createdAt'] as const;
const SEARCHABLE = ['name', 'sku', 'barcode', 'description'] as const;

/**
 * Validate `attrs` against the union, for a product of `type`.
 *
 * The discriminant is injected here rather than demanded from the client: the API contract is
 * "a product has a type, and attributes appropriate to it", not "repeat the type inside the
 * attributes so a validator can narrow". Issue paths are prefixed with `attrs.` so the message
 * lands on the right input in the Day-6 form.
 */
export function parseAttrs(type: ProductType, raw: unknown): ProductAttrs {
  const candidate = normaliseAttrs({
    ...(raw && typeof raw === 'object' ? raw : {}),
    type,
  } as Record<string, unknown>);

  try {
    return productAttrsSchema.parse(candidate);
  } catch (err) {
    if (err instanceof ZodError) {
      const fields = err.issues.flatMap((issue) => {
        // `.strict()` reports every unknown key as one issue with an empty path, so the error
        // would land on the group rather than on the offending input. Split it back out, so a
        // frame sent with `serviceIntervalMonths` highlights that field.
        if (issue.code === 'unrecognized_keys') {
          return issue.keys.map((key) => ({
            path: `attrs.${key}`,
            message: 'Not a field of this product type',
          }));
        }

        return [
          {
            // Drop the injected discriminant from the path — the client never sent it, so an
            // error pointing at `attrs.type` would name a field that is not on the form.
            path: ['attrs', ...issue.path.filter((p) => p !== 'type')].join('.'),
            message: issue.message,
          },
        ];
      });

      throw ApiError.validation('Validation failed', fields);
    }
    throw err;
  }
}

/**
 * The axes a product may vary along, checked against its type.
 *
 * In the service rather than in zod because `type` is optional on an update: a body that
 * changed `variantAxes` while omitting `type` would skip a schema-level check entirely, which
 * is the quiet kind of gap that only shows up as a nonsense variant months later. Here the
 * stored type is always available.
 */
function assertVariantAxes(
  type: ProductType,
  hasVariants: boolean,
  variantAxes: readonly string[],
): void {
  if (!hasVariants || variantAxes.length === 0) return;

  const allowed: readonly string[] = AXES_BY_TYPE[type];
  const fields = variantAxes
    .map((axis, index) => ({ axis, index }))
    .filter(({ axis }) => !allowed.includes(axis))
    .map(({ axis, index }) => ({
      path: `variantAxes.${index}`,
      message:
        allowed.length === 0
          ? `A ${type.toLowerCase()} does not have variants`
          : `A ${type.toLowerCase()} varies by ${allowed.join(' or ')}, not ${axis}`,
    }));

  if (fields.length > 0) throw ApiError.validation('Validation failed', fields);
}

/**
 * Rules that need the database, and cannot live in zod.
 *
 * Referenced brand and category must exist in *this* org — otherwise a typo'd id produces a
 * product whose brand column is permanently blank, with nothing to explain why.
 */
async function assertReferencesExist(
  orgId: Types.ObjectId,
  type: ProductType,
  brandId: string | null | undefined,
  categoryId: string | null | undefined,
): Promise<void> {
  if (brandId) {
    const exists = await Brand.exists({ orgId, _id: new Types.ObjectId(brandId) });
    if (!exists) {
      throw ApiError.validation('Validation failed', [
        { path: 'brandId', message: 'That brand does not exist' },
      ]);
    }
  }

  if (categoryId) {
    const category = await Category.findOne({ orgId, _id: new Types.ObjectId(categoryId) })
      .select('name productType')
      .lean();

    if (!category) {
      throw ApiError.validation('Validation failed', [
        { path: 'categoryId', message: 'That category does not exist' },
      ]);
    }

    // A category may be pinned to one product type. Putting a lens in a frames category is the
    // kind of thing nobody notices until a report is wrong.
    if (category.productType && category.productType !== type) {
      throw ApiError.validation('Validation failed', [
        {
          path: 'categoryId',
          message: `"${category.name}" only holds ${category.productType} products`,
        },
      ]);
    }
  }
}

/** Turn the unique index into a 422 on the offending field, not an opaque duplicate-key 409. */
async function assertSkuFree(
  orgId: Types.ObjectId,
  sku: string | undefined,
  exceptId?: Types.ObjectId,
): Promise<void> {
  if (!sku) return;

  const clash = await Product.findOne({
    orgId,
    sku,
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  })
    .select('name')
    .lean();

  if (clash) {
    throw ApiError.validation('Validation failed', [
      { path: 'sku', message: `Already used by "${clash.name}"` },
    ]);
  }
}

/**
 * Pack rules, from the shared validator.
 *
 * The same three checks the form applies, run here as well — a CSV import or a direct API call
 * reaches this path without going anywhere near the form.
 */
function assertPacksValid(
  baseUom: string,
  packs: { code: string; name: string; factor: number }[] | undefined,
): void {
  if (!packs || packs.length === 0) return;

  const problems = validatePacks(baseUom, packs);
  if (problems.length > 0) {
    throw ApiError.validation(
      'Validation failed',
      problems.map((p) => ({ path: `packs.${p.index}.${p.field}`, message: p.message })),
    );
  }
}

/**
 * Expiry cannot be tracked on a product that does not record batches.
 *
 * Enforced rather than silently corrected: a solution marked `requiresExpiry` but received
 * without lots has no expiry date to report on, and the Day-16 expiry report would simply show
 * nothing — a wrong answer that looks like a right one.
 */
function resolveTrackingMode(
  type: ProductType,
  attrs: ProductAttrs,
  requested: string | undefined,
  current?: string,
): string {
  // Machines default to serial tracking, because that is how a warranty is honoured — but it
  // stays a default, not a rule: a cheap consumable machine may not be worth serialising.
  const fallback = current ?? (type === 'MACHINE' ? 'SERIAL' : 'NONE');
  const mode = requested ?? fallback;

  if (attrs.type === 'ACCESSORY' && attrs.requiresExpiry && mode !== 'LOT') {
    throw ApiError.validation('Validation failed', [
      {
        path: 'trackingMode',
        message: 'A product that expires must be lot-tracked, so a batch can carry the date',
      },
    ]);
  }

  return mode;
}

/** Brand and category names for a page of products, in two queries rather than 2N. */
async function denormalise(
  orgId: Types.ObjectId,
  items: ProductDoc[],
): Promise<{ brands: Map<string, string>; categories: Map<string, string> }> {
  const brandIds = [
    ...new Set(items.map((p) => p.brandId).filter(Boolean)),
  ] as Types.ObjectId[];
  const categoryIds = [
    ...new Set(items.map((p) => p.categoryId).filter(Boolean)),
  ] as Types.ObjectId[];

  const [brands, categories] = await Promise.all([
    brandIds.length
      ? Brand.find({ orgId, _id: { $in: brandIds } })
          .select('name')
          .lean()
      : [],
    categoryIds.length
      ? Category.find({ orgId, _id: { $in: categoryIds } })
          .select('name')
          .lean()
      : [],
  ]);

  return {
    brands: new Map(brands.map((b) => [String(b._id), b.name])),
    categories: new Map(categories.map((c) => [String(c._id), c.name])),
  };
}

export async function listProducts(
  orgId: Types.ObjectId,
  query: ListProductsQuery,
  includeCost: boolean,
): Promise<{ items: ProductPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<ProductDoc> = { orgId };

  if (query.type) filter.type = query.type;
  if (query.brandId) filter.brandId = new Types.ObjectId(query.brandId);
  if (query.categoryId) filter.categoryId = new Types.ObjectId(query.categoryId);
  if (query.trackingMode) filter.trackingMode = query.trackingMode;
  if (query.hasVariants !== undefined) filter.hasVariants = query.hasVariants;
  if (query.isActive !== undefined) filter.isActive = query.isActive;

  // "Everything under Frames" — the subtree is resolved to a concrete id list through the
  // materialised `path`, so the product query stays a plain indexed `$in`.
  if (query.categoryUnder) {
    const root = new Types.ObjectId(query.categoryUnder);
    const descendants = await Category.find({ orgId, path: root }).select('_id').lean();
    filter.categoryId = { $in: [root, ...descendants.map((c) => c._id)] };
  }

  const { items, meta } = await paginate<ProductDoc>(Product, {
    filter,
    query,
    sortable: SORTABLE,
    searchFields: SEARCHABLE,
    defaultSort: { name: 1 },
    // Belt and braces with the serializer: the aggregation bypasses any schema-level `select`,
    // so a caller without `stock:viewCost` must not have the figure leave the database either.
    exclude: includeCost ? [] : ['standardCostMinor', 'avgCostMinor'],
  });

  const { brands, categories } = await denormalise(orgId, items);

  return {
    items: items.map((p) =>
      toProductPayload(p, {
        includeCost,
        brandName: p.brandId ? (brands.get(String(p.brandId)) ?? null) : null,
        categoryName: p.categoryId ? (categories.get(String(p.categoryId)) ?? null) : null,
      }),
    ),
    meta,
  };
}

export async function getProduct(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  includeCost: boolean,
): Promise<ProductPayload> {
  const product = await Product.findOne({ _id: id, orgId }).lean();
  if (!product) throw ApiError.notFound('Product');

  const { brands, categories } = await denormalise(orgId, [product]);

  return toProductPayload(product, {
    includeCost,
    brandName: product.brandId ? (brands.get(String(product.brandId)) ?? null) : null,
    categoryName: product.categoryId
      ? (categories.get(String(product.categoryId)) ?? null)
      : null,
  });
}

export async function createProduct(
  orgId: Types.ObjectId,
  input: CreateProductInput,
  actorId: Types.ObjectId,
  includeCost: boolean,
): Promise<ProductPayload> {
  const attrs = parseAttrs(input.type, input.attrs);

  if (input.isActive !== false) await assertWithinLimit(orgId, 'products');
  assertVariantAxes(input.type, input.hasVariants ?? false, input.variantAxes ?? []);
  assertPacksValid(input.baseUom, input.packs);
  await assertReferencesExist(orgId, input.type, input.brandId, input.categoryId);
  await assertSkuFree(orgId, input.sku);
  await assertProductBarcodesFree(orgId, { barcode: input.barcode, packs: input.packs });

  const trackingMode = resolveTrackingMode(input.type, attrs, input.trackingMode);

  const product = await Product.create({
    ...input,
    attrs,
    trackingMode,
    brandId: input.brandId ? new Types.ObjectId(input.brandId) : null,
    categoryId: input.categoryId ? new Types.ObjectId(input.categoryId) : null,
    orgId,
    createdBy: actorId,
    updatedBy: actorId,
  });

  return getProduct(orgId, product._id, includeCost);
}

export async function updateProduct(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  input: UpdateProductInput,
  actorId: Types.ObjectId,
  includeCost: boolean,
): Promise<ProductPayload> {
  const current = await Product.findOne({ _id: id, orgId }).lean();
  if (!current) throw ApiError.notFound('Product');
  // Switching a product back on takes a place in the plan, as creating one does.
  if (input.isActive === true && !current.isActive) await assertWithinLimit(orgId, 'products');

  // Accepted so a form can PATCH the whole document back, but only as the value it already
  // has — see the note on `updateProductSchema`.
  if (input.type !== undefined && input.type !== current.type) {
    throw ApiError.validation('Validation failed', [
      {
        path: 'type',
        message: `A product's type cannot be changed. Deactivate this one and create a ${input.type.toLowerCase()}.`,
      },
    ]);
  }

  // The stored type governs both the attrs union and the axis check.
  const attrs =
    input.attrs === undefined ? current.attrs : parseAttrs(current.type, input.attrs);

  assertVariantAxes(
    current.type,
    input.hasVariants ?? current.hasVariants,
    input.variantAxes ?? current.variantAxes,
  );
  assertPacksValid(input.baseUom ?? current.baseUom, input.packs);
  await assertReferencesExist(orgId, current.type, input.brandId, input.categoryId);
  await assertSkuFree(orgId, input.sku, id);
  await assertProductBarcodesFree(
    orgId,
    {
      barcode: input.barcode === undefined ? current.barcode : input.barcode,
      // Packs are replaced wholesale when given; otherwise the stored ones still hold theirs.
      packs: input.packs ?? current.packs,
    },
    id,
  );

  const trackingMode = resolveTrackingMode(
    current.type,
    attrs,
    input.trackingMode,
    current.trackingMode,
  );

  const update: Record<string, unknown> = {
    ...input,
    attrs,
    trackingMode,
    updatedBy: actorId,
  };
  if (input.brandId !== undefined) {
    update.brandId = input.brandId ? new Types.ObjectId(input.brandId) : null;
  }
  if (input.categoryId !== undefined) {
    update.categoryId = input.categoryId ? new Types.ObjectId(input.categoryId) : null;
  }

  const updated = await Product.findOneAndUpdate(
    { _id: id, orgId },
    { $set: update },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw ApiError.notFound('Product');

  return getProduct(orgId, id, includeCost);
}

/**
 * Deactivation, not deletion — the same rule as locations and users.
 *
 * Once a product has been sold its id is on invoice lines, stock ledger rows and price list
 * entries forever. Removing the document would leave every one of them pointing at nothing, and
 * "what did we sell last March" would come back with blanks. Deactivating takes it out of the
 * pickers and leaves the history legible.
 */
export async function deactivateProduct(
  orgId: Types.ObjectId,
  id: Types.ObjectId,
  actorId: Types.ObjectId,
  includeCost: boolean,
): Promise<ProductPayload> {
  const product = await Product.findOneAndUpdate(
    { _id: id, orgId },
    { $set: { isActive: false, updatedBy: actorId } },
    { new: true },
  ).lean();

  if (!product) throw ApiError.notFound('Product');

  return getProduct(orgId, id, includeCost);
}

export async function generateBarcodeForOrg(orgId: string, userId: string): Promise<string> {
  // 1. Get all users under this organization sorted by creation date (ascending)
  const orgUsers = await User.find({ orgId }).sort({ createdAt: 1 }).select('_id');

  // Find the 1-based index of the current user who is creating the product
  const userIndex = orgUsers.findIndex((user) => user._id.toString() === userId.toString());

  if (userIndex === -1) {
    throw new Error('User not found in organization context');
  }

  // Format User Serial to 3 digits (e.g., user index 0 -> "001")
  const userSerial = String(userIndex + 1).padStart(3, '0');

  // 2. Get current Year and Month (YYMM -> 4 digits)
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yymm = `${yy}${mm}`;

  // 3. Get the latest product sequence for this organization
  const lastProduct = await Product.findOne({ orgId }).sort({ createdAt: -1 });

  let nextSequenceNumber = 1;
  if (lastProduct && lastProduct.barcode) {
    // Barcode structure: YYMM (4) + UserSerial (3) + Sequence (6) = 13 chars
    // Extract the last 6 digits representing the sequence
    const lastSequenceStr = lastProduct.barcode.slice(-6);
    const parsedSeq = parseInt(lastSequenceStr, 10);

    if (!isNaN(parsedSeq)) {
      nextSequenceNumber = parsedSeq + 1;
    }
  }

  // Format Sequence to 6 digits (e.g., 1 becomes "000001")
  const sequence = String(nextSequenceNumber).padStart(6, '0');

  // 4. Assemble the final 13-digit numeric barcode
  const barcode = `${yymm}${userSerial}${sequence}`;

  return barcode;
}
