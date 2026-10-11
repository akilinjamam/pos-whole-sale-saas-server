import { ApiError } from '../../lib/ApiError.js';
import { peekDocNo, seriesConfig } from '../../lib/numbering.js';
import { withTransaction } from '../../lib/withTransaction.js';
import { writeAudit } from '../../services/audit.service.js';
import { diff } from '../org/org.service.js';
import { DOC_SERIES } from '../../shared/enums.js';
import { LOCKED_SERIES } from '../../shared/numbering.js';

import { NumberSeries } from './numberSeries.model.js';

import type { UpdateSeriesInput } from './numberSeries.schema.js';
import type { RequestActor } from '../../lib/requestUser.js';
import type { DocSeries } from '@shared/enums.js';
import type { NumberSeriesPayload } from '@shared/types.js';
import type { Types } from 'mongoose';

async function describe(
  orgId: Types.ObjectId,
  series: DocSeries,
  configured: boolean,
): Promise<NumberSeriesPayload> {
  const cfg = await seriesConfig(orgId, series);
  return {
    series,
    ...cfg,
    configured,
    locked: LOCKED_SERIES.includes(series),
    nextNumber: await peekDocNo(orgId, series, new Date()),
  };
}

/** Every series, configured or not — the settings screen lists them all. */
export async function listSeries(orgId: Types.ObjectId): Promise<NumberSeriesPayload[]> {
  const rows = await NumberSeries.find({ orgId }).select('series').lean();
  const configured = new Set(rows.map((r) => r.series));
  return Promise.all(DOC_SERIES.map((s) => describe(orgId, s, configured.has(s))));
}

/**
 * Change how a series is numbered from the next post on. Numbers already issued are untouched —
 * see the note on `NumberSeries` for why an edit can never collide with them.
 */
export async function updateSeries(
  actor: RequestActor,
  series: DocSeries,
  input: UpdateSeriesInput,
): Promise<NumberSeriesPayload> {
  const { orgId, actorId } = actor;
  if (LOCKED_SERIES.includes(series)) {
    throw ApiError.validation('Validation failed', [
      {
        path: 'series',
        message:
          'Party codes are fixed at P-00001… — the manual-code rule depends on that shape',
      },
    ]);
  }
  const current = await seriesConfig(orgId, series);
  await withTransaction(async (session) => {
    await NumberSeries.updateOne(
      { orgId, series },
      {
        $set: { ...current, ...input, updatedBy: actorId },
        $setOnInsert: { orgId, series, createdBy: actorId },
      },
      { upsert: true, session },
    );
    // Renumbering is a legal matter — the next invoice's number changes shape — so it is audited.
    const changed = diff(current as unknown as Record<string, unknown>, input);
    if (changed) {
      await writeAudit(session, actor, {
        action: 'NUMBER_SERIES_CHANGE',
        entity: 'NumberSeries',
        entityId: null,
        docNo: series,
        ...changed,
      });
    }
  });
  return describe(orgId, series, true);
}
