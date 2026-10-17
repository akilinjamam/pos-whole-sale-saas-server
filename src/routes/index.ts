import type { PlanFeature } from '@shared/enums.js';
import type { Router } from 'express';

import auditRouter from '../modules/audit/audit.route.js';
import authRouter from '../modules/auth/auth.route.js';
import barcodeRouter from '../modules/barcode/barcode.route.js';
import brandRouter from '../modules/brand/brand.route.js';
import categoryRouter from '../modules/category/category.route.js';
import dispatchRouter from '../modules/dispatch/dispatch.route.js';
import goodsReceiptRouter from '../modules/goodsReceipt/goodsReceipt.route.js';
import purchaseReturnRouter from '../modules/purchaseReturn/purchaseReturn.route.js';
import reportsRouter from '../modules/reports/reports.route.js';
import dashboardRouter from '../modules/dashboard/dashboard.route.js';
import notificationsRouter from '../modules/notifications/notifications.route.js';
import {
  creditNoteRouter,
  salesReturnRouter,
} from '../modules/salesReturn/salesReturn.route.js';
import healthRouter from '../modules/health/health.route.js';
import invoiceRouter from '../modules/invoice/invoice.route.js';
import ledgerRouter from '../modules/ledger/ledger.route.js';
import lotRouter from '../modules/lot/lot.route.js';
import numberSeriesRouter from '../modules/numberSeries/numberSeries.route.js';
import locationRouter from '../modules/location/location.route.js';
import orgRouter from '../modules/org/org.route.js';
import platformRouter from '../modules/platform/platform.route.js';
import publicRouter from '../modules/public/public.route.js';
import tutorialRouter from '../modules/tutorial/tutorial.route.js';
import paymentRouter from '../modules/payment/payment.route.js';
import posRouter from '../modules/pos/pos.route.js';
import { customerRouter, dealerRouter, supplierRouter } from '../modules/party/party.route.js';
import priceListRouter from '../modules/priceList/priceList.route.js';
import priceTierRouter from '../modules/priceTier/priceTier.route.js';
import pricingRouter from '../modules/pricing/pricing.route.js';
import productRouter from '../modules/product/product.route.js';
import roleRouter from '../modules/role/role.route.js';
import serialRouter from '../modules/serialUnit/serialUnit.route.js';
import stockRouter from '../modules/stock/stock.route.js';
import supplierPoRouter from '../modules/supplierPo/supplierPo.route.js';
import stockAdjustmentRouter from '../modules/stockAdjustment/stockAdjustment.route.js';
import stockCountRouter from '../modules/stockCount/stockCount.route.js';
import stockTransferRouter from '../modules/stockTransfer/stockTransfer.route.js';
import userRouter from '../modules/user/user.route.js';
import variantRouter from '../modules/variant/variant.route.js';
import wholesaleOrderRouter from '../modules/wholesaleOrder/wholesaleOrder.route.js';

/**
 * The route table. Every module's router is mounted at `/api/v1/<path>` from this array —
 * a module that is not listed here is unreachable.
 *
 * `public: true` exempts a router from the blanket `authenticate` guard in app.ts. Keep that
 * list minimal and obvious; from Day 3 a test walks this table and fails the build if any
 * non-public route lacks both `authenticate` and `requirePermission`.
 */
export interface RouteEntry {
  path: string;
  route: Router;
  public?: boolean;
  /** The plan feature this whole module needs (SaaS phase 4); see `middleware/requireFeature.ts`. */
  feature?: PlanFeature;
}

export const allRoutes: RouteEntry[] = [
  { path: 'health', route: healthRouter, public: true },

  // Exempt from the *blanket* guard because `login` and `refresh` must be reachable without a
  // token — obtaining one is their purpose. The routes inside that do need a caller (`me`,
  // `logout`, `password`) carry `authenticate` themselves.
  { path: 'auth', route: authRouter, public: true },

  // The platform-admin API (SaaS phase 5). `public` only exempts it from the *tenant* blanket guard
  // — a platform token is not a tenant token. Every route in it carries `authenticatePlatform`.
  { path: 'platform', route: platformRouter, public: true },
  // The signed-out website's plans, numbers and contact details (SaaS phase 8).
  { path: 'public', route: publicRouter, public: true },

  { path: 'org', route: orgRouter },
  { path: 'locations', route: locationRouter },
  { path: 'roles', route: roleRouter },
  { path: 'users', route: userRouter },

  // Catalog (Day 5). Reads are gated on `product:read`; brands and categories are written
  // under their own `*:manage` grants — see each router for why.
  { path: 'brands', route: brandRouter },
  { path: 'categories', route: categoryRouter },
  { path: 'products', route: productRouter },
  { path: 'variants', route: variantRouter },
  { path: 'barcodes', route: barcodeRouter },

  // Parties (Day 9): one collection, mounted once per role so each is gated on its own noun —
  // see party.route.ts for why there is no single `/parties` router.
  { path: 'dealers', route: dealerRouter },
  { path: 'customers', route: customerRouter },
  { path: 'suppliers', route: supplierRouter },

  // Pricing (Day 11). Tiers on `priceTier:manage`; entries on `price:*`.
  { path: 'price-tiers', route: priceTierRouter },
  { path: 'price-lists', route: priceListRouter },

  // The pricing engine (Day 12): resolution only — the rules live in `domain/pricing.ts`.
  { path: 'pricing', route: pricingRouter },

  // Inventory (Day 13). Reads, and the opening import — stock is only ever written by posting
  // a document through `services/stock.service.ts`.
  { path: 'stock', route: stockRouter },

  // Stock documents (Day 14): draft → post; posting is the only way they move stock.
  { path: 'stock-adjustments', route: stockAdjustmentRouter },
  { path: 'stock-transfers', route: stockTransferRouter },
  { path: 'stock-counts', route: stockCountRouter },

  // Lots, serials, warranty (Day 15) — read-only registers; units and lots move only with stock.
  { path: 'lots', route: lotRouter },
  { path: 'serials', route: serialRouter },

  // Document numbering (Day 17). Invoices and payments are posted by their own modules from Day 18.
  { path: 'number-series', route: numberSeriesRouter },

  // The counter (Day 18): sessions, sales, held sales. A sale is an Invoice + receipts + stock
  // movements (+ ledger on credit), written by one endpoint in one transaction.
  { path: 'pos', route: posRouter, feature: 'POS' },

  // Wholesale orders (Day 21). Status moves only through `domain/orderStateMachine.ts`.
  { path: 'orders', route: wholesaleOrderRouter },

  // Dispatch (Day 24): pick → pack → post. Posting moves stock, the order and — with
  // `invoiceOnDispatch` — raises the challan's invoice and ledger debit, in one transaction.
  { path: 'dispatches', route: dispatchRouter },

  // Invoices (Day 25): read-only, for printing. Raised only by a counter sale or a posted challan.
  { path: 'invoices', route: invoiceRouter },

  // The party ledger (Day 27): opening balances at cutover, the entries, and reconcile. Entries are
  // written only by the documents that post them, through `partyLedger.service`.
  { path: 'ledger', route: ledgerRouter },

  // Receipts and allocation (Day 28): money in, set against invoices oldest-due-first or as
  // chosen; the rest held as an advance. One ledger credit per receipt.
  { path: 'payments', route: paymentRouter },

  // The audit log (Day 31): read-only. Credit overrides write to it; Day 39 adds the rest.
  { path: 'audit', route: auditRouter },

  // Purchase orders (Day 32). Status moves only through `domain/poStateMachine.ts`; receiving is
  // done by a posted goods receipt (Day 33), not here. The plan feature PURCHASING is purchase
  // orders and reorder suggestions only — receiving is in every plan (below).
  { path: 'purchase-orders', route: supplierPoRouter, feature: 'PURCHASING' },

  // Goods receipts (Day 33): posting brings stock in, re-costs it, moves the PO and credits the
  // supplier — in one transaction. In every plan: a wholesaler without goods receipts can only
  // bring stock in by adjustment, with no cost and no supplier bill — so stock value, margins and
  // supplier balances would all be wrong. A receipt needs no PO (`poId` is optional).
  { path: 'goods-receipts', route: goodsReceiptRouter },
  // Goods going back to the supplier (Day 34): stock out, cost, a debit note. Every plan, too.
  { path: 'purchase-returns', route: purchaseReturnRouter },
  // Goods back from dealers (Day 36), and the credit notes they raise.
  { path: 'sales-returns', route: salesReturnRouter },
  { path: 'credit-notes', route: creditNoteRouter },
  // The report suite (Day 37): read-only, scoped, cost-gated, each with its ties.
  { path: 'reports', route: reportsRouter, feature: 'REPORTS' },
  // The home dashboard (Day 38): summaries of the reports, by their own functions.
  { path: 'dashboard', route: dashboardRouter },
  // What needs attention now (Day 39): low stock, expiry, overdue, approvals — computed, not stored.
  // Training videos (phase 8): every signed-in user; the client filters by module.
  { path: 'tutorials', route: tutorialRouter },
  { path: 'notifications', route: notificationsRouter },
];

/** Paths that skip authentication, as full mount prefixes. */
export const publicPaths: string[] = allRoutes
  .filter((r) => r.public)
  .map((r) => `/api/v1/${r.path}`);
