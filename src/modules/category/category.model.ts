import { Schema, model } from 'mongoose';

import { PRODUCT_TYPES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { CategoryPayload } from '@shared/types.js';
import type { ProductType } from '@shared/enums.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A node in the catalogue tree.
 *
 * Stored as **parent pointer plus materialised path** — `parentId` for the edge, `path[]` for
 * every ancestor from the root down, excluding self.
 *
 * The redundancy buys the two queries this tree actually gets asked for:
 *
 *  - *"everything under Frames"* is `{ path: framesId }` — one indexed lookup, at any depth.
 *    With `parentId` alone it is a recursive walk, one round trip per level, or a `$graphLookup`
 *    on every product list.
 *  - *"where does this sit"* is `path` itself; the breadcrumb needs no traversal.
 *
 * The cost is that `path` must be rewritten for every descendant when a node is reparented.
 * That happens in a transaction in the service — a half-rewritten tree is far worse than a slow
 * one, because nothing errors and the products simply stop appearing under their parent.
 */
export interface CategoryDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  parentId: Types.ObjectId | null;
  /** Ancestors, root first, excluding self. Depth is `path.length`. */
  path: Types.ObjectId[];
  /** Restricts this branch to one product type, or null for any. */
  productType: ProductType | null;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDoc>({
  ...auditableFields,
  name: { type: String, required: true, trim: true },
  parentId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
  path: { type: [{ type: Schema.Types.ObjectId, ref: 'Category' }], default: [] },
  productType: { type: String, enum: [...PRODUCT_TYPES, null], default: null },
  isActive: { type: Boolean, default: true },
});

categorySchema.plugin(baseSchemaPlugin);

// Siblings cannot share a name — two "Men" under the same parent are indistinguishable in every
// picker. `parentId: null` participates normally, so the constraint covers roots too.
categorySchema.index({ orgId: 1, parentId: 1, name: 1 }, { unique: true });

// The subtree query. Multikey over `path`, so `{ path: id }` matches at any depth.
categorySchema.index({ orgId: 1, path: 1 });

export type CategoryDocument = HydratedDocument<CategoryDoc>;
export type CategoryModel = Model<CategoryDoc>;

export const Category: CategoryModel = model<CategoryDoc>('Category', categorySchema);

export interface CategoryCounts {
  childCount?: number;
  productCount?: number;
}

/**
 * `breadcrumb` is resolved by the caller, which holds the name lookup for the whole page —
 * resolving it here would mean a query per row.
 */
export function toCategoryPayload(
  doc: CategoryDoc,
  breadcrumb: string[],
  counts: CategoryCounts = {},
): CategoryPayload {
  return {
    id: String(doc._id),
    name: doc.name,
    parentId: doc.parentId ? String(doc.parentId) : null,
    path: doc.path.map((id) => String(id)),
    breadcrumb,
    productType: doc.productType,
    isActive: doc.isActive,
    ...(counts.childCount === undefined ? {} : { childCount: counts.childCount }),
    ...(counts.productCount === undefined ? {} : { productCount: counts.productCount }),
  };
}
