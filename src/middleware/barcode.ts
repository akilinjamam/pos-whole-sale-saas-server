/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response, NextFunction } from 'express';

import * as productService from '../modules/product/product.service.js';

export const attachAutoBarcode = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { orgId, id } = (req as any).user;

    // Call your service logic
    const barcode = await productService.generateBarcodeForOrg(orgId, id);

    // Inject into request body and context
    req.body.barcode = barcode;

    next();
  } catch (error) {
    next(error);
  }
};
