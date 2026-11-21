'use client';

import {
  FEATURE_LABELS,
  HELP_TOPIC_GROUPS,
  helpSearchWords,
  searchHelpTopics,
  toEmbedVideoUrl,
  type HelpTopicDto,
} from '@storageos/shared';
import { Bot, PlayCircle, Search } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { HelpHighlight } from '@/components/help/help-highlight';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useFeatures, useHasFeature, useHasPermission, useMe } from '@/lib/auth/hooks';
import { useHelpTopics } from '@/lib/help/hooks';
import { PLANS_HREF, useRouteAccess } from '@/lib/navigation/route-access';

/**
 * Baja hasta la guía del ancla (`/help#domiciliacion`). Las guías se pintan
 * después de comprobar la sesión, así que el navegador no lo hace solo al
 * abrir el enlace o recargar. Si la guía no está (oculta por la búsqueda), no
 * hace nada.
 */
function useScrollToHash() {
  useEffect(() => {
    const scroll = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (!id) return;
      requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ block: 'start' });
      });
    };
    scroll();
    window.addEventListener('hashchange', scroll);
    return () => window.removeEventListener('hashchange', scroll);
  }, []);
}

/**
 * La búsqueda vive en la dirección (`/help?q=fianza`): se mantiene al recargar
 * y se puede compartir. Se escribe sin recargar la página y conservando el
 * ancla.
 */
function useSearchInUrl(): [string, (value: string) => void] {
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get('q') ?? '';
  const [search, setSearch] = useState(fromUrl);
  const lastWritten = useRef(fromUrl);

  // Si la dirección cambia desde fuera (otro enlace a `/help?q=…`), manda ella.
  useEffect(() => {
    if (fromUrl !== lastWritten.current) {
      lastWritten.current = fromUrl;
      setSearch(fromUrl);
    }
  }, [fromUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const q = search.trim();
      if (q === lastWritten.current) return;
      lastWritten.current = q;
      const query = q ? `?q=${encodeURIComponent(q)}` : '';
      const url = `${window.location.pathname}${query}${window.location.hash}`;
      window.history.replaceState(window.history.state, '', url);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  return [search, setSearch];
}

/** Guías por temas con buscador. */
export function HelpTopics() {
  const [search, setSearch] = useSearchInUrl();
  const { topics: allTopics } = useHelpTopics();
  const access = useRouteAccess();
  const me = useMe();
  const features = useFeatures();
  const hasAssistant = useHasFeature('ai_assistant');
  const canUseAssistant = useHasPermission('ai:use');
  const canSeePlans = access(PLANS_HREF).allowed;
  const words = useMemo(() => helpSearchWords(search), [search]);
  const topics = useMemo(() => searchHelpTopics(allTopics, search), [allTopics, search]);
  const knownGroups = HELP_TOPIC_GROUPS as readonly string[];
  const groups = [
    ...HELP_TOPIC_GROUPS.filter((g) => topics.some((t) => t.group === g)),
    ...new Set(topics.map((t) => t.group).filter((g) => !knownGroups.includes(g))),
  ];
  useScrollToHash();
  const question = search.trim();

  return (
    <div className="space-y-6">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Buscar en las guías"
          placeholder="Buscar: fianza, remesa, Veri*Factu…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {topics.length === 0 && (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>No hay ninguna guía sobre eso.</p>
          {hasAssistant && canUseAssistant && question ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm">
                <Link href={`/assistant?q=${encodeURIComponent(question)}`}>
                  <Bot className="size-4" aria-hidden />
                  Preguntar al asistente
                </Link>
              </Button>
              <span>
                o{' '}
                <Link href="/support" className="text-primary hover:underline">
                  pregúntanos
                </Link>
                .
              </span>
            </div>
          ) : (
            <p>
              <Link href="/support" className="text-primary hover:underline">
                Pregúntanos
              </Link>
              .
            </p>
          )}
        </div>
      )}
      {groups.map((group) => (
        <section key={group} className="space-y-3">
          <h2 className="text-lg font-semibold">{group}</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {topics
              .filter((t) => t.group === group)
              .map((topic) => (
                <HelpTopicCard
                  key={topic.id}
                  topic={topic}
                  words={words}
                  access={access}
                  notInPlan={!!me.data && !!topic.feature && !features.includes(topic.feature)}
                  canSeePlans={canSeePlans}
                />
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function HelpTopicCard({
  topic,
  words,
  access,
  notInPlan,
  canSeePlans,
}: {
  topic: HelpTopicDto;
  /** Palabras buscadas (se resaltan). */
  words: string[];
  access: ReturnType<typeof useRouteAccess>;
  /** Lo que explica la guía necesita una función que su plan no incluye. */
  notInPlan: boolean;
  canSeePlans: boolean;
}) {
  // Enlaces a páginas sin permiso: fuera. A funciones de fuera de su plan: avisados.
  const links = topic.links
    .map((l) => ({ ...l, access: access(l.href) }))
    .filter((l) => l.access.allowed);
  const showPlans = notInPlan || links.some((l) => l.access.missingFeature);

  return (
    <Card id={topic.id} className="scroll-mt-20">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <span>
            <HelpHighlight text={topic.title} words={words} />
          </span>
          {notInPlan && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              No incluido en tu plan
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          <HelpHighlight text={topic.summary} words={words} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          {topic.steps.map((s, i) => (
            <li key={i}>
              <HelpHighlight text={s} words={words} />
            </li>
          ))}
        </ol>
        <HelpTopicMedia topic={topic} />
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {links.map((l) =>
            l.access.missingFeature ? (
              <span key={l.href} className="text-muted-foreground">
                {l.label}{' '}
                <span className="text-xs">
                  ({FEATURE_LABELS[l.access.missingFeature]}: no incluido en tu plan)
                </span>
              </span>
            ) : (
              <Link key={l.href} href={l.href} className="text-primary hover:underline">
                {l.label}
              </Link>
            ),
          )}
          {showPlans && canSeePlans && (
            <Link href={PLANS_HREF} className="text-primary hover:underline">
              Ver planes y extras
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Imagen o vídeo de la guía. El vídeo solo se carga al pulsar «Ver vídeo»
 * (para no meter varios reproductores de golpe) y solo si es de YouTube o
 * Vimeo.
 */
function HelpTopicMedia({ topic }: { topic: HelpTopicDto }) {
  const [playing, setPlaying] = useState(false);
  const video =
    topic.videoEmbedUrl && toEmbedVideoUrl(topic.videoEmbedUrl) ? topic.videoEmbedUrl : null;
  if (!topic.imageUrl && !video) return null;

  return (
    <div className="space-y-2">
      {topic.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={topic.imageUrl}
          alt={topic.title}
          loading="lazy"
          className="max-h-72 w-full rounded-md border object-contain"
        />
      )}
      {video &&
        (playing ? (
          <div className="aspect-video w-full overflow-hidden rounded-md border">
            <iframe
              src={video}
              title={`Vídeo: ${topic.title}`}
              className="size-full"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setPlaying(true)}>
            <PlayCircle className="size-4" aria-hidden />
            Ver vídeo
          </Button>
        ))}
    </div>
  );
}
