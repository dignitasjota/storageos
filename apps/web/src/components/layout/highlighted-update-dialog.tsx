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
import { PLANS_HREF, useRouteAccess } from '@/lib/navigation/route-access';
import { useHighlightedProductUpdate, useProductUpdatesUnread } from '@/lib/product-updates/hooks';

const SEEN_KEY = 'storageos.highlighted-update.seen';

function readSeen(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * Aviso al entrar al panel con la novedad destacada reciente aún sin ver (una
 * vez por usuario y navegador). El servidor solo la da si se publicó hace pocos
 * días y después del alta del usuario o de la última vez que abrió «Novedades».
 */
export function HighlightedUpdateDialog() {
  const unread = useProductUpdatesUnread();
  const highlighted = useHighlightedProductUpdate((unread.data?.count ?? 0) > 0);
  const access = useRouteAccess();
  const [seen, setSeen] = useState<string[] | null>(null);
  useEffect(() => setSeen(readSeen()), []);

  const update =
    seen && highlighted.data && !seen.includes(highlighted.data.id) ? highlighted.data : null;
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

  // «Probarlo» solo si puede abrir la página y su plan la incluye; si le falta
  // la función, a los planes (si puede verlos); si no, a la lista de novedades.
  const link = update.link ? access(update.link) : null;
  const featureMissing =
    (update.feature && update.featureIncluded === false) || !!link?.missingFeature;
  const action =
    update.link && link?.allowed && !featureMissing
      ? { href: update.link, label: 'Probarlo' }
      : featureMissing && access(PLANS_HREF).allowed
        ? { href: PLANS_HREF, label: 'Ver planes y extras' }
        : { href: '/updates', label: 'Ver novedades' };

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
          <Button asChild onClick={dismiss}>
            <Link href={action.href}>{action.label}</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
