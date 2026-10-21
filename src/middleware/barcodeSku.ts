/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response, NextFunction } from 'express';

import * as productService from '../modules/product/product.service.js';

export const attachAutoBarcodeSku = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, id } = (req as any).user;

    // Call your service logic
    const { barcode, skuCode } = await productService.generateBarcodeForOrg(
      orgId,
      id,
      req.body.type,
    );

    // Inject into request body and context
    req.body.barcode = barcode;
    req.body.sku = skuCode;

    next();
  } catch (error) {
    next(error);
  }
};
