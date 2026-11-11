'use client';

import { earliestMoveOutDate, monthEndOf } from '@storageos/shared';
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
import { ConditionsCard } from './conditions-card';
import { ContractBillingTab } from './contract-billing-tab';
import { DepositCard, contractDepositLabel } from './deposit-card';
import { DepositRegistryCard } from './deposit-registry-card';
import { EditDraftDialog } from './edit-draft-dialog';
import { contractEventText } from './event-text';
import { InspectionPhotosCard } from './inspection-photos-card';
import { IrpfRetentionCard } from './irpf-retention-card';
import { contractStartLabel, PreOpeningContractCard } from './pre-opening-card';
import { RetentionCard } from './retention-card';
import { SigningCard } from './signing-card';

import { useConfirm } from '@/components/confirm-provider';
import { ContractStatusBadge } from '@/components/contract-status-badge';
import { SignaturePad } from '@/components/move-in/signature-pad';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
  useCancelScheduled,
  useContract,
  useContractEvents,
  useContractSignedPdfUrl,
  useEndContract,
  useGenerateContractPdf,
  useRenewContract,
  useRequestEndContract,
  useRequestSignature,
  useContractGeneralTerms,
  useSignContract,
} from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { useUnits } from '@/lib/facilities/hooks';
import { formatDate, formatEur } from '@/lib/format';
import { useInsurancePlans, useSetContractInsurance } from '@/lib/insurance/hooks';

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
  const ask = useConfirm();

  const [priceOpen, setPriceOpen] = useState(false);
  const [priceValue, setPriceValue] = useState(0);
  const [priceReason, setPriceReason] = useState('');
  const [priceDate, setPriceDate] = useState('');
  const [priceNotify, setPriceNotify] = useState(false);
  const cancelScheduled = useCancelScheduled();
  const [endOpen, setEndOpen] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [renewOpen, setRenewOpen] = useState(false);
  const [renewMonths, setRenewMonths] = useState(12);
  const [moveOpen, setMoveOpen] = useState(false);
  const [newUnitId, setNewUnitId] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [prorate, setProrate] = useState(false);
  const [moveDate, setMoveDate] = useState('');
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
  const [signGeneralTerms, setSignGeneralTerms] = useState(false);
  const generalTerms = useContractGeneralTerms(id, signOpen);
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
              <h1 className="whitespace-nowrap font-mono text-2xl font-semibold tracking-tight">
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
                  setEndDate(
                    earliestMoveOutDate({
                      today: localDateString(),
                      noticeDays: c.cancellationNoticeDays,
                      endOfMonth: c.moveOutEndOfMonth,
                    }),
                  );
                  setEndOpen(true);
                }}
              >
                <Pause className="mr-1 h-4 w-4" /> Solicitar baja
              </Button>
            )}
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening && (
                <Button asChild>
                  <Link href={`/contracts/${c.id}/move-out`}>Gestionar la salida</Link>
                </Button>
              )}
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    const ok = await ask({
                      title: 'Finalizar el contrato',
                      description:
                        'El contrato se cierra hoy: el trastero queda libre, se retira el acceso del inquilino si no tiene otro contrato y deja de facturarse. No se puede deshacer.',
                      confirmLabel: 'Finalizar',
                      destructive: true,
                    });
                    if (ok)
                      await handle(() => end.mutateAsync({ id: c.id }), 'Contrato finalizado.');
                  }}
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
                    setPriceDate('');
                    setPriceNotify(false);
                    setPriceOpen(true);
                  }}
                >
                  Cambiar precio
                </Button>
              )}
            {(c.status === 'active' || c.status === 'ending') &&
              canManageC &&
              !pendingPreOpening &&
              !!c.endDate && (
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
                  setMoveDate('');
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
      {c.scheduledPrice && (
        <ScheduledNotice
          text={`La cuota pasa a ${formatEur(c.scheduledPrice.amount)} el ${formatDate(c.scheduledPrice.date)}.`}
          canCancel={canManageC}
          onCancel={() =>
            handle(
              () => cancelScheduled.mutateAsync({ id: c.id, what: 'price' }),
              'Cambio de cuota anulado.',
            )
          }
        />
      )}
      {c.scheduledMove && (
        <ScheduledNotice
          text={`Traslado al trastero ${c.scheduledMove.unitCode ?? ''} el ${formatDate(c.scheduledMove.date)}${c.scheduledMove.price != null ? `, con cuota de ${formatEur(c.scheduledMove.price)}` : ''}. El trastero queda reservado hasta entonces.`}
          canCancel={canManageC}
          onCancel={() =>
            handle(
              () => cancelScheduled.mutateAsync({ id: c.id, what: 'move' }),
              'Traslado anulado.',
            )
          }
        />
      )}
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
            <p className="text-xs text-muted-foreground">{contractDepositLabel(c)}</p>
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

      <Tabs
        defaultValue={
          new URLSearchParams(window.location.search).get('tab') ??
          (c.status === 'draft' ? 'signing' : 'billing')
        }
      >
        <TabsList className="flex-wrap">
          <TabsTrigger value="signing">Firma</TabsTrigger>
          <TabsTrigger value="billing">Cobro y condiciones</TabsTrigger>
          <TabsTrigger value="invoices">Facturas</TabsTrigger>
          <TabsTrigger value="photos">Fotos de entrada y salida</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
        </TabsList>
        <TabsContent value="signing">
          <SigningCard contractId={c.id} />
        </TabsContent>
        <TabsContent value="billing" className="space-y-4">
          <ConditionsCard contract={c} />
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
        <TabsContent value="invoices">
          <ContractBillingTab contractId={c.id} creditBalance={c.creditBalance} />
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
                  {events.data.map((e) => {
                    const text = contractEventText(e);
                    return (
                      <li key={e.id} className="border-l-2 border-muted pl-3">
                        <p className="text-sm">
                          <strong>{text.title}</strong>
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
                          ) : text.detail ? (
                            <span className="block whitespace-pre-line text-muted-foreground">
                              {text.detail}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(e.occurredAt).toLocaleString('es-ES')}
                          {e.createdByName && ` · ${e.createdByName}`}
                        </p>
                      </li>
                    );
                  })}
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
            <div>
              <Label>Desde (opcional)</Label>
              <Input
                type="date"
                min={localDateString()}
                value={priceDate}
                onChange={(e) => setPriceDate(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Vacío: se aplica ahora. Con una fecha futura queda programado y lo puedes anular.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={priceNotify} onCheckedChange={(v) => setPriceNotify(v === true)} />
              Avisar al inquilino por correo
            </label>
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
                    body: {
                      priceMonthly: priceValue,
                      reason: priceReason,
                      ...(priceDate ? { effectiveDate: priceDate } : {}),
                      ...(priceNotify ? { notifyCustomer: true } : {}),
                    },
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
              {c.moveOutEndOfMonth && endDate && endDate !== monthEndOf(endDate) && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  No es fin de mes: según el contrato, la baja surte efecto a final de mes. Ponla
                  solo si la habéis pactado así.
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                Se propone la primera fecha posible: hoy más el preaviso del contrato (
                {c.cancellationNoticeDays} días)
                {c.moveOutEndOfMonth ? ', llevada a final de mes' : ''}. No se facturará más allá de
                esta fecha y, si está activada la finalización automática, el contrato se cerrará
                solo al día siguiente.
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
                onChange={(e) => {
                  setNewUnitId(e.target.value);
                  const target = availableUnits.data?.items.find((u) => u.id === e.target.value);
                  if (target) setNewPrice(String(target.basePriceMonthly));
                }}
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
            <div>
              <Label>Fecha del traslado (opcional)</Label>
              <Input
                type="date"
                min={localDateString()}
                value={moveDate}
                onChange={(e) => setMoveDate(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Vacío: libera el trastero actual y ocupa el nuevo ahora. Con una fecha futura, el
              trastero nuevo queda reservado y el cambio se hace ese día. La próxima factura sale
              con el trastero (y precio) nuevos.
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
                      ...(moveDate ? { effectiveDate: moveDate } : {}),
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
          <p className="text-sm text-muted-foreground">
            {c.status === 'draft'
              ? 'El borrador se anula y, si retenía el trastero, vuelve a estar libre.'
              : 'Cancelar es para un contrato que no debía seguir (error, alta que no llegó a empezar). Si el inquilino se marcha, usa «Finalizar» o «Solicitar baja». Las facturas ya emitidas no se anulan solas.'}
          </p>
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
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={signGeneralTerms}
                onCheckedChange={(v) => setSignGeneralTerms(v === true)}
                aria-label="El inquilino acepta las condiciones generales de contratación"
              />
              <span>
                El inquilino ha leído y acepta las{' '}
                {generalTerms.data ? (
                  <a
                    href={generalTerms.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline"
                  >
                    Condiciones Generales de Contratación
                  </a>
                ) : (
                  'Condiciones Generales de Contratación'
                )}
                .
              </span>
            </label>
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
              disabled={!signDrawn || !signGeneralTerms || !generalTerms.data}
              onClick={() =>
                handle(
                  () =>
                    sign.mutateAsync({
                      id: c.id,
                      body: {
                        method: 'drawn',
                        signerName: signName || undefined,
                        signatureImage: signDrawn ?? undefined,
                        generalTermsHash: generalTerms.data?.hash,
                      },
                    }),
                  'Contrato firmado.',
                ).then(() => {
                  setSignOpen(false);
                  setSignDrawn(null);
                  setSignName('');
                  setSignGeneralTerms(false);
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

function ScheduledNotice({
  text,
  canCancel,
  onCancel,
}: {
  text: string;
  canCancel: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
      <span>{text}</span>
      {canCancel && (
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Anular
        </Button>
      )}
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
