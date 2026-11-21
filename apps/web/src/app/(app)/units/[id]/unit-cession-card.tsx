'use client';

import {
  UNIT_CESSION_DEFAULT_REVIEW_MONTHS,
  UNIT_CESSION_IDLE_DAYS,
  UNIT_CESSION_MAX_CODES,
  UNIT_CESSION_MAX_MONTHS,
  UNIT_CESSION_NOTICE_DAYS,
  UNIT_CESSION_NOTICE_DAYS_OPTIONS,
  UNIT_CESSION_REVIEW_MONTHS_OPTIONS,
  UNIT_CESSION_SNOOZE_DAYS_OPTIONS,
  cessionExtendedEnd,
  cessionRemainingText,
  type UnitCessionAccessDto,
  type UnitCessionDto,
  type UnitCessionEndStatus,
  type UnitDto,
} from '@storageos/shared';
import {
  BellOff,
  Eye,
  EyeOff,
  FileSignature,
  Handshake,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import {
  useCessionToContract,
  useCreateCessionAccess,
  useCreateCessionCode,
  useCreateUnitCession,
  useEndUnitCession,
  useRemoveCessionCode,
  useRevealCessionCodeOf,
  useRotateCessionCodeOf,
  useSetCessionCodeAccess,
  useSnoozeCession,
  useUnitCession,
  useUnitCessionHistory,
  useUpdateCessionCode,
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
export function remainingLabel(c: UnitCessionDto): string {
  if (c.endedAt) return '';
  if (c.endsOn === null) return 'Sin fecha de fin';
  if (c.daysLeft === null) return '';
  if (c.daysLeft > 0) return `Le quedan ${plural(c.daysLeft, 'día', 'días')}`;
  if (c.daysLeft === 0) return 'Vence hoy (último día)';
  return `Vencida hace ${plural(-c.daysLeft, 'día', 'días')}`;
}

/** Color del plazo: vencida en rojo, dentro del plazo de aviso en ámbar. */
export function remainingClass(c: UnitCessionDto): string {
  if (c.expired) return 'font-medium text-rose-700 dark:text-rose-400';
  if (c.daysLeft !== null && c.daysLeft <= c.noticeDays) {
    return 'font-medium text-amber-700 dark:text-amber-400';
  }
  return 'text-xs text-muted-foreground';
}

type TermMode = 'months' | 'date' | 'open';

const NOTICE_LABELS: Record<number, string> = {
  0: 'El mismo día que vence',
  3: '3 días antes',
  7: '7 días antes',
  15: '15 días antes',
  30: '30 días antes',
};

/** Plazo: durante N meses, hasta un día o sin fecha de fin. */
function TermFields({
  mode,
  onMode,
  months,
  onMonths,
  endsOn,
  onEndsOn,
  monthsLabel,
  reviewEvery,
  onReviewEvery,
  allowOpen = true,
}: {
  mode: TermMode;
  onMode: (m: TermMode) => void;
  months: number;
  onMonths: (n: number) => void;
  endsOn: string | undefined;
  onEndsOn: (d: string | undefined) => void;
  monthsLabel: string;
  reviewEvery: number;
  onReviewEvery: (n: number) => void;
  allowOpen?: boolean;
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
        {allowOpen && (
          <Button
            type="button"
            size="sm"
            variant={mode === 'open' ? 'default' : 'outline'}
            onClick={() => onMode('open')}
          >
            Sin fecha de fin
          </Button>
        )}
      </div>
      {mode === 'months' && (
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
      )}
      {mode === 'date' && <DateSelect value={endsOn} onChange={onEndsOn} future years={6} />}
      {mode === 'open' && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            No vence nunca. Te recordaremos que sigue cedido para que decidas si continúa.
          </p>
          <ReviewEverySelect value={reviewEvery} onChange={onReviewEvery} />
        </div>
      )}
    </div>
  );
}

function ReviewEverySelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="w-full sm:w-64" aria-label="Recordármelo cada">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {UNIT_CESSION_REVIEW_MONTHS_OPTIONS.map((m) => (
          <SelectItem key={m} value={String(m)}>
            Recordármelo cada {plural(m, 'mes', 'meses')}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** «Avisarme N días antes» (el día de fin, 3, 7, 15 o 30 días antes). */
function NoticeDaysSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1">
      <Label>Avisarme</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="w-full sm:w-64" aria-label="Avisarme">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {UNIT_CESSION_NOTICE_DAYS_OPTIONS.map((d) => (
            <SelectItem key={d} value={String(d)}>
              {NOTICE_LABELS[d] ?? `${d} días antes`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
  const [mode, setMode] = useState<TermMode>('months');
  const [months, setMonths] = useState(3);
  const [endsOn, setEndsOn] = useState<string | undefined>();
  const [reviewEvery, setReviewEvery] = useState<number>(UNIT_CESSION_DEFAULT_REVIEW_MONTHS);
  const [noticeDays, setNoticeDays] = useState<number>(UNIT_CESSION_NOTICE_DAYS);
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
        ...(mode === 'months'
          ? { months, noticeDays }
          : mode === 'date'
            ? { endsOn, noticeDays }
            : { openEnded: true, reviewEveryMonths: reviewEvery }),
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
                reviewEvery={reviewEvery}
                onReviewEvery={setReviewEvery}
              />
            </div>
            {mode !== 'open' && <NoticeDaysSelect value={noticeDays} onChange={setNoticeDays} />}
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
  return c.codes.length > 0;
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
  const router = useRouter();
  const confirm = useConfirm();
  const toContract = useCessionToContract(unit.id);
  const [extendOpen, setExtendOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const expired = cession.expired;

  async function onToContract() {
    const ok = await confirm({
      title: '¿Pasar la cesión a contrato?',
      description: `Se termina la cesión, ${
        cession.codes.length > 0 ? 'su código deja de abrir ' : ''
      }y el trastero queda disponible para hacerle el contrato${
        cession.customerName ? ` a ${cession.customerName}` : ''
      }. No se avisa a la lista de espera. Después se abre el contrato nuevo con el trastero ya elegido.`,
      confirmLabel: 'Pasar a contrato',
    });
    if (!ok) return;
    try {
      const res = await toContract.mutateAsync();
      toast.success('Cesión terminada. Completa el contrato.');
      router.push(res.url);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo pasar a contrato.'));
    }
  }

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
              {formatDate(cession.startsOn)} ·{' '}
              {cession.endsOn ? formatDate(cession.endsOn) : 'sin fecha de fin'}
            </p>
            <p className={remainingClass(cession)}>{remainingLabel(cession)}</p>
            <p className="text-xs text-muted-foreground">
              {cession.endsOn === null
                ? `Te lo recordamos cada ${plural(cession.reviewEveryMonths ?? UNIT_CESSION_DEFAULT_REVIEW_MONTHS, 'mes', 'meses')}`
                : `Avisa ${(NOTICE_LABELS[cession.noticeDays] ?? `${cession.noticeDays} días antes`).toLowerCase()}`}
            </p>
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
            {cession.snoozedUntil &&
              ` Aviso pospuesto hasta el ${formatDate(cession.snoozedUntil)}.`}
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
            {expired && !cession.snoozedUntil && (
              <Button size="sm" variant="outline" onClick={() => setSnoozeOpen(true)}>
                <BellOff className="mr-1 size-4" /> Posponer el aviso
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onToContract()}
              disabled={toContract.isPending}
            >
              <FileSignature className="mr-1 size-4" /> Pasar a contrato
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEndOpen(true)}>
              Terminar la cesión
            </Button>
          </div>
        )}
      </CardContent>
      <ExtendDialog
        key={`extend-${cession.endsOn ?? 'open'}-${String(extendOpen)}`}
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
      <SnoozeDialog unitId={unit.id} open={snoozeOpen} onOpenChange={setSnoozeOpen} />
    </Card>
  );
}

/** Pospone 7 o 30 días el aviso de una cesión vencida (no cambia la fecha). */
function SnoozeDialog({
  unitId,
  open,
  onOpenChange,
}: {
  unitId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const snooze = useSnoozeCession();
  async function onSnooze(days: number) {
    try {
      await snooze.mutateAsync({ unitId, days });
      toast.success(`Aviso pospuesto ${plural(days, 'día', 'días')}.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo posponer el aviso.'));
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Posponer el aviso</DialogTitle>
          <DialogDescription>
            La cesión sale de «Cesiones vencidas» de «Hoy» y no te volvemos a avisar hasta que pasen
            esos días. La fecha de fin no cambia; si la amplías o la terminas, se quita.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          {UNIT_CESSION_SNOOZE_DAYS_OPTIONS.map((d) => (
            <Button key={d} onClick={() => void onSnooze(d)} disabled={snooze.isPending}>
              {plural(d, 'día', 'días')}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [mode, setMode] = useState<TermMode>('months');
  const [months, setMonths] = useState(3);
  const [endsOn, setEndsOn] = useState<string | undefined>(cession.endsOn ?? undefined);
  const [reviewEvery, setReviewEvery] = useState<number>(
    cession.reviewEveryMonths ?? UNIT_CESSION_DEFAULT_REVIEW_MONTHS,
  );
  // Los meses cuentan desde la fecha de fin; si ya había vencido (o no tenía
  // fecha), desde hoy.
  const today = localDateString();
  const fromToday = cession.endsOn === null || cession.endsOn < today;
  const preview = cessionExtendedEnd(today, cession.endsOn, months);

  async function onSubmit() {
    if (mode === 'date' && !endsOn) {
      toast.error('Elige la nueva fecha de fin.');
      return;
    }
    try {
      await update.mutateAsync(
        mode === 'months'
          ? { months }
          : mode === 'date'
            ? { endsOn }
            : { openEnded: true, reviewEveryMonths: reviewEvery },
      );
      toast.success(mode === 'open' ? 'La cesión ya no tiene fecha de fin.' : 'Cesión ampliada.');
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo ampliar la cesión.'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {cession.endsOn === null ? 'Ponerle fecha de fin' : 'Ampliar la cesión'}
          </DialogTitle>
          <DialogDescription>
            {cession.endsOn === null
              ? 'Ahora no tiene fecha de fin. Los meses cuentan desde hoy.'
              : fromToday
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
          reviewEvery={reviewEvery}
          onReviewEvery={setReviewEvery}
          allowOpen={cession.endsOn !== null}
        />
        {mode === 'months' && (
          <p className="text-sm text-muted-foreground">
            Vencerá el {formatDate(preview)}
            {fromToday && cession.endsOn !== null
              ? ' (cuenta desde hoy porque ya había vencido)'
              : ''}
            .
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
  const [noticeDays, setNoticeDays] = useState<number>(cession.noticeDays);
  const [reviewEvery, setReviewEvery] = useState<number>(
    cession.reviewEveryMonths ?? UNIT_CESSION_DEFAULT_REVIEW_MONTHS,
  );
  const openEnded = cession.endsOn === null;

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
        ...(openEnded
          ? reviewEvery !== cession.reviewEveryMonths
            ? { reviewEveryMonths: reviewEvery }
            : {}
          : noticeDays !== cession.noticeDays
            ? { noticeDays }
            : {}),
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
          {openEnded ? (
            <div className="space-y-1">
              <Label>Sin fecha de fin</Label>
              <ReviewEverySelect value={reviewEvery} onChange={setReviewEvery} />
            </div>
          ) : (
            <NoticeDaysSelect value={noticeDays} onChange={setNoticeDays} />
          )}
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
        cession.codes.length > 0 ? 'Cesión terminada y su acceso revocado.' : 'Cesión terminada.',
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
            {cession.codes.length > 0
              ? 'Sus códigos de acceso dejan de abrir y el trastero queda en el estado que elijas.'
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

/**
 * «Entró por última vez el 12/11/2026 a las 18:20», «Aún no ha entrado» y, si
 * lleva más de 60 días sin entrar, en ámbar.
 */
export function lastEntryText(lastUsedAt: string | null): { text: string; idle: boolean } {
  if (!lastUsedAt) return { text: 'Aún no ha entrado', idle: false };
  const at = new Date(lastUsedAt);
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days > UNIT_CESSION_IDLE_DAYS) {
    return { text: `No ha entrado en ${days} días`, idle: true };
  }
  const time = at.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  return { text: `Entró por última vez el ${formatDate(at)} a las ${time}`, idle: false };
}

function CessionAccessCard({ unit, cession }: { unit: UnitDto; cession: UnitCessionDto }) {
  const me = useMe();
  const isOwner = me.data?.user.role === 'owner';
  const createCode = useCreateCessionCode(unit.id);
  const [newCode, setNewCode] = useState<{ credentialId: string; code: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const last = lastEntryText(cession.access?.lastUsedAt ?? null);
  const codes = cession.codes;

  async function onAdd() {
    try {
      const created = await createCode.mutateAsync(label.trim() ? { label: label.trim() } : {});
      setNewCode(created);
      setAdding(false);
      setLabel('');
      toast.success('Código creado. Dáselo en mano.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear el código.'));
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
        <p
          className={
            last.idle ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
          }
        >
          {last.text}
        </p>
        <p className="text-xs text-muted-foreground">
          Solo este trastero, sin caducidad hasta terminar la cesión. Al terminarla dejan de abrir
          todos sus códigos.
        </p>
        <ul className="space-y-3">
          {codes.map((c) => (
            <CessionCodeRow
              key={c.credentialId}
              unitId={unit.id}
              code={c}
              isOwner={isOwner}
              revealed={newCode?.credentialId === c.credentialId ? newCode.code : null}
            />
          ))}
        </ul>
        {isOwner ? (
          codes.length < UNIT_CESSION_MAX_CODES &&
          (adding ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Para quién (opcional)"
                placeholder="Para quién (opcional)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={60}
                className="w-full sm:w-64"
              />
              <Button size="sm" onClick={() => void onAdd()} disabled={createCode.isPending}>
                {createCode.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
                Crear el código
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
                Cancelar
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="mr-1 size-4" /> Añadir otro código
            </Button>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            El código y el acceso los gestiona el propietario de la cuenta.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Un código de la cesión: verlo, cambiarlo, denegarlo o permitirlo, 24 h y quitarlo. */
function CessionCodeRow({
  unitId,
  code: c,
  isOwner,
  revealed,
}: {
  unitId: string;
  code: UnitCessionAccessDto;
  isOwner: boolean;
  revealed: string | null;
}) {
  const reveal = useRevealCessionCodeOf(unitId);
  const rotate = useRotateCessionCodeOf(unitId);
  const setAccess = useSetCessionCodeAccess(unitId);
  const update = useUpdateCessionCode(unitId);
  const remove = useRemoveCessionCode(unitId);
  const confirm = useConfirm();
  const [shown, setShown] = useState<string | null>(revealed);
  const suspended = c.status === 'suspended';
  const last = lastEntryText(c.lastUsedAt);
  // El principal va por los endpoints de siempre; los demás, por su id.
  const id = c.primary ? null : c.credentialId;

  async function onReveal() {
    if (shown) {
      setShown(null);
      return;
    }
    try {
      setShown((await reveal.mutateAsync(id)).code);
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
      setShown((await rotate.mutateAsync(id)).code);
      toast.success('Código cambiado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el código.'));
    }
  }

  async function onToggle() {
    try {
      await setAccess.mutateAsync({ credentialId: id, action: suspended ? 'resume' : 'suspend' });
      toast.success(suspended ? 'Acceso permitido.' : 'Acceso denegado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el acceso.'));
    }
  }

  async function onBypass(on: boolean) {
    try {
      await update.mutateAsync({ credentialId: id, input: { bypassCurfew: on } });
      toast.success(on ? 'Puede entrar a cualquier hora.' : 'Entra en el horario del local.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo cambiar el horario.'));
    }
  }

  async function onRemove() {
    const ok = await confirm({
      title: '¿Quitar este código?',
      description: 'Deja de abrir. Los demás códigos de la cesión siguen igual.',
      confirmLabel: 'Quitar el código',
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(c.credentialId);
      toast.success('Código quitado.');
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo quitar el código.'));
    }
  }

  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {c.primary ? 'Código principal' : (c.label ?? 'Otro código')}
          <span
            className={
              suspended ? 'ml-2 text-rose-700 dark:text-rose-400' : 'ml-2 text-muted-foreground'
            }
          >
            {ACCESS_LABELS[c.status] ?? c.status}
          </span>
        </p>
        <p
          className={
            last.idle
              ? 'text-xs font-medium text-amber-700 dark:text-amber-400'
              : 'text-xs text-muted-foreground'
          }
        >
          {last.text}
        </p>
      </div>
      {shown && (
        <p className="font-mono text-2xl font-semibold tracking-widest" aria-live="polite">
          {shown}
        </p>
      )}
      {isOwner && (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={c.bypassCurfew}
              disabled={update.isPending}
              onCheckedChange={(v) => void onBypass(v === true)}
            />
            Acceso 24 h (sin el toque de queda del local)
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void onReveal()}
              disabled={reveal.isPending}
            >
              {shown ? <EyeOff className="mr-1 size-4" /> : <Eye className="mr-1 size-4" />}
              {shown ? 'Ocultar código' : 'Ver código'}
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
            {!c.primary && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onRemove()}
                disabled={remove.isPending}
              >
                <Trash2 className="mr-1 size-4" /> Quitar
              </Button>
            )}
          </div>
        </>
      )}
    </li>
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
                  {formatDate(c.startsOn)} – {c.endsOn ? formatDate(c.endsOn) : 'sin fecha de fin'}
                  {c.endedAt && ` · terminada el ${formatDateTime(c.endedAt)}`}
                  {c.endedByName && ` por ${c.endedByName}`}
                  {c.endedReason && ` · ${c.endedReason}`}
                </p>
              </li>
            ))}
          </ul>
        </details>
      </CardContent>
    </Card>
  );
}
