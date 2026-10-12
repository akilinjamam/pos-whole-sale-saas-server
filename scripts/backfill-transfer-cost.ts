/**
 * One-off: give balance rows created by a transfer the item's average cost.
 *
 * Before transfers carried cost, a location receiving an item for the first time got a new
 * balance row at the schema default `avgCostMinor: 0`, so Stock on hand showed no cost there and
 * the stock valuation undercounted it. The item has one moving average everywhere (Day 33); this
 * copies it — from the product, or the variant — onto every row still at 0. Ledger rows are not
 * touched: they are append-only.
 *
 * Dry run by default — lists what it would change:
 *
 *   npx tsx scripts/backfill-transfer-cost.ts
 *   npx tsx scripts/backfill-transfer-cost.ts --apply
 */
import { connectDatabase, disconnectDatabase } from '../src/config/db.js';
import { Product } from '../src/modules/product/product.model.js';
import { StockBalance } from '../src/modules/stock/stockBalance.model.js';
import { Variant } from '../src/modules/variant/variant.model.js';

const apply = process.argv.includes('--apply');

await connectDatabase();
const rows = await StockBalance.find({ avgCostMinor: 0 })
  .select('orgId locationId productId variantId qtyOnHand')
  .lean();

let changed = 0;
let skipped = 0;
for (const r of rows) {
  const item = r.variantId
    ? await Variant.findById(r.variantId).select('avgCostMinor').lean()
    : await Product.findById(r.productId).select('sku avgCostMinor').lean();
  const avg = item?.avgCostMinor ?? 0;
  // An item never costed has no average to copy: leave it at 0.
  if (!avg) {
    skipped += 1;
    continue;
  }
  console.log(
    `${apply ? 'set' : 'would set'}  balance ${String(r._id)}  ` +
      `(location ${String(r.locationId)}, product ${String(r.productId)}` +
      `${r.variantId ? `, variant ${String(r.variantId)}` : ''}, on hand ${r.qtyOnHand})  ` +
      `avgCostMinor 0 → ${avg}`,
  );
  if (apply) {
    // Still at 0 at write time — never overwrite a cost something else has set meanwhile.
    await StockBalance.updateOne({ _id: r._id, avgCostMinor: 0 }, { $set: { avgCostMinor: avg } });
  }
  changed += 1;
}

console.log(
  `\n${rows.length} row(s) at cost 0; ${changed} ${apply ? 'updated' : 'to update'}, ` +
    `${skipped} left (item has no cost yet).${apply ? '' : '  Re-run with --apply to write.'}`,
);
await disconnectDatabase();
