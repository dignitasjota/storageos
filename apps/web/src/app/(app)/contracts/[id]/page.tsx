'use client';

import {
  ArrowLeft,
  CircleSlash,
  Download,
  FileText,
  Loader2,
  Lock,
  Pause,
  Pencil,
  PenTool,
  Send,
  Square,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ChecklistCard } from './checklist-card';
import { DepositCard, depositStatusLabel } from './deposit-card';
import { DepositRegistryCard } from './deposit-registry-card';
import { EditDraftDialog } from './edit-draft-dialog';
import { InspectionPhotosCard } from './inspection-photos-card';
import { IrpfRetentionCard } from './irpf-retention-card';
import { contractStartLabel, PreOpeningContractCard } from './pre-opening-card';
import { RetentionCard } from './retention-card';
import { SigningCard } from './signing-card';

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useContractDelinquencyCase } from '@/lib/collections/hooks';
import {
  useAddContractNote,
  useCancelContract,
  useChangeContractPrice,
  useChangeUnit,
  useContract,
  useContractEvents,
  useContractSignedPdfUrl,
  useEndContract,
  useGenerateContractPdf,
  useRenewContract,
  useRequestEndContract,
  useRequestSignature,
  useSignContract,
} from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { useUnits } from '@/lib/facilities/hooks';
import { formatDate, formatEur } from '@/lib/format';
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
  const renew = useRenewContract();
  const changeUnit = useChangeUnit();
  const addNote = useAddContractNote();
  const generatePdf = useGenerateContractPdf();
  const signedPdfUrl = useContractSignedPdfUrl();
  const canWriteC = useHasPermission('contracts:write');
  const canManageC = useHasPermission('contracts:manage');

  const [priceOpen, setPriceOpen] = useState(false);
  const [priceValue, setPriceValue] = useState(0);
  const [priceReason, setPriceReason] = useState('');
  const [endOpen, setEndOpen] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewMonths, setRenewMonths] = useState(12);
  const [moveOpen, setMoveOpen] = useState(false);
  const [newUnitId, setNewUnitId] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [prorate, setProrate] = useState(false);
  const availableUnits = useUnits({ status: 'available' });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  // `?action=move` (desde una solicitud de cambio) abre el traslado.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('action') === 'move') setMoveOpen(true);
  }, []);
  const [note, setNote] = useState('');
  const [signOpen, setSignOpen] = useState(false);
  const [signName, setSignName] = useState('');
  const [signDrawn, setSignDrawn] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  if (contract.isLoading || !contract.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const c = contract.data;
  // Reserva antes de la apertura sin empezar: se cancela desde su tarjeta.
  const pendingPreOpening = !!c.preOpening && !c.preOpening.startedAt;

  async function handle(action: () => Promise<unknown>, ok: string) {
    try {
      await action();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onDownloadPdf() {
    try {
      const { url } = await signedPdfUrl.mutateAsync(c.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar el PDF');
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
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
              {c.ownerName && <> · Propietario: {c.ownerName}</>}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {c.status === 'draft' && canWriteC && (
              <>
                <Button
                  onClick={() => {
                    setSignName((n) => n || c.customerName);
                    setSignOpen(true);
                  }}
                >
                  <PenTool className="mr-1 h-4 w-4" /> Firmar
                </Button>
                <Button variant="outline" onClick={() => setEditOpen(true)}>
                  <Pencil className="mr-1 h-4 w-4" /> Editar
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
            {c.status === 'active' && canManageC && !pendingPreOpening && (
              <Button
                variant="outline"
                onClick={() => {
                  const d = new Date();
                  d.setDate(d.getDate() + c.cancellationNoticeDays);
                  setEndDate(localDateString(d));
                  setEndOpen(true);
                }}
              >
                <Pause className="mr-1 h-4 w-4" /> Solicitar baja
              </Button>
            )}
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening && (
                <Button
                  variant="outline"
                  onClick={() =>
                    handle(() => end.mutateAsync({ id: c.id }), 'Contrato finalizado.')
                  }
                >
                  <Square className="mr-1 h-4 w-4" /> Finalizar
                </Button>
              )}
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening && (
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
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening && (
                <Button variant="outline" onClick={() => setRenewOpen(true)}>
                  Renovar
                </Button>
              )}
            {(c.status === 'active' || c.status === 'ending') && canManageC && (
              <Button
                variant="outline"
                onClick={() => {
                  setNewUnitId('');
                  setNewPrice('');
                  setProrate(false);
                  setMoveOpen(true);
                }}
              >
                Trasladar
              </Button>
            )}
            {c.status !== 'ended' &&
              c.status !== 'cancelled' &&
              canManageC &&
              !(pendingPreOpening && c.status !== 'draft') && (
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
                {c.hasSignedPdf ? 'Regenerar PDF' : 'Generar PDF'}
              </Button>
            )}
            {c.hasSignedPdf && (
              <Button variant="outline" onClick={onDownloadPdf} disabled={signedPdfUrl.isPending}>
                {signedPdfUrl.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Download className="mr-1 h-4 w-4" />
                )}
                Descargar
              </Button>
            )}
          </div>
        </div>
      </div>

      <OverlockBanner contractId={c.id} />
      <PreOpeningContractCard contract={c} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Cuota efectiva
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{formatEur(c.effectivePrice)}</p>
            <p className="text-xs text-muted-foreground">
              Base {formatEur(c.priceMonthly)} − descuento {formatEur(c.discountAmount)}
            </p>
            {c.discountAmount > 0 && c.discountExpiresAt && (
              <p className="text-xs text-muted-foreground">
                Descuento hasta el {formatDate(c.discountExpiresAt)} (luego vuelve a la cuota base)
              </p>
            )}
            {c.billingIntervalMonths > 1 && (
              <p className="mt-1 text-xs font-medium text-primary">
                Prepago {c.billingIntervalMonths === 12 ? 'anual' : 'semestral'}
                {c.prepayDiscountPct > 0 ? ` · −${c.prepayDiscountPct}%` : ''} (factura cada{' '}
                {c.billingIntervalMonths} meses)
              </p>
            )}
            {c.billingIntervalMonths === 1 && (c.firstPaymentMonths > 1 || c.coupon) && (
              <p className="mt-1 text-xs font-medium text-primary">
                Primer pago: {c.coupon?.months ?? c.firstPaymentMonths}{' '}
                {(c.coupon?.months ?? c.firstPaymentMonths) === 1 ? 'mes' : 'meses'} (después,
                mensual)
              </p>
            )}
            {c.coupon && (
              <p className="text-xs font-medium text-primary">
                Cupón {c.coupon.code}:{' '}
                {c.coupon.freeMonths > 0
                  ? `${c.coupon.freeMonths} ${c.coupon.freeMonths === 1 ? 'mes gratis' : 'meses gratis'}`
                  : `−${formatEur(c.coupon.discountAmount)} en el primer pago`}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Fianza</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xl font-semibold tabular-nums">{formatEur(c.depositAmount)}</p>
            <p className="text-xs text-muted-foreground">{depositStatusLabel(c.depositStatus)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Inicio</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{contractStartLabel(c)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Fin</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{c.endDate ? formatDate(c.endDate) : 'Sin fecha'}</p>
          </CardContent>
        </Card>
      </div>

      {/* Retención: solo sobre una baja en curso. */}
      {c.status === 'ending' && canManageC && <RetentionCard contractId={c.id} />}

      {c.status !== 'cancelled' && <ChecklistCard contractId={c.id} />}

      <Tabs defaultValue={c.status === 'draft' ? 'signing' : 'billing'}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="signing">Firma</TabsTrigger>
          <TabsTrigger value="billing">Cobro y condiciones</TabsTrigger>
          <TabsTrigger value="photos">Fotos de entrada y salida</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
        </TabsList>
        <TabsContent value="signing">
          <SigningCard contractId={c.id} />
        </TabsContent>
        <TabsContent value="billing" className="space-y-4">
          <InsuranceCard
            contractId={c.id}
            planId={c.insurancePlanId}
            planName={c.insurancePlanName}
            price={c.insurancePrice}
          />

          <DepositCard contract={c} />
          <DepositRegistryCard contract={c} />
          <IrpfRetentionCard contract={c} />
        </TabsContent>
        <TabsContent value="photos" className="space-y-4">
          <InspectionPhotosCard contractId={c.id} kind="checkin" />
          <InspectionPhotosCard contractId={c.id} kind="checkout" />
        </TabsContent>
        <TabsContent value="history">
          <Card>
            <CardHeader>
              <CardTitle>Historial del contrato</CardTitle>
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
                          ` · ${formatEur(e.payload.from as number)} → ${formatEur(e.payload.to as number)}`}
                        {e.eventType === 'note_added' &&
                        e.payload.event === 'prepay_credit_note' ? (
                          <span className="block text-muted-foreground">
                            Abono por baja anticipada ({String(e.payload.unusedMonths)} meses no
                            consumidos) en borrador ·{' '}
                            <Link
                              href={`/invoices/${String(e.payload.invoiceId)}`}
                              className="text-primary hover:underline"
                            >
                              revisar, emitir y reembolsar
                            </Link>
                          </span>
                        ) : e.eventType === 'note_added' ? (
                          <span className="block whitespace-pre-line text-muted-foreground">
                            {String(e.payload.note ?? '')}
                          </span>
                        ) : null}
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
        </TabsContent>
      </Tabs>

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

      {/* Renovar: extiende el fin del contrato N meses. */}
      <Dialog open={endOpen} onOpenChange={setEndOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Solicitar baja</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="end-date">Último día del contrato</Label>
              <Input
                id="end-date"
                type="date"
                min={c.startDate}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
              {endDate && endDate < localDateString() && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Es una fecha pasada: el contrato se cerrará en la próxima revisión diaria.
                </p>
              )}
              {endDate &&
                endDate >= localDateString() &&
                endDate <
                  localDateString(new Date(Date.now() + c.cancellationNoticeDays * 86_400_000)) && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    No respeta el preaviso del contrato ({c.cancellationNoticeDays} días).
                  </p>
                )}
              <p className="mt-1 text-xs text-muted-foreground">
                Se propone hoy más el preaviso del contrato ({c.cancellationNoticeDays} días). No se
                facturará más allá de esta fecha y, si está activada la finalización automática, el
                contrato se cerrará solo al día siguiente.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEndOpen(false)}>
              Cancelar
            </Button>
            <Button
              disabled={!endDate}
              onClick={() =>
                handle(async () => {
                  await requestEnd.mutateAsync({ id: c.id, body: { endDate } });
                  setEndOpen(false);
                }, 'Baja solicitada.')
              }
            >
              Solicitar baja
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renewOpen} onOpenChange={setRenewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renovar contrato</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Meses a añadir</Label>
              <Input
                type="number"
                min={1}
                max={60}
                value={renewMonths}
                onChange={(e) => setRenewMonths(Number(e.target.value))}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Se suma al fin actual{c.endDate ? ` (${formatDate(c.endDate)})` : ' (desde hoy)'}.
                Si el contrato está en baja, vuelve a activo.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenewOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                handle(async () => {
                  await renew.mutateAsync({ id: c.id, body: { months: renewMonths } });
                  setRenewOpen(false);
                }, 'Contrato renovado.')
              }
              disabled={renewMonths < 1}
            >
              Renovar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Traslado de trastero: reasigna la unidad. */}
      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Trasladar de trastero</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nuevo trastero (disponible)</Label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={newUnitId}
                onChange={(e) => setNewUnitId(e.target.value)}
              >
                <option value="">Elige un trastero…</option>
                {(availableUnits.data?.items ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {u.facilityName} ({formatEur(u.basePriceMonthly)}/mes)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Nueva cuota (€, opcional)</Label>
              <Input
                type="number"
                step="0.01"
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder="Dejar vacío para mantener la actual"
              />
            </div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={prorate}
                onChange={(e) => setProrate(e.target.checked)}
              />
              <span>
                Emitir factura de ajuste prorrateada (solo si la cuota nueva es mayor: cobra la
                diferencia por los días que restan del mes).
              </span>
            </label>
            <p className="text-xs text-muted-foreground">
              Libera el trastero actual y ocupa el nuevo. La próxima factura sale con el trastero (y
              precio) nuevos.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() =>
                handle(async () => {
                  await changeUnit.mutateAsync({
                    id: c.id,
                    body: {
                      newUnitId,
                      ...(newPrice.trim() ? { newPrice: Number(newPrice) } : {}),
                      ...(prorate ? { prorate: true } : {}),
                    },
                  });
                  setMoveOpen(false);
                }, 'Contrato trasladado.')
              }
              disabled={!newUnitId}
            >
              Trasladar
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

      {c.status === 'draft' && (
        <EditDraftDialog contract={c} open={editOpen} onOpenChange={setEditOpen} />
      )}

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
            {price != null && ` · ${formatEur(price)}/mes`}{' '}
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
                  {p.name} · {formatEur(p.monthlyPrice)}/mes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================================
// Aviso de overlock (expediente de impago abierto sobre el contrato)
// ============================================================================

const CASE_STATUS_TEXT: Record<string, string> = {
  open: 'Expediente abierto',
  overlocked: 'Trastero con candado (overlock)',
  final_notice: 'Requerimiento enviado',
  resolution_pending: 'Plazo vencido',
  disposal: 'En disposición',
};

function OverlockBanner({ contractId }: { contractId: string }) {
  const hasFeature = useHasFeature('collections');
  const canRead = useHasPermission('collections:read');
  const query = useContractDelinquencyCase(contractId, hasFeature && canRead);
  const c = query.data?.case;
  if (!c) return null;

  const debt = (c.debtCents / 100).toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
  });
  return (
    <Link
      href={`/collections/${c.id}`}
      className="flex items-center gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3 text-sm hover:bg-orange-100 dark:border-orange-900 dark:bg-orange-950 dark:hover:bg-orange-900"
    >
      <Lock className="size-5 shrink-0 text-orange-600 dark:text-orange-400" />
      <div className="min-w-0">
        <div className="font-medium text-orange-800 dark:text-orange-200">
          Impago en curso · {CASE_STATUS_TEXT[c.status] ?? 'Expediente'}
        </div>
        <div className="text-orange-700 dark:text-orange-300">
          Deuda viva {debt}. Ver expediente →
        </div>
      </div>
    </Link>
  );
}
