'use client';

import { FilePlus2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ContractAnnexDto, ContractAnnexSentDto } from '@storageos/shared';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiFetch } from '@/lib/auth/api';
import {
  useContractAnnexAction,
  useContractAnnexes,
  useCreateContractAnnex,
} from '@/lib/customers/hooks';
import { formatDate, formatDateTime } from '@/lib/format';

const STATUS: Record<ContractAnnexDto['status'], { label: string; className: string }> = {
  pending: {
    label: 'Pendiente de firmar',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
  signed: {
    label: 'Firmado',
    className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  },
  cancelled: { label: 'Cancelado', className: 'bg-muted text-muted-foreground' },
};

/**
 * Anexos de un contrato firmado: lo firmado no se cambia; lo que se acuerde
 * después va en un anexo que el inquilino firma con el enlace del correo o
 * desde su área de clientes.
 */
export function AnnexesCard({ contractId, canAdd }: { contractId: string; canAdd: boolean }) {
  const ask = useConfirm();
  const { data, isLoading } = useContractAnnexes(contractId);
  const action = useContractAnnexAction(contractId);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<ContractAnnexDto | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const annexes = data ?? [];
  if (!canAdd && annexes.length === 0) return null;

  async function resend(a: ContractAnnexDto) {
    try {
      const res = (await action.mutateAsync({
        annexId: a.id,
        action: 'resend',
      })) as ContractAnnexSentDto;
      toast.success(
        res.emailed
          ? `Enlace nuevo enviado a ${res.annex.sentTo ?? 'su email'}.`
          : 'Enlace nuevo creado (el inquilino no tiene email: cópialo y envíaselo).',
      );
      await navigator.clipboard?.writeText(res.signingUrl).catch(() => undefined);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo reenviar.');
    }
  }

  async function cancel(a: ContractAnnexDto) {
    const ok = await ask({
      title: `¿Cancelar el anexo ${a.number}?`,
      description: 'Su enlace deja de valer y el inquilino ya no podrá firmarlo.',
      confirmLabel: 'Cancelar el anexo',
      destructive: true,
    });
    if (!ok) return;
    try {
      await action.mutateAsync({ annexId: a.id, action: 'cancel' });
      toast.success('Anexo cancelado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cancelar.');
    }
  }

  async function pdf(a: ContractAnnexDto) {
    setDownloading(a.id);
    try {
      const res = await apiFetch<{ url: string }>(`/contracts/${contractId}/annexes/${a.id}/pdf`);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar el PDF.');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Anexos</CardTitle>
          <CardDescription>
            Lo firmado no se cambia: lo que acordéis después va en un anexo que el inquilino firma
            aparte.
          </CardDescription>
        </div>
        {canAdd && (
          <Can permission="contracts:write">
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
              <FilePlus2 className="mr-2 h-4 w-4" /> Nuevo anexo
            </Button>
          </Can>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : annexes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Este contrato no tiene anexos.</p>
        ) : (
          annexes.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0 space-y-1 text-sm">
                <p className="font-medium">
                  Anexo {a.number} · {a.title}
                </p>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary" className={STATUS[a.status].className}>
                    {STATUS[a.status].label}
                  </Badge>
                  {a.status === 'signed' && a.signedAt && (
                    <span>
                      por {a.signerName} el {formatDateTime(a.signedAt)}
                    </span>
                  )}
                  {a.status === 'pending' && (
                    <span>
                      {a.sentTo ? `Enviado a ${a.sentTo}` : 'Sin enviar por correo'}
                      {a.linkExpiresAt
                        ? ` · el enlace vale hasta el ${formatDate(a.linkExpiresAt)}`
                        : ''}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setViewing(a)}>
                  Ver
                </Button>
                {a.status === 'signed' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void pdf(a)}
                    disabled={downloading === a.id}
                  >
                    {downloading === a.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    PDF
                  </Button>
                )}
                {a.status === 'pending' && (
                  <Can permission="contracts:write">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void resend(a)}
                      disabled={action.isPending}
                    >
                      Reenviar
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => void cancel(a)}
                      disabled={action.isPending}
                    >
                      Cancelar
                    </Button>
                  </Can>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
      {creating && <NewAnnexDialog contractId={contractId} onClose={() => setCreating(false)} />}
      {viewing && <AnnexDialog annex={viewing} onClose={() => setViewing(null)} />}
    </Card>
  );
}

function NewAnnexDialog({ contractId, onClose }: { contractId: string; onClose: () => void }) {
  const create = useCreateContractAnnex(contractId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const valid = title.trim().length >= 3 && body.trim().length >= 10;

  async function save() {
    try {
      const res = await create.mutateAsync({ title: title.trim(), body: body.trim() });
      toast.success(
        res.emailed
          ? `Anexo enviado a ${res.annex.sentTo ?? 'su email'} para que lo firme.`
          : 'Anexo creado. El inquilino no tiene email: copia el enlace en «Reenviar».',
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el anexo.');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Nuevo anexo</DialogTitle>
          <DialogDescription>
            El inquilino recibe un correo para firmarlo y también lo verá en su área de clientes.
            Una vez creado, el texto no se cambia: si hay que corregirlo, cancélalo y crea otro.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="annex-title">Asunto</Label>
            <Input
              id="annex-title"
              maxLength={150}
              placeholder="p. ej. Cancelación sin coste si el local no abre"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="annex-body">Lo que se añade al contrato</Label>
            <Textarea
              id="annex-body"
              rows={6}
              maxLength={10_000}
              placeholder="p. ej. Si el local no está abierto el 1 de marzo, el inquilino puede cancelar el contrato sin coste y se le devuelve lo pagado."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={!valid || create.isPending}>
            {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Enviar para firmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AnnexDialog({ annex, onClose }: { annex: ContractAnnexDto; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Anexo {annex.number} · {annex.title}
          </DialogTitle>
          <DialogDescription>{STATUS[annex.status].label}</DialogDescription>
        </DialogHeader>
        <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-sans text-sm">
          {annex.termsText}
        </pre>
        {annex.status === 'signed' && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {annex.signatureMethod === 'drawn' && annex.signatureImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={annex.signatureImage}
                alt="Firma"
                className="h-16 rounded border bg-white"
              />
            ) : (
              <p className="font-serif text-base italic text-foreground">{annex.typedSignature}</p>
            )}
            <p>
              Firmado por {annex.signerName} el {annex.signedAt && formatDateTime(annex.signedAt)}
            </p>
            {annex.ipAddress && <p>IP: {annex.ipAddress}</p>}
            {annex.userAgent && <p className="break-words">Navegador: {annex.userAgent}</p>}
            <p className="break-all">Huella SHA-256: {annex.documentHash}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
