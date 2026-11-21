'use client';

import { FEATURE_LABELS } from '@storageos/shared';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useFeatures, useMe } from '@/lib/auth/hooks';
import { HELP_TOPICS, type HelpTopic } from '@/lib/help/topics';
import { PLANS_HREF, useRouteAccess } from '@/lib/navigation/route-access';

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Singular aproximado: «usuarios» encuentra «usuario», «remesas» encuentra «remesa». */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function matches(topic: HelpTopic, words: string[]): boolean {
  const haystack = normalize(
    [
      topic.title,
      topic.summary,
      topic.keywords ?? '',
      ...topic.steps,
      ...topic.links.map((l) => l.label),
    ].join(' '),
  );
  return words.every((w) => haystack.includes(w) || haystack.includes(stem(w)));
}

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

/** Guías por temas con buscador. */
export function HelpTopics() {
  const [search, setSearch] = useState('');
  const access = useRouteAccess();
  const me = useMe();
  const features = useFeatures();
  const canSeePlans = access(PLANS_HREF).allowed;
  const words = normalize(search).split(/\s+/).filter(Boolean);
  const topics = useMemo(
    () => HELP_TOPICS.filter((t) => matches(t, words)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  );
  const groups = [...new Set(topics.map((t) => t.group))];
  useScrollToHash();

  return (
    <div className="space-y-6">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Buscar en las guías"
          placeholder="Buscar: fianza, remesa, Veri*Factu…"
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {topics.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No hay ninguna guía sobre eso.{' '}
          <Link href="/support" className="text-primary hover:underline">
            Pregúntanos
          </Link>
          .
        </p>
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
  access,
  notInPlan,
  canSeePlans,
}: {
  topic: HelpTopic;
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
          {topic.title}
          {notInPlan && (
            <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
              No incluido en tu plan
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{topic.summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          {topic.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
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
