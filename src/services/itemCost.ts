import { Product } from '../modules/product/product.model.js';
import { StockBalance } from '../modules/stock/stockBalance.model.js';
import { Variant } from '../modules/variant/variant.model.js';

import type { ClientSession, Types } from 'mongoose';

/**
 * The item's moving average (Day 33) — one figure for every location, mirrored onto the variant
 * (or the product, for an item without variants). 0 until the item has been costed.
 */
export async function itemAverageCost(
  session: ClientSession,
  productId: Types.ObjectId,
  variantId: Types.ObjectId | null,
): Promise<number> {
  const doc = variantId
    ? await Variant.findById(variantId).select('avgCostMinor').session(session).lean()
    : await Product.findById(productId).select('avgCostMinor').session(session).lean();
  return doc?.avgCostMinor ?? 0;
}

/**
 * A location that has never held the item starts its balance row at cost 0. The item has one
 * moving average everywhere (Day 33), so the new row is given it. Call after `postMovements`,
 * in the same session, whenever stock can arrive at a location that may not have held it.
 */
export async function carryAverageCost(
  session: ClientSession,
  orgId: Types.ObjectId,
  items: { productId: Types.ObjectId; variantId: Types.ObjectId | null }[],
): Promise<void> {
  for (const it of items) {
    const avg = await itemAverageCost(session, it.productId, it.variantId ?? null);
    if (!avg) continue;
    await StockBalance.updateMany(
      { orgId, productId: it.productId, variantId: it.variantId ?? null, avgCostMinor: 0 },
      { $set: { avgCostMinor: avg } },
      { session },
    );
  }
}
