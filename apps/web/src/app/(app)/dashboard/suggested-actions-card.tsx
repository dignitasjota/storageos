'use client';

import {
  ArrowRight,
  BadgeEuro,
  HeartHandshake,
  Loader2,
  Lightbulb,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';

import type { SuggestedActionCategory } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSuggestedActions } from '@/lib/analytics/hooks';

const CATEGORY: Record<
  SuggestedActionCategory,
  { icon: typeof HeartHandshake; label: string; tint: string }
> = {
  retention: { icon: HeartHandshake, label: 'Retención', tint: 'text-rose-500' },
  pricing: { icon: TrendingUp, label: 'Precio', tint: 'text-emerald-500' },
  collections: { icon: BadgeEuro, label: 'Cobros', tint: 'text-amber-500' },
  renewal: { icon: ArrowRight, label: 'Renovación', tint: 'text-sky-500' },
};

/** «Sugerencias de hoy»: acciones concretas priorizadas con enlace al recurso. */
export function SuggestedActionsCard() {
  const q = useSuggestedActions();
  const actions = q.data?.actions ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lightbulb className="size-4 text-amber-500" />
          Sugerencias de hoy
        </CardTitle>
        <CardDescription>Lo más rentable en lo que actuar ahora mismo.</CardDescription>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : actions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Todo en orden: sin acciones urgentes por ahora. 🎉
          </p>
        ) : (
          <ul className="divide-y">
            {actions.map((a) => {
              const cat = CATEGORY[a.category];
              const Icon = cat.icon;
              return (
                <li key={a.id} className="flex items-center gap-3 py-2.5">
                  <span className={`shrink-0 ${cat.tint}`}>
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{a.title}</p>
                      {a.priority === 'high' && (
                        <Badge className="bg-red-500 text-[10px] text-white hover:bg-red-500">
                          Urgente
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                  <Button asChild size="sm" variant="outline" className="shrink-0">
                    <Link href={a.href}>{a.cta}</Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
