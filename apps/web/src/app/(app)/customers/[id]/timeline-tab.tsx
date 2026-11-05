'use client';

import {
  Banknote,
  DoorOpen,
  FileSignature,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  Paperclip,
  StickyNote,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { CustomerTimelineKind } from '@storageos/shared';

import { SectionError } from '@/components/dashboard/section-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCustomerTimeline } from '@/lib/customers/features-hooks';
import { formatDate, formatDateTime } from '@/lib/format';

const KINDS: { kind: CustomerTimelineKind; label: string; icon: typeof FileText }[] = [
  { kind: 'contract', label: 'Contratos', icon: FileSignature },
  { kind: 'invoice', label: 'Facturas', icon: FileText },
  { kind: 'payment', label: 'Cobros', icon: Banknote },
  { kind: 'communication', label: 'Correos', icon: Mail },
  { kind: 'message', label: 'Mensajes', icon: MessageSquare },
  { kind: 'note', label: 'Notas', icon: StickyNote },
  { kind: 'access', label: 'Accesos', icon: DoorOpen },
  { kind: 'document', label: 'Documentos', icon: Paperclip },
];

/** Todo lo que ha pasado con el inquilino, lo último primero. */
export function CustomerTimelineTab({ customerId }: { customerId: string }) {
  const timeline = useCustomerTimeline(customerId);
  const [only, setOnly] = useState<CustomerTimelineKind | null>(null);
  const items = (timeline.data ?? []).filter((i) => !only || i.kind === only);
  const present = new Set((timeline.data ?? []).map((i) => i.kind));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cronología</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {timeline.isError && <SectionError onRetry={() => void timeline.refetch()} />}
        {timeline.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        {present.size > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {KINDS.filter((k) => present.has(k.kind)).map((k) => (
              <button
                key={k.kind}
                type="button"
                aria-pressed={only === k.kind}
                onClick={() => setOnly(only === k.kind ? null : k.kind)}
                className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  only === k.kind
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}
        {!timeline.isLoading && !timeline.isError && items.length === 0 && (
          <p className="text-sm text-muted-foreground">Todavía no hay nada que enseñar.</p>
        )}
        <ol className="space-y-3">
          {items.map((item) => {
            const Icon = KINDS.find((k) => k.kind === item.kind)?.icon ?? FileText;
            const title = <span className="font-medium">{item.title}</span>;
            return (
              <li key={item.id} className="flex gap-3 text-sm">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  {item.href ? (
                    <Link href={item.href} className="hover:underline">
                      {title}
                    </Link>
                  ) : (
                    title
                  )}
                  {item.detail && (
                    <p className="break-words text-muted-foreground">{item.detail}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {item.dateOnly ? formatDate(item.at) : formatDateTime(item.at)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
