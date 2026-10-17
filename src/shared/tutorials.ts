/**
 * Training videos (tutorials) — shared by the server, which stores them, and the client, which
 * shows them: on the Tutorials page, as "Watch how" on each module, and the `overview` one as the
 * landing page's demo.
 *
 * The videos live on YouTube; only the 11-character video id is stored. Topics are the client's
 * module keys (`config/modules.ts`) plus two of their own — the client typechecks its module keys
 * against this list, so the two cannot drift apart.
 */

type Member<T extends readonly string[]> = T[number];

export const TUTORIAL_TOPICS = [
  /** The landing page's demo video, for visitors. */
  'overview',
  /** First steps for a new business — shown first, and linked from the dashboard checklist. */
  'getting-started',
  'catalog',
  'dealers',
  'sales',
  'dispatch',
  'counter',
  'billing',
  'receivables',
  'purchase',
  'inventory',
  'reports',
  'settings',
] as const;
export type TutorialTopic = Member<typeof TUTORIAL_TOPICS>;

export interface TutorialPayload {
  id: string;
  topic: TutorialTopic;
  titleBn: string;
  titleEn: string;
  descriptionBn: string | null;
  descriptionEn: string | null;
  youtubeId: string;
  sortOrder: number;
  isPublished: boolean;
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id from anything a person is likely to paste: a `watch?v=` link, a `youtu.be/` short
 * link, a Shorts or embed link (with or without `www.` / `m.` / `-nocookie`), or the bare id.
 * Null for anything else.
 */
export function parseYouTubeId(input: string): string | null {
  const text = input.trim();
  if (ID.test(text)) return text;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com' || host === 'music.youtube.com') {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first === 'shorts' || first === 'embed' || first === 'live' || first === 'v') id = second ?? null;
  }
  return id && ID.test(id) ? id : null;
}

/** The thumbnail YouTube serves for every video (480×360, always present). */
export function youtubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

/** The player, in privacy-enhanced mode: no YouTube cookies until the viewer presses play. */
export function youtubeEmbed(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`;
}
