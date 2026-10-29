'use client';

import { FileCheck2, Loader2 } from 'lucide-react';
import { useState } from 'react';

import type { LegalDocAcceptanceDto } from '@storageos/shared';

import { MarkdownView } from '@/components/public/markdown-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLegalDocVersion } from '@/lib/customers/hooks';
import { formatDateTime } from '@/lib/format';

const CHANNEL: Record<string, string> = {
  remote: 'En la web, antes de pagar',
  in_person: 'En el local',
};

/** Condiciones generales que aceptó el inquilino para este contrato (versión exacta). */
export function GeneralTermsCard({ acceptances }: { acceptances: LegalDocAcceptanceDto[] }) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <FileCheck2 className="size-4 text-muted-foreground" />
          Condiciones generales de contratación
        </CardTitle>
        <CardDescription>
          La versión exacta que aceptó el inquilino. Si cambias tus condiciones, esta no cambia.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {acceptances.length === 0 ? (
          <p className="text-muted-foreground">
            Aún no las ha aceptado (se aceptan al firmar o antes de pagar).
          </p>
        ) : (
          acceptances.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div>
                <p className="font-medium">
                  Versión {a.version} · aceptada el {formatDateTime(a.acceptedAt)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {CHANNEL[a.channel] ?? a.channel}
                  {a.ipAddress ? ` · IP ${a.ipAddress}` : ''}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setOpenId(a.versionId)}>
                Ver el texto
              </Button>
            </div>
          ))
        )}
      </CardContent>
      <VersionDialog id={openId} onClose={() => setOpenId(null)} />
    </Card>
  );
}

function VersionDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useLegalDocVersion(id);
  const v = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {v ? `${v.title} · versión ${v.version}` : 'Condiciones generales'}
          </DialogTitle>
        </DialogHeader>
        {!v ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="max-h-[65vh] space-y-3 overflow-auto">
            <p className="text-xs text-muted-foreground">
              Publicada el {formatDateTime(v.createdAt)}
              {v.current ? ' · es la vigente' : ' · ya no es la vigente'}
            </p>
            <MarkdownView content={v.content} />
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              Huella SHA-256: {v.contentHash}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
