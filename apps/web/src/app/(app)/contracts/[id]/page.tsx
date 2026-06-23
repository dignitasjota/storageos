'use client';

import {
  ArrowLeft,
  CircleSlash,
  Download,
  FileText,
  Loader2,
  Pause,
  PenTool,
  Send,
  Square,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { CheckoutPhotosCard } from './checkout-photos-card';

import { ContractStatusBadge } from '@/components/contract-status-badge';
import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useAddContractNote,
  useCancelContract,
  useChangeContractPrice,
  useContract,
  useContractEvents,
  useEndContract,
  useGenerateContractPdf,
  useRequestEndContract,
  useRequestSignature,
  useSignContract,
} from '@/lib/customers/hooks';
import { useInsurancePlans, useSetContractInsurance } from '@/lib/insurance/hooks';

const EVENT_LABELS: Record<string, string> = {
  created: 'Creado',
  signed: 'Firmado',
  price_changed: 'Precio modificado',
  unit_changed: 'Cambio de trastero',
  paused: 'Pausado',
  resumed: 'Reanudado',
  ending_requested: 'Baja solicitada',
  ended: 'Finalizado',
  cancelled: 'Cancelado',
  note_added: 'Nota',
};

export default function ContractDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const contract = useContract(id);
  const events = useContractEvents(id);

  const sign = useSignContract();
  const requestSignature = useRequestSignature();
  const requestEnd = useRequestEndContract();
  const end = useEndContract();
  const cancel = useCancelContract();
  const changePrice = useChangeContractPrice();
  const addNote = useAddContractNote();
  const generatePdf = useGenerateContractPdf();
  const canWriteC = useHasPermission('contracts:write');
  const canManageC = useHasPermission('contracts:manage');

  const [priceOpen, setPriceOpen] = useState(false);
  const [priceValue, setPriceValue] = useState(0);
  const [priceReason, setPriceReason] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [note, setNote] = useState('');
  const [signOpen, setSignOpen] = useState(false);
  const [signName, setSignName] = useState('');
  const [signDrawn, setSignDrawn] = useState<string | null>(null);

  if (contract.isLoading || !contract.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const c = contract.data;

  async function handle(action: () => Promise<unknown>, ok: string) {
    try {
      await action();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/contracts">
            <ArrowLeft className="mr-1 h-4 w-4" /> Contratos
          </Link>
        </Button>
        <div className="mt-2 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-mono text-2xl font-semibold tracking-tight">
                {c.contractNumber}
              </h1>
              <ContractStatusBadge status={c.status} />
            </div>
            <p className="text-sm text-muted-foreground">
              <Link href={`/customers/${c.customerId}`} className="hover:underline">
                {c.customerName}
              </Link>{' '}
              ·{' '}
              <Link href={`/facilities/${c.facilityId}`} className="hover:underline">
                {c.facilityName}
              </Link>{' '}
              ·{' '}
              <Link href={`/units/${c.unitId}`} className="hover:underline">
                {c.unitCode}
              </Link>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {c.status === 'draft' && canWriteC && (
              <>
                <Button onClick={() => setSignOpen(true)}>
                  <PenTool className="mr-1 h-4 w-4" /> Firmar
                </Button>
                <Button
                  variant="outline"
                  disabled={requestSignature.isPending}
                  onClick={async () => {
                    try {
                      const res = await requestSignature.mutateAsync(c.id);
                      await navigator.clipboard?.writeText(res.signingUrl).catch(() => undefined);
                      toast.success(
                        res.emailed
                          ? 'Enlace de firma enviado al inquilino y copiado al portapapeles.'
                          : 'Enlace de firma copiado al portapapeles.',
                      );
                    } catch (err) {
                      toast.error(err instanceof ApiError ? err.body.message : 'Error');
                    }
                  }}
                >
                  <Send className="mr-1 h-4 w-4" /> Solicitar firma
                </Button>
              </>
            )}
            {c.status === 'active' && canManageC && (
              <Button
                variant="outline"
                onClick={() =>
                  handle(() => requestEnd.mutateAsync({ id: c.id }), 'Baja solicitada.')
                }
              >
                <Pause className="mr-1 h-4 w-4" /> Solicitar baja
              </Button>
            )}
            {(c.status === 'active' || c.status === 'ending') && canManageC && (
              <Button
                variant="outline"
                onClick={() => handle(() => end.mutateAsync({ id: c.id }), 'Contrato finalizado.')}
              >
                <Square className="mr-1 h-4 w-4" /> Finalizar
              </Button>
            )}
            {(c.status === 'active' || c.status === 'ending') && canManageC && (
              <Button
                variant="outline"
                onClick={() => {
                  setPriceValue(c.priceMonthly);
                  setPriceReason('');
                  setPriceOpen(true);
                }}
              >
                Cambiar precio
              </Button>
            )}
            {c.status !== 'ended' && c.status !== 'cancelled' && canManageC && (
              <Button
                variant="destructive"
                onClick={() => {
                  setCancelReason('');
                  setCancelOpen(true);
                }}
              >
                <CircleSlash className="mr-1 h-4 w-4" /> Cancelar
              </Button>
            )}
            {canManageC && (
              <Button
                variant="outline"
                onClick={() => handle(() => generatePdf.mutateAsync(c.id), 'PDF generado.')}
                disabled={generatePdf.isPending}
              >
                {generatePdf.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="mr-1 h-4 w-4" />
                )}
                {c.signedPdfUrl ? 'Regenerar PDF' : 'Generar PDF'}
              </Button>
            )}
            {c.signedPdfUrl && (
              <Button asChild variant="outline">
                <a href={c.signedPdfUrl} target="_blank" rel="noreferrer">
                  <Download className="mr-1 h-4 w-4" /> Descargar
                </a>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Cuota efectiva
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{c.effectivePrice.toFixed(2)} €</p>
            <p className="text-xs text-muted-foreground">
              Base {c.priceMonthly.toFixed(2)} − descuento {c.discountAmount.toFixed(2)} €
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Fianza</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{c.depositAmount.toFixed(2)} €</p>
            <p className="text-xs text-muted-foreground">Estado: {c.depositStatus}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Inicio</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{c.startDate}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Fin</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{c.endDate ?? 'Sin fecha'}</p>
          </CardContent>
        </Card>
      </div>

      <InsuranceCard
        contractId={c.id}
        planId={c.insurancePlanId}
        planName={c.insurancePlanName}
        price={c.insurancePrice}
      />

      <CheckoutPhotosCard contractId={c.id} />

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Textarea
              placeholder="Añadir nota interna..."
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
            />
            <Button
              onClick={() =>
                handle(async () => {
                  await addNote.mutateAsync({ id: c.id, input: { note } });
                  setNote('');
                }, 'Nota añadida.')
              }
              disabled={!note.trim()}
            >
              Añadir
            </Button>
          </div>
          {events.data && events.data.length === 0 && (
            <p className="text-sm text-muted-foreground">Sin eventos.</p>
          )}
          {events.data && events.data.length > 0 && (
            <ul className="space-y-3">
              {events.data.map((e) => (
                <li key={e.id} className="border-l-2 border-muted pl-3">
                  <p className="text-sm">
                    <strong>{EVENT_LABELS[e.eventType] ?? e.eventType}</strong>
                    {e.eventType === 'price_changed' &&
                      ` · ${(e.payload.from as number).toFixed(2)} → ${(e.payload.to as number).toFixed(2)} €`}
                    {e.eventType === 'note_added' && (
                      <span className="block whitespace-pre-line text-muted-foreground">
                        {String(e.payload.note ?? '')}
                      </span>
                    )}
                    {e.eventType === 'cancelled' && e.payload.reason ? (
                      <span className="block text-muted-foreground">
                        Motivo: {String(e.payload.reason)}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(e.occurredAt).toLocaleString('es-ES')}
                    {e.createdByName && ` · ${e.createdByName}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={priceOpen} onOpenChange={setPriceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar precio del contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nueva cuota mensual (€)</Label>
              <Input
                type="number"
                step="0.01"
                value={priceValue}
                onChange={(e) => setPriceValue(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Motivo</Label>
              <Input
                value={priceReason}
                onChange={(e) => setPriceReason(e.target.value)}
                placeholder="Revisión anual, descuento fidelidad..."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPriceOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                handle(async () => {
                  await changePrice.mutateAsync({
                    id: c.id,
                    body: { priceMonthly: priceValue, reason: priceReason },
                  });
                  setPriceOpen(false);
                }, 'Precio actualizado.')
              }
              disabled={priceValue <= 0 || !priceReason.trim()}
            >
              Aplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancelar contrato</DialogTitle>
          </DialogHeader>
          <div>
            <Label>Motivo (opcional)</Label>
            <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                handle(async () => {
                  await cancel.mutateAsync({ id: c.id, body: { reason: cancelReason } });
                  setCancelOpen(false);
                }, 'Contrato cancelado.')
              }
            >
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={signOpen} onOpenChange={setSignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Firmar contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Captura la firma del inquilino en una tablet (firma en el local) o firma sin
              manuscrita.
            </p>
            <div className="space-y-1">
              <Label>Nombre del firmante</Label>
              <Input
                value={signName}
                onChange={(e) => setSignName(e.target.value)}
                placeholder="Nombre y apellidos"
              />
            </div>
            <SignaturePad onChange={setSignDrawn} />
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                handle(() => sign.mutateAsync({ id: c.id }), 'Contrato firmado.').then(() =>
                  setSignOpen(false),
                )
              }
            >
              Firmar sin manuscrita
            </Button>
            <Button
              disabled={!signDrawn}
              onClick={() =>
                handle(
                  () =>
                    sign.mutateAsync({
                      id: c.id,
                      body: {
                        method: 'drawn',
                        signerName: signName || undefined,
                        signatureImage: signDrawn ?? undefined,
                      },
                    }),
                  'Contrato firmado.',
                ).then(() => {
                  setSignOpen(false);
                  setSignDrawn(null);
                  setSignName('');
                })
              }
            >
              Firmar con esta firma
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InsuranceCard({
  contractId,
  planId,
  planName,
  price,
}: {
  contractId: string;
  planId: string | null;
  planName: string | null;
  price: number | null;
}) {
  const canManage = useHasPermission('contracts:write');
  const plans = useInsurancePlans(true);
  const setInsurance = useSetContractInsurance();

  async function change(value: string) {
    try {
      await setInsurance.mutateAsync({ contractId, planId: value === 'none' ? null : value });
      toast.success(value === 'none' ? 'Seguro retirado.' : 'Seguro asignado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">
          Seguro / protección
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {planId ? (
          <p className="text-sm">
            <span className="font-medium">{planName}</span>
            {price != null && ` · ${price.toFixed(2)} €/mes`}{' '}
            <span className="text-muted-foreground">(se factura con el alquiler)</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Sin seguro contratado.</p>
        )}
        {canManage && (
          <Select value={planId ?? 'none'} onValueChange={change} disabled={setInsurance.isPending}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Asignar plan..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Sin seguro</SelectItem>
              {(plans.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name} · {p.monthlyPrice.toFixed(2)} €/mes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardContent>
    </Card>
  );
}
