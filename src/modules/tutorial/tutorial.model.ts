import { Schema, model } from 'mongoose';

import { TUTORIAL_TOPICS } from '../../shared/tutorials.js';

import type { TutorialPayload, TutorialTopic } from '@shared/tutorials.js';
import type { Model, Types } from 'mongoose';

/**
 * A training video. Platform-level: **no `orgId`** — the same videos for every business, written
 * by a platform admin (`platform:content`). Like `Plan`, one of the few collections that is not
 * tenant data, so export, purge and restore-org pass it by.
 */
export interface TutorialDoc {
  _id: Types.ObjectId;
  topic: TutorialTopic;
  titleBn: string;
  titleEn: string;
  descriptionBn: string | null;
  descriptionEn: string | null;
  youtubeId: string;
  sortOrder: number;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const tutorialSchema = new Schema<TutorialDoc>(
  {
    topic: { type: String, enum: TUTORIAL_TOPICS, required: true },
    titleBn: { type: String, required: true, trim: true },
    titleEn: { type: String, required: true, trim: true },
    descriptionBn: { type: String, trim: true, default: null },
    descriptionEn: { type: String, trim: true, default: null },
    youtubeId: { type: String, required: true, match: /^[A-Za-z0-9_-]{11}$/ },
    sortOrder: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false, collection: 'tutorials' },
);

tutorialSchema.index({ topic: 1, sortOrder: 1 });

export const Tutorial: Model<TutorialDoc> = model<TutorialDoc>('Tutorial', tutorialSchema);

export function toTutorialPayload(doc: TutorialDoc): TutorialPayload {
  return {
    id: String(doc._id),
    topic: doc.topic,
    titleBn: doc.titleBn,
    titleEn: doc.titleEn,
    descriptionBn: doc.descriptionBn ?? null,
    descriptionEn: doc.descriptionEn ?? null,
    youtubeId: doc.youtubeId,
    sortOrder: doc.sortOrder ?? 0,
    isPublished: doc.isPublished,
  };
}

/** Published videos, in display order — what customers and the landing page see. */
export async function publishedTutorials(topic?: TutorialTopic): Promise<TutorialPayload[]> {
  const docs = await Tutorial.find({ isPublished: true, ...(topic ? { topic } : {}) })
    .sort({ topic: 1, sortOrder: 1, createdAt: 1 })
    .lean();
  return docs.map(toTutorialPayload);
}
