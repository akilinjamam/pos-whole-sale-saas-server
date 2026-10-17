import { Schema, model } from 'mongoose';

import { auditableFields, baseSchemaPlugin } from '../../lib/model.js';

import type { BrandPayload } from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A manufacturer or house label.
 *
 * Deliberately thin — a brand is a label products hang off, not a party. The importer you buy
 * Ray-Ban *from* is a `Party` with the SUPPLIER role; this is the name printed on the temple.
 * Conflating the two is why the retail system cannot answer "what did we sell of this brand"
 * without deduplicating three spellings of the same supplier.
 */
export interface BrandDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  /** URL-safe form of the name, unique per org. Derived once, then stable. */
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const brandSchema = new Schema<BrandDoc>({
  ...auditableFields,
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true },
  logoUrl: { type: String, trim: true, default: null },
  isActive: { type: Boolean, default: true },
});

brandSchema.plugin(baseSchemaPlugin);

// Slug rather than name: it is the normalised form, so "Ray Ban" and "Ray-Ban" collide here
// instead of becoming two brands that split every report between them.
brandSchema.index({ orgId: 1, slug: 1 }, { unique: true });

export type BrandDocument = HydratedDocument<BrandDoc>;
export type BrandModel = Model<BrandDoc>;

export const Brand: BrandModel = model<BrandDoc>('Brand', brandSchema);

export function toBrandPayload(doc: BrandDoc, productCount?: number): BrandPayload {
  return {
    id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    logoUrl: doc.logoUrl,
    isActive: doc.isActive,
    ...(productCount === undefined ? {} : { productCount }),
  };
}

/**
 * "Ray-Ban Aviator" → "ray-ban-aviator".
 *
 * Also used by the category module, and later by anything else that needs a stable natural key
 * from a display name.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
