'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { MarkdownView } from '@/components/public/markdown-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLegalDocVersions } from '@/lib/customers/hooks';
import { formatDateTime } from '@/lib/format';

/** Versiones de las condiciones generales que han aceptado los inquilinos. */
export function TermsVersionsCard() {
  const q = useLegalDocVersions();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = q.data?.find((v) => v.id === openId) ?? null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Versiones aceptadas</CardTitle>
        <CardDescription>
          Cada vez que un inquilino acepta las condiciones se guarda el texto exacto. Si las
          cambias, se crea una versión nueva y las anteriores se conservan; en la ficha de cada
          contrato se ve cuál aceptó.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {q.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : !q.data || q.data.length === 0 ? (
          <p className="text-muted-foreground">Ningún inquilino las ha aceptado todavía.</p>
        ) : (
          q.data.map((v) => (
            <div
              key={v.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div>
                <p className="flex items-center gap-2 font-medium">
                  Versión {v.version}
                  {v.current && <Badge variant="secondary">Vigente</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">
                  Desde el {formatDateTime(v.createdAt)} · aceptada {v.acceptances}{' '}
                  {v.acceptances === 1 ? 'vez' : 'veces'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setOpenId(v.id)}>
                Ver el texto
              </Button>
            </div>
          ))
        )}
      </CardContent>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{open ? `${open.title} · versión ${open.version}` : ''}</DialogTitle>
          </DialogHeader>
          {open && (
            <div className="max-h-[65vh] space-y-3 overflow-auto">
              <MarkdownView content={open.content} />
              <p className="break-all font-mono text-[11px] text-muted-foreground">
                Huella SHA-256: {open.contentHash}
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
