'use client';

import { relatedHelpTopics } from '@storageos/shared';
import { BookOpen } from 'lucide-react';
import { useMemo } from 'react';

import { useHelpTopics } from '@/lib/help/hooks';
import { cn } from '@/lib/utils';

/**
 * Guías de «Cómo funciona» relacionadas con un texto (el asunto de una
 * consulta, por ejemplo). Con menos de 3 caracteres o sin coincidencias no
 * pinta nada. Los enlaces abren la guía en otra pestaña para no perder lo
 * que se está escribiendo.
 */
export function RelatedGuides({
  query,
  limit = 3,
  className,
}: {
  query: string;
  limit?: number;
  className?: string;
}) {
  const { topics } = useHelpTopics();
  const text = query.trim();
  const related = useMemo(
    () => (text.length >= 3 ? relatedHelpTopics(topics, text, limit) : []),
    [topics, text, limit],
  );
  if (related.length === 0) return null;

  return (
    <div className={cn('rounded-md border bg-muted/40 p-3 text-sm', className)}>
      <p className="flex items-center gap-1.5 font-medium">
        <BookOpen className="size-4 text-muted-foreground" aria-hidden />
        Quizá te ayude:
      </p>
      <ul className="mt-2 space-y-1.5">
        {related.map((topic) => (
          <li key={topic.id}>
            <a
              href={`/help#${topic.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              {topic.title}
            </a>
            <span className="text-muted-foreground"> — {topic.summary}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
