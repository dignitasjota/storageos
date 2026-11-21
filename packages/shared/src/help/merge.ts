import { toEmbedVideoUrl } from '../web/embeds';

import { HELP_TOPIC_GROUPS, type HelpTopic } from './topics';

import type { AdminHelpTopicDto, HelpTopicContent, HelpTopicDto } from './schemas';

/** Lo que el panel de administración guarda de una guía. */
export interface HelpTopicOverride {
  topicId: string;
  /** Texto propio; null = el de la guía del código. */
  content: HelpTopicContent | null;
  imageUrl: string | null;
  imageKey: string | null;
  videoUrl: string | null;
  position: number | null;
  published: boolean;
  hidden: boolean;
  updatedAt: string | null;
}

function fromContent(id: string, c: HelpTopicContent): HelpTopic {
  return {
    id,
    group: c.group,
    title: c.title,
    summary: c.summary,
    steps: c.steps,
    links: c.links,
    ...(c.keywords ? { keywords: c.keywords } : {}),
    ...(c.feature ? { feature: c.feature } : {}),
  };
}

/** Orden por defecto de la guía del código en la posición `index`. */
export function defaultHelpTopicPosition(index: number): number {
  return (index + 1) * 10;
}

/**
 * Las guías del código con lo que el panel haya cambiado encima, más las
 * nuevas, ordenadas por grupo y orden. Incluye las ocultas y sin publicar
 * (lo filtra `visibleHelpTopics`). Una fila sin texto de una guía que ya no
 * está en el código se ignora.
 */
export function mergeHelpTopics(
  code: HelpTopic[],
  overrides: HelpTopicOverride[],
): AdminHelpTopicDto[] {
  const byId = new Map(overrides.map((o) => [o.topicId, o]));
  const merged: AdminHelpTopicDto[] = [];

  code.forEach((original, index) => {
    const o = byId.get(original.id);
    const topic = o?.content ? fromContent(original.id, o.content) : original;
    const videoUrl = o?.videoUrl ?? null;
    merged.push({
      ...topic,
      imageUrl: o?.imageUrl ?? null,
      videoEmbedUrl: videoUrl ? toEmbedVideoUrl(videoUrl) : null,
      source: 'code',
      edited: !!o?.content,
      hidden: o?.hidden ?? false,
      published: o?.published ?? true,
      position: o?.position ?? defaultHelpTopicPosition(index),
      videoUrl,
      imageKey: o?.imageKey ?? null,
      updatedAt: o?.updatedAt ?? null,
      original,
    });
  });

  const codeIds = new Set(code.map((t) => t.id));
  for (const o of overrides) {
    if (codeIds.has(o.topicId) || !o.content) continue;
    merged.push({
      ...fromContent(o.topicId, o.content),
      imageUrl: o.imageUrl,
      videoEmbedUrl: o.videoUrl ? toEmbedVideoUrl(o.videoUrl) : null,
      source: 'custom',
      edited: false,
      hidden: o.hidden,
      published: o.published,
      position: o.position ?? defaultHelpTopicPosition(code.length + 100),
      videoUrl: o.videoUrl,
      imageKey: o.imageKey,
      updatedAt: o.updatedAt,
      original: null,
    });
  }

  const groupIndex = (g: string) => {
    const i = (HELP_TOPIC_GROUPS as readonly string[]).indexOf(g);
    return i === -1 ? HELP_TOPIC_GROUPS.length : i;
  };
  return merged.sort(
    (a, b) =>
      groupIndex(a.group) - groupIndex(b.group) ||
      a.position - b.position ||
      a.title.localeCompare(b.title, 'es'),
  );
}

/** Lo que ve el tenant: sin las ocultas ni las que no están publicadas. */
export function visibleHelpTopics(merged: AdminHelpTopicDto[]): HelpTopicDto[] {
  return merged
    .filter((t) => !t.hidden && t.published)
    .map((t) => ({
      id: t.id,
      group: t.group,
      title: t.title,
      summary: t.summary,
      steps: t.steps,
      links: t.links,
      ...(t.keywords ? { keywords: t.keywords } : {}),
      ...(t.feature ? { feature: t.feature } : {}),
      imageUrl: t.imageUrl,
      videoEmbedUrl: t.videoEmbedUrl,
    }));
}

/** Las guías del código como las daría el API sin cambios (respaldo de la web). */
export function codeHelpTopicDtos(code: HelpTopic[]): HelpTopicDto[] {
  return code.map((t) => ({ ...t, imageUrl: null, videoEmbedUrl: null }));
}
