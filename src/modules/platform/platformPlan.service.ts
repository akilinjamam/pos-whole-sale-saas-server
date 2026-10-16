import { ApiError } from '../../lib/ApiError.js';
import { invalidatePlans } from '../../services/subscription.service.js';
import { Org } from '../org/org.model.js';
import { Plan, toPlanPayload } from '../plan/plan.model.js';

import { writePlatformAudit } from './platformAudit.js';

import type { PlatformActor } from './platformAudit.js';
import type { CreatePlanInput, UpdatePlanInput } from './platform.schema.js';
import type { PlanDoc } from '../plan/plan.model.js';
import type { PlatformPlanPayload } from '@shared/platform.js';

/**
 * Editing the price list — SaaS phase 5. A plan is never deleted (businesses point at it by code);
 * it is switched off, which stops it being offered while those already on it keep it. Every change
 * empties the plan and access caches, so new limits apply on the next request.
 */

async function withCounts(plans: PlanDoc[]): Promise<PlatformPlanPayload[]> {
  const counts = await Org.aggregate<{ _id: string; n: number }>([
    { $match: { planCode: { $in: plans.map((p) => p.code) } } },
    { $group: { _id: '$planCode', n: { $sum: 1 } } },
  ]);
  const n = new Map(counts.map((c) => [c._id, c.n]));
  return plans.map((p) => ({
    ...toPlanPayload(p),
    isActive: p.isActive,
    sortOrder: p.sortOrder,
    tenants: n.get(p.code) ?? 0,
  }));
}

export async function listPlans(): Promise<PlatformPlanPayload[]> {
  return withCounts(await Plan.find().sort({ sortOrder: 1, code: 1 }).lean());
}

export async function createPlan(
  actor: PlatformActor,
  input: CreatePlanInput,
): Promise<PlatformPlanPayload> {
  if (await Plan.exists({ code: input.code })) {
    throw ApiError.conflict(
      'DUPLICATE_DOCUMENT',
      `A plan with code ${input.code} already exists`,
      {
        field: 'code',
      },
    );
  }
  const plan = await Plan.create({ ...input, description: input.description ?? null });
  invalidatePlans();
  await writePlatformAudit(actor, 'PLAN_CREATE', null, { code: plan.code, plan: input });
  return (await withCounts([plan.toObject()]))[0]!;
}

export async function updatePlan(
  actor: PlatformActor,
  code: string,
  input: UpdatePlanInput,
): Promise<PlatformPlanPayload> {
  const before = await Plan.findOne({ code }).lean();
  if (!before) throw ApiError.notFound('Plan');
  const plan = await Plan.findOneAndUpdate(
    { code },
    { $set: input },
    { new: true, runValidators: true },
  ).lean();
  invalidatePlans();
  await writePlatformAudit(actor, 'PLAN_UPDATE', null, {
    code,
    before: Object.fromEntries(Object.keys(input).map((k) => [k, before[k as keyof PlanDoc]])),
    after: input,
  });
  return (await withCounts([plan!]))[0]!;
}
