import { ApiError } from '../../lib/ApiError.js';
import { Tutorial, toTutorialPayload } from '../tutorial/tutorial.model.js';

import { writePlatformAudit } from './platformAudit.js';

import type { PlatformActor } from './platformAudit.js';
import type { CreateTutorialInput, UpdateTutorialInput } from './platform.schema.js';
import type { TutorialDoc } from '../tutorial/tutorial.model.js';
import type { TutorialPayload } from '@shared/tutorials.js';
import type { Types } from 'mongoose';

/** Training videos, as the platform admin manages them (`platform:content`). Every change audited. */

export async function listTutorials(): Promise<TutorialPayload[]> {
  const docs = await Tutorial.find().sort({ topic: 1, sortOrder: 1, createdAt: 1 }).lean();
  return docs.map(toTutorialPayload);
}

export async function createTutorial(
  actor: PlatformActor,
  input: CreateTutorialInput,
): Promise<TutorialPayload> {
  const doc = await Tutorial.create(input);
  await writePlatformAudit(actor, 'TUTORIAL_CREATE', null, {
    id: String(doc._id),
    topic: doc.topic,
    titleEn: doc.titleEn,
    youtubeId: doc.youtubeId,
  });
  return toTutorialPayload(doc.toObject());
}

export async function updateTutorial(
  actor: PlatformActor,
  id: Types.ObjectId,
  input: UpdateTutorialInput,
): Promise<TutorialPayload> {
  const before = await Tutorial.findById(id).lean();
  if (!before) throw ApiError.notFound('Tutorial');
  const after = await Tutorial.findByIdAndUpdate(
    id,
    { $set: input },
    { new: true, runValidators: true },
  ).lean();
  await writePlatformAudit(actor, 'TUTORIAL_UPDATE', null, {
    id: String(id),
    before: Object.fromEntries(Object.keys(input).map((k) => [k, before[k as keyof TutorialDoc]])),
    after: input,
  });
  return toTutorialPayload(after!);
}

export async function deleteTutorial(actor: PlatformActor, id: Types.ObjectId): Promise<void> {
  const doc = await Tutorial.findByIdAndDelete(id).lean();
  if (!doc) throw ApiError.notFound('Tutorial');
  await writePlatformAudit(actor, 'TUTORIAL_DELETE', null, {
    id: String(id),
    topic: doc.topic,
    titleEn: doc.titleEn,
    youtubeId: doc.youtubeId,
  });
}
