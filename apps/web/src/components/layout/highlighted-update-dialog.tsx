'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useProductUpdates, useProductUpdatesUnread } from '@/lib/product-updates/hooks';

const SEEN_KEY = 'storageos.highlighted-update.seen';

function readSeen(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/** Aviso al entrar al panel con la novedad destacada aún sin ver (una vez por usuario y navegador). */
export function HighlightedUpdateDialog() {
  const unread = useProductUpdatesUnread();
  const updates = useProductUpdates((unread.data?.count ?? 0) > 0);
  const [seen, setSeen] = useState<string[] | null>(null);
  useEffect(() => setSeen(readSeen()), []);

  const update = seen
    ? updates.data?.find((u) => u.highlighted && u.unread && !seen.includes(u.id))
    : undefined;
  if (!update) return null;

  const dismiss = () => {
    const next = [...(seen ?? []), update.id].slice(-50);
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* sin almacenamiento: vuelve a salir en otra visita */
    }
    setSeen(next);
  };

  return (
    <Dialog open onOpenChange={(v) => !v && dismiss()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            {update.title}
          </DialogTitle>
        </DialogHeader>
        {update.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={update.imageUrl} alt="" className="w-full rounded-md border" />
        )}
        <MarkdownView content={update.body} />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={dismiss}>
            Cerrar
          </Button>
          {update.link ? (
            <Button asChild onClick={dismiss}>
              <Link href={update.link}>Probarlo</Link>
            </Button>
          ) : (
            <Button asChild onClick={dismiss}>
              <Link href="/updates">Ver novedades</Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
