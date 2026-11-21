'use client';

import {
  UNIT_CESSION_MAX_MONTHS,
  UNIT_CESSION_NOTICE_DAYS,
  cessionExtendedEnd,
  cessionRemainingText,
  type UnitCessionDto,
  type UnitCessionEndStatus,
  type UnitDto,
} from '@storageos/shared';
import { Eye, EyeOff, Handshake, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { useReservations } from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatEur } from '@/lib/format';
import {
  useCreateCessionAccess,
  useCreateUnitCession,
  useEndUnitCession,
  useRevealCessionCode,
  useRotateCessionCode,
  useSetCessionAccess,
  useUnitCession,
  useUnitCessionHistory,
  useUpdateUnitCession,
} from '@/lib/unit-cessions/hooks';

const MONTH_OPTIONS = [1, 2, 3, 4, 6, 9, 12, 18, 24, 36, 48, 60].filter(
  (m) => m <= UNIT_CESSION_MAX_MONTHS,
);

const END_STATUS_LABELS: Record<UnitCessionEndStatus, string> = {
  available: 'Disponible (vuelve a la venta)',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

const STATUS_NAMES: Record<string, string> = {
  available: 'disponible',
  maintenance: 'mantenimiento',
  blocked: 'bloqueado',
  occupied: 'ocupado',
  reserved: 'reservado',
  ceded: 'cedido',
};

const ACCESS_LABELS: Record<string, string> = {
  active: 'Activo',
  suspended: 'Denegado',
  revoked: 'Revocado',
  expired: 'Caducado',
  pending: 'Pendiente',
};

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.body.message : fallback;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * «Le quedan 12 días», «Vence hoy», «Vencida hace 3 días». El día de fin sigue
 * en plazo: vencida desde el día siguiente.
 */
function remainingLabel(c: UnitCessionDto): string {
  if (c.daysLeft === null) return '';
  if (c.daysLeft > 0) return `Le quedan ${plural(c.daysLeft, 'día', 'días')}`;
  if (c.daysLeft === 0) return 'Vence hoy (último día)';
  return `Vencida hace ${plural(-c.daysLeft, 'día', 'días')}`;
}

/** Color del plazo: vencida en rojo, la última semana en ámbar. */
function remainingClass(c: UnitCessionDto): string {
  if (c.expired) return 'font-medium text-rose-700 dark:text-rose-400';
  if (c.daysLeft !== null && c.daysLeft <= UNIT_CESSION_NOTICE_DAYS) {
    return 'font-medium text-amber-700 dark:text-amber-400';
  }
  return 'text-xs text-muted-foreground';
}

/** Plazo: durante N meses o hasta un día. */
function TermFields({
  mode,
  onMode,
  months,
  onMonths,
  endsOn,
  onEndsOn,
  monthsLabel,
}: {
  mode: 'months' | 'date';
  onMode: (m: 'months' | 'date') => void;
  months: number;
  onMonths: (n: number) => void;
  endsOn: string | undefined;
  onEndsOn: (d: string | undefined) => void;
  monthsLabel: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'months' ? 'default' : 'outline'}
          onClick={() => onMode('months')}
        >
          {monthsLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'date' ? 'default' : 'outline'}
          onClick={() => onMode('date')}
        >
          Hasta el día…
        </Button>
      </div>
      {mode === 'months' ? (
        <Select value={String(months)} onValueChange={(v) => onMonths(Number(v))}>
          <SelectTrigger className="w-full sm:w-48" aria-label="Meses">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTH_OPTIONS.map((m) => (
              <SelectItem key={m} value={String(m)}>
                {plural(m, 'mes', 'meses')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <DateSelect value={endsOn} onChange={onEndsOn} future years={6} />
      )}
    </div>
  );
}

/**
 * Botón «Ceder el trastero» (solo el propietario, con la función activada y el
 * trastero libre, en mantenimiento o bloqueado y sin contrato).
 */
export function CedeUnitButton({ unit, rented }: { unit: UnitDto; rented: boolean }) {
  const me = useMe();
  const enabled = useHasFeature('unit_cession');
  const isOwner = me.data?.user.role === 'owner';
  const create = useCreateUnitCession(unit.id);
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState<'person' | 'customer'>('person');
  const [holderName, setHolderName] = useState('');
  const [holderPhone, setHolderPhone] = useState('');
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [startsOn, setStartsOn] = useState<string | undefined>(localDateString());
  const [mode, setMode] = useState<'months' | 'date'>('months');
  const [months, setMonths] = useState(3);
  const [endsOn, setEndsOn] = useState<string | undefined>();
  const [notes, setNotes] = useState('');

  // Un trastero reservado para otra persona no se cede (el API lo rechaza igual).
  const reservations = useReservations({ unitId: unit.id });
  const reserved = (reservations.data ?? []).some(
    (r) => r.status === 'pending' || r.status === 'confirmed',
  );

  const cedable =
    ['available', 'maintenance', 'blocked'].includes(unit.status) && !rented && !reserved;
  if (!enabled || !isOwner || !cedable) return null;

  async function onSubmit() {
    if (who === 'person' && holderName.trim().length < 2) {
      toast.error('Escribe el nombre de la persona.');
      return;
    }
    if (who === 'customer' && !customerId) {
      toast.error('Elige el inquilino.');
      return;
    }
    if (mode === 'date' && !endsOn) {
      toast.error('Elige hasta qué día.');
      return;
    }
    try {
      await create.mutateAsync({
        ...(who === 'person'
          ? { holderName: holderName.trim(), holderPhone: holderPhone.trim() }
          : { customerId }),
        ...(startsOn ? { startsOn } : {}),
        ...(mode === 'months' ? { months } : { endsOn }),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      toast.success('Trastero cedido. El código de acceso lo ves en su ficha.');
      setOpen(false);
      setHolderName('');
      setHolderPhone('');
      setCustomerId(undefined);
      setNotes('');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo ceder el trastero.'));
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Handshake className="mr-1 h-4 w-4" /> Ceder el trastero
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Ceder el trastero {unit.code}</DialogTitle>
            <DialogDescription>
              Préstamo sin contrato, sin cobro y sin factura. Para las cifras cuenta como un
              trastero en mantenimiento.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>¿A quién?</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={who === 'person' ? 'default' : 'outline'}
                  onClick={() => setWho('person')}
                >
                  Una persona
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={who === 'customer' ? 'default' : 'outline'}
                  onClick={() => setWho('customer')}
                >
                  Un inquilino
                </Button>
              </div>
              {who === 'person' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label="Nombre"
                    placeholder="Nombre"
                    value={holderName}
                    onChange={(e) => setHolderName(e.target.value)}
                    maxLength={120}
                  />
                  <Input
                    aria-label="Teléfono (opcional)"
                    placeholder="Teléfono (opcional)"
                    value={holderPhone}
                    onChange={(e) => setHolderPhone(e.target.value)}
                    inputMode="tel"
                    maxLength={30}
                  />
                </div>
              ) : (
                <CustomerSearchSelect value={customerId} onChange={setCustomerId} />
              )}
            </div>
            <div className="space-y-1">
              <Label>Desde</Label>
              {/* Cedido desde ya: el inicio es hoy o un día anterior. */}
              <DateSelect
                value={startsOn}
                onChange={setStartsOn}
                years={3}
                max={localDateString()}
              />
            </div>
            <div className="space-y-1">
              <Label>Plazo</Label>
              <TermFields
                mode={mode}
                onMode={setMode}
                months={months}
                onMonths={setMonths}
                endsOn={endsOn}
                onEndsOn={setEndsOn}
                monthsLabel="Durante…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cession-notes">Notas (opcional)</Label>
              <Textarea
                id="cession-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={2}
              />
            </div>
            <p className="rounded-md border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200">
              No se le enviará nada: el código de acceso lo verás aquí para dárselo en mano.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void onSubmit()} disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
              Ceder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Tarjetas de un trastero cedido: la cesión, su acceso y las cesiones anteriores. */
export function UnitCessionSection({ unit }: { unit: UnitDto }) {
  const isCeded = unit.status === 'ceded';
  const cession = useUnitCession(unit.id, isCeded);
  const history = useUnitCessionHistory(unit.id);
  const past = (history.data ?? []).filter((c) => c.endedAt !== null);

  return (
    <>
      {isCeded && cession.data && <CessionCard unit={unit} cession={cession.data} />}
      {isCeded && cession.data && hasLiveAccess(cession.data) && (
        <CessionAccessCard unit={unit} cession={cession.data} />
      )}
      {isCeded && cession.data && !hasLiveAccess(cession.data) && (
        <CreateCessionAccess unit={unit} />
      )}
      {past.length > 0 && <PastCessions items={past} />}
    </>
  );
}

/** La cesión tiene un código que abre (o que está denegado, pero vivo). */
function hasLiveAccess(c: UnitCessionDto): boolean {
  return !!c.access && ['active', 'suspended', 'pending'].includes(c.access.status);
}

/**
 * Cesión sin acceso (se cedió sin control de accesos o el código se perdió):
 * el propietario lo crea aquí si el negocio tiene control de accesos.
 */
function CreateCessionAccess({ unit }: { unit: UnitDto }) {
  const me = useMe();
  const isOwner = me.data?.user.role === 'owner';
  const accessControl = useHasFeature('access_control');
  const create = useCreateCessionAccess(unit.id);
  if (!isOwner || !accessControl) return null;

  async function onCreate() {
    try {
      await create.mutateAsync();
      toast.success('Acceso creado. Pulsa «Ver código» para dárselo en mano.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear el acceso.'));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" />
          Acceso de la cesión
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Esta cesión no tiene código de acceso. Puedes crearle uno: solo abre este trastero y no se
          envía a nadie.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onCreate()}
          disabled={create.isPending}
        >
          {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
          Crear acceso
        </Button>
      </CardContent>
    </Card>
  );
}

function CessionCard({ unit, cession }: { unit: UnitDto; cession: UnitCessionDto }) {
  const me = useMe();
  const isOwner = me.data?.user.role === 'owner';
  const enabled = useHasFeature('unit_cession');
  const [extendOpen, setExtendOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const expired = cession.expired;

  return (
    <Card className="border-violet-200 dark:border-violet-900">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake className="size-4 text-violet-600 dark:text-violet-400" />
          Cesión
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Cedido a</p>
            {cession.customerId ? (
              <Link
                href={`/customers/${cession.customerId}`}
                className="font-medium hover:underline"
              >
                {cession.holderName}
              </Link>
            ) : (
              <p className="font-medium">{cession.holderName}</p>
            )}
            {cession.holderPhone && (
              <a href={`tel:${cession.holderPhone}`} className="text-xs text-muted-foreground">
                {cession.holderPhone}
              </a>
            )}
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Desde · hasta</p>
            <p className="font-medium">
              {formatDate(cession.startsOn)} · {formatDate(cession.endsOn)}
            </p>
            <p className={remainingClass(cession)}>{remainingLabel(cession)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Precio del trastero</p>
            <p className="font-medium">{formatEur(cession.unitPriceMonthly)} /mes sin IVA</p>
            <p className="text-xs text-muted-foreground">Como referencia: no se cobra.</p>
          </div>
        </div>
        {expired && (
          <p className="rounded-md border border-rose-300 bg-rose-50 p-3 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
            La cesión ha vencido. El trastero sigue cedido y su acceso activo hasta que la amplíes o
            la termines.
          </p>
        )}
        {cession.notes && (
          <p className="whitespace-pre-line text-muted-foreground">{cession.notes}</p>
        )}
        {!enabled && (
          <p className="text-xs text-muted-foreground">
            Los trasteros cedidos ya no están activados en tu cuenta: puedes terminar esta cesión y
            gestionar su acceso, pero no ampliarla.
          </p>
        )}
        {isOwner && (
          <div className="flex flex-wrap gap-2">
            {enabled && (
              <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)}>
                Ampliar
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              Editar
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEndOpen(true)}>
              Terminar la cesión
            </Button>
          </div>
        )}
      </CardContent>
      <ExtendDialog
        key={`extend-${cession.endsOn}-${String(extendOpen)}`}
        unitId={unit.id}
        cession={cession}
        open={extendOpen}
        onOpenChange={setExtendOpen}
      />
      <EditDialog
        key={`edit-${String(editOpen)}`}
        unitId={unit.id}
        cession={cession}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <EndDialog unit={unit} cession={cession} open={endOpen} onOpenChange={setEndOpen} />
    </Card>
  );
}

function ExtendDialog({
  unitId,
  cession,
  open,
  onOpenChange,
}: {
  unitId: string;
  cession: UnitCessionDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateUnitCession(unitId);
  const [mode, setMode] = useState<'months' | 'date'>('months');
  const [months, setMonths] = useState(3);
  const [endsOn, setEndsOn] = useState<string | undefined>(cession.endsOn);
  // Los meses cuentan desde la fecha de fin; si ya había vencido, desde hoy.
  const today = localDateString();
  const fromToday = cession.endsOn < today;
  const preview = cessionExtendedEnd(today, cession.endsOn, months);

  async function onSubmit() {
    if (mode === 'date' && !endsOn) {
      toast.error('Elige la nueva fecha de fin.');
      return;
    }
    try {
      await update.mutateAsync(mode === 'months' ? { months } : { endsOn });
      toast.success('Cesión ampliada.');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo ampliar la cesión.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ampliar la cesión</DialogTitle>
          <DialogDescription>
            {fromToday
              ? `Venció el ${formatDate(cession.endsOn)}. Los meses cuentan desde hoy porque ya había vencido.`
              : `Ahora vence el ${formatDate(cession.endsOn)}. Los meses se suman a esa fecha.`}
          </DialogDescription>
        </DialogHeader>
        <TermFields
          mode={mode}
          onMode={setMode}
          months={months}
          onMonths={setMonths}
          endsOn={endsOn}
          onEndsOn={setEndsOn}
          monthsLabel="Meses más…"
        />
        {mode === 'months' && (
          <p className="text-sm text-muted-foreground">
            Vencerá el {formatDate(preview)}
            {fromToday ? ' (cuenta desde hoy porque ya había vencido)' : ''}.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void onSubmit()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  unitId,
  cession,
  open,
  onOpenChange,
}: {
  unitId: string;
  cession: UnitCessionDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const update = useUpdateUnitCession(unitId);
  const [holderName, setHolderName] = useState(cession.holderName);
  const [holderPhone, setHolderPhone] = useState(cession.holderPhone ?? '');
  const [customerId, setCustomerId] = useState<string | undefined>(cession.customerId ?? undefined);
  const [notes, setNotes] = useState(cession.notes ?? '');

  async function onSubmit() {
    if (!customerId && holderName.trim().length < 2) {
      toast.error('Escribe el nombre de la persona.');
      return;
    }
    try {
      await update.mutateAsync({
        holderName: holderName.trim(),
        holderPhone: holderPhone.trim(),
        customerId: customerId ?? null,
        notes: notes.trim(),
      });
      toast.success('Cesión guardada.');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar la cesión</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="cession-name">Nombre</Label>
              <Input
                id="cession-name"
                value={holderName}
                onChange={(e) => setHolderName(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cession-phone">Teléfono</Label>
              <Input
                id="cession-phone"
                value={holderPhone}
                onChange={(e) => setHolderPhone(e.target.value)}
                inputMode="tel"
                maxLength={30}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Inquilino enlazado (opcional)</Label>
            <CustomerSearchSelect
              value={customerId}
              onChange={setCustomerId}
              clearLabel="Sin inquilino"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cession-edit-notes">Notas</Label>
            <Textarea
              id="cession-edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void onSubmit()} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EndDialog({
  unit,
  cession,
  open,
  onOpenChange,
}: {
  unit: UnitDto;
  cession: UnitCessionDto;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const end = useEndUnitCession(unit.id);
  const confirm = useConfirm();
  const [status, setStatus] = useState<UnitCessionEndStatus>('available');
  const [reason, setReason] = useState('');

  async function onSubmit() {
    const remaining = cessionRemainingText(localDateString(), cession.endsOn);
    if (remaining && cession.daysLeft !== null && cession.daysLeft > 0) {
      const ok = await confirm({
        title: '¿Terminar la cesión antes de tiempo?',
        description: `Le quedan ${remaining}. ¿Seguro?`,
        confirmLabel: 'Terminar la cesión',
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      await end.mutateAsync({ status, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      toast.success(
        cession.access ? 'Cesión terminada y su acceso revocado.' : 'Cesión terminada.',
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo terminar la cesión.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Terminar la cesión</DialogTitle>
          <DialogDescription>
            {cession.access
              ? 'El código de acceso deja de abrir y el trastero queda en el estado que elijas.'
              : 'El trastero queda en el estado que elijas.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>El trastero queda</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as UnitCessionEndStatus)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(END_STATUS_LABELS) as UnitCessionEndStatus[]).map((s) => (
                  <SelectItem key={s} value={s}>
                    {END_STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Antes de cederlo estaba {STATUS_NAMES[cession.previousUnitStatus] ?? 'disponible'}.
            </p>
          </div>
          {status !== 'available' && (
            <div className="space-y-1">
              <Label htmlFor="cession-end-reason">Motivo</Label>
              <Input
                id="cession-end-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void onSubmit()} disabled={end.isPending}>
            {end.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Terminar la cesión
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CessionAccessCard({ unit, cession }: { unit: UnitDto; cession: UnitCessionDto }) {
  const me = useMe();
  const isOwner = me.data?.user.role === 'owner';
  const reveal = useRevealCessionCode(unit.id);
  const rotate = useRotateCessionCode(unit.id);
  const setAccess = useSetCessionAccess(unit.id);
  const confirm = useConfirm();
  const [code, setCode] = useState<string | null>(null);
  const access = cession.access!;
  const suspended = access.status === 'suspended';

  async function onReveal() {
    if (code) {
      setCode(null);
      return;
    }
    try {
      setCode((await reveal.mutateAsync()).code);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo mostrar el código.'));
    }
  }

  async function onRotate() {
    const ok = await confirm({
      title: '¿Cambiar el código?',
      description: 'El código actual deja de abrir. Tendrás que darle el nuevo en mano.',
      confirmLabel: 'Cambiar el código',
    });
    if (!ok) return;
    try {
      setCode((await rotate.mutateAsync()).code);
      toast.success('Código cambiado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el código.'));
    }
  }

  async function onToggle() {
    try {
      await setAccess.mutateAsync(suspended ? 'resume' : 'suspend');
      toast.success(suspended ? 'Acceso permitido.' : 'Acceso denegado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el acceso.'));
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" />
          Acceso de la cesión
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          Estado:{' '}
          <span
            className={suspended ? 'font-medium text-rose-700 dark:text-rose-400' : 'font-medium'}
          >
            {ACCESS_LABELS[access.status] ?? access.status}
          </span>
          <span className="text-muted-foreground">
            {' '}
            · solo este trastero, sin caducidad hasta terminar la cesión
          </span>
        </p>
        {code && (
          <p className="font-mono text-2xl font-semibold tracking-widest" aria-live="polite">
            {code}
          </p>
        )}
        {isOwner ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onReveal()}
              disabled={reveal.isPending}
            >
              {code ? <EyeOff className="mr-1 size-4" /> : <Eye className="mr-1 size-4" />}
              {code ? 'Ocultar código' : 'Ver código'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onRotate()}
              disabled={rotate.isPending}
            >
              <RefreshCw className="mr-1 size-4" /> Cambiar el código
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onToggle()}
              disabled={setAccess.isPending}
            >
              {suspended ? 'Permitir el acceso' : 'Denegar el acceso'}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            El código y el acceso los gestiona el propietario de la cuenta.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PastCessions({ items }: { items: UnitCessionDto[] }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Cesiones anteriores ({items.length})
          </summary>
          <ul className="mt-3 space-y-2 text-sm">
            {items.map((c) => (
              <li key={c.id} className="border-b pb-2 last:border-0">
                <p className="font-medium">
                  {c.customerId ? (
                    <Link href={`/customers/${c.customerId}`} className="hover:underline">
                      {c.holderName}
                    </Link>
                  ) : (
                    c.holderName
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(c.startsOn)} – {formatDate(c.endsOn)}
                  {c.endedAt && ` · terminada el ${formatDate(c.endedAt)}`}
                  {c.endedByName && ` por ${c.endedByName}`}
                </p>
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
