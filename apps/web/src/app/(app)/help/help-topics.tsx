'use client';

import { Search } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { HELP_TOPICS, type HelpTopic } from '@/lib/help/topics';

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(topic: HelpTopic, words: string[]): boolean {
  const haystack = normalize(
    [topic.title, topic.summary, topic.keywords ?? '', ...topic.steps].join(' '),
  );
  return words.every((w) => haystack.includes(w));
}

/** Guías por temas con buscador. */
export function HelpTopics() {
  const [search, setSearch] = useState('');
  const words = normalize(search).split(/\s+/).filter(Boolean);
  const topics = useMemo(
    () => HELP_TOPICS.filter((t) => matches(t, words)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  );
  const groups = [...new Set(topics.map((t) => t.group))];

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
                <Card key={topic.id} id={topic.id} className="scroll-mt-20">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{topic.title}</CardTitle>
                    <CardDescription>{topic.summary}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                      {topic.steps.map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ol>
                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                      {topic.links.map((l) => (
                        <Link key={l.href} href={l.href} className="text-primary hover:underline">
                          {l.label}
                        </Link>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
