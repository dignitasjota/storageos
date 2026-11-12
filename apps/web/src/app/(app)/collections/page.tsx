'use client';

import {
  MIN_NOTICE_DAYS,
  type DelinquencyCaseDto,
  type DelinquencyCaseStatus,
} from '@storageos/shared';
import { Loader2, Lock, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { CASE_STATUS_CLASSES, CASE_STATUS_LABELS, PausedBadge, eur } from './status';

import { Can } from '@/components/auth/can';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import {
  useCollectionsCases,
  useCollectionsSettings,
  useUpdateCollectionsSettings,
} from '@/lib/collections/hooks';
import { formatDate } from '@/lib/format';

const FILTERS: { value: DelinquencyCaseStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'open', label: 'Abiertos' },
  { value: 'overlocked', label: 'Con candado' },
  { value: 'final_notice', label: 'Requerimiento' },
  { value: 'resolution_pending', label: 'Plazo vencido' },
  { value: 'contract_resolved', label: 'Contrato resuelto' },
  { value: 'goods_moved', label: 'En custodia' },
  { value: 'disposal', label: 'En disposición' },
  { value: 'closed_paid', label: 'Pagados' },
];

/** La fecha que importa en cada estado, para verlo de un vistazo. */
function caseMilestone(c: DelinquencyCaseDto): string | null {
  switch (c.status) {
    case 'open':
      return `Abierto el ${formatDate(c.openedAt)}`;
    case 'overlocked':
      return `Candado desde el ${formatDate(c.overlockedAt)}`;
    case 'final_notice':
      return c.finalNoticeDeadline ? `Plazo hasta el ${formatDate(c.finalNoticeDeadline)}` : null;
    case 'contract_resolved':
      return `Resuelto el ${formatDate(c.contractResolvedAt)}: bienes en el trastero`;
    case 'goods_moved':
      return c.abandonmentFrom
        ? `En custodia; abandono desde el ${formatDate(c.abandonmentFrom)}`
        : 'En custodia';
    default:
      return c.closedAt ? `Cerrado el ${formatDate(c.closedAt)}` : null;
  }
}

export default function CollectionsPage() {
  const [filter, setFilter] = useState<DelinquencyCaseStatus | 'all'>('all');
  const cases = useCollectionsCases(filter === 'all' ? undefined : filter);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Expedientes de impago</h1>
          <p className="text-sm text-muted-foreground">
            Los pasos de la condición 12 del contrato: aviso, candado, requerimiento, contrato
            resuelto, traslado a custodia y, solo por un cauce legal, disposición de los bienes.
            Cada paso lo das tú; la app lleva los plazos y la constancia.
          </p>
        </div>
        <Can permission="settings:manage">
          <CollectionsSettingsDialog />
        </Can>
      </div>

      {/* En el móvil, una tira que se desliza en vez de cuatro filas de botones. */}
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            className="shrink-0"
            variant={filter === f.value ? 'default' : 'outline'}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {cases.isError ? (
        <SectionError onRetry={() => void cases.refetch()} />
      ) : cases.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (cases.data ?? []).length === 0 ? (
        <p className="rounded-md border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
          No hay expedientes {filter === 'all' ? '' : 'en este estado'}.
        </p>
      ) : (
        <div className="space-y-2">
          {(cases.data ?? []).map((c) => (
            <Link
              key={c.id}
              href={`/collections/${c.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-4 py-3 transition-colors hover:bg-accent"
            >
              <div className="flex items-center gap-3">
                {c.overlockedAt && !c.status.startsWith('closed_') && (
                  <Lock className="size-4 text-orange-500" aria-label="Con candado" />
                )}
                <div>
                  <div className="font-medium">{c.customerName}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.unitCode ? `${c.unitCode} · ` : ''}
                    {c.facilityName ?? ''}
                  </div>
                  {caseMilestone(c) && (
                    <div className="text-xs text-muted-foreground">{caseMilestone(c)}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-red-600 dark:text-red-400">
                  {eur(c.debtCents)}
                </span>
                {c.deadlineExpired && (
                  <Badge variant="destructive" className="text-[10px]">
                    plazo vencido
                  </Badge>
                )}
                {c.pausedAt && <PausedBadge />}
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-medium ${CASE_STATUS_CLASSES[c.status]}`}
                >
                  {CASE_STATUS_LABELS[c.status]}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionsSettingsDialog() {
  const settings = useCollectionsSettings();
  const update = useUpdateCollectionsSettings();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [openAfter, setOpenAfter] = useState(30);
  const [noticeDays, setNoticeDays] = useState(MIN_NOTICE_DAYS);
  const [clauseRef, setClauseRef] = useState('');

  function sync() {
    if (settings.data) {
      setEnabled(settings.data.collectionsEnabled);
      setOpenAfter(settings.data.collectionsOpenAfterDays);
      setNoticeDays(settings.data.collectionsNoticeDays);
      setClauseRef(settings.data.collectionsClauseRef ?? '');
    }
  }

  const invalid =
    !(openAfter >= 8 && openAfter <= 365) || !(noticeDays >= MIN_NOTICE_DAYS && noticeDays <= 180);

  async function save() {
    if (invalid) return;
    try {
      await update.mutateAsync({
        collectionsEnabled: enabled,
        collectionsOpenAfterDays: openAfter,
        collectionsNoticeDays: noticeDays,
        collectionsClauseRef: clauseRef.trim(),
      });
      toast.success('Ajustes guardados.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) sync();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="mr-1.5 size-4" /> Ajustes
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustes de los impagos</DialogTitle>
          <DialogDescription>
            La app lleva los pasos y los plazos; la validez de cada paso depende de tu contrato y de
            tu asesoría. El requerimiento da siempre al menos {MIN_NOTICE_DAYS} días para pagar
            desde que lo recibe.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2">
            <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            <span className="text-sm">
              Abrir el expediente solo al llegar el aviso legal (si no, se te avisa para que
              decidas)
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="open-after" className="text-xs">
                Aviso legal a los (días de impago)
              </Label>
              <Input
                id="open-after"
                type="number"
                inputMode="numeric"
                min={8}
                max={365}
                value={openAfter}
                onChange={(e) => setOpenAfter(e.target.valueAsNumber || 0)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="notice-days" className="text-xs">
                Plazo del requerimiento (días)
              </Label>
              <Input
                id="notice-days"
                type="number"
                inputMode="numeric"
                min={MIN_NOTICE_DAYS}
                max={180}
                value={noticeDays}
                onChange={(e) => setNoticeDays(e.target.valueAsNumber || 0)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="clause-ref" className="text-xs">
              Cláusula de tu contrato que lo regula
            </Label>
            <Input
              id="clause-ref"
              value={clauseRef}
              onChange={(e) => setClauseRef(e.target.value)}
              placeholder="Condición 12 de las condiciones del contrato"
            />
            <p className="text-xs text-muted-foreground">
              Se cita en el requerimiento. Vacío: la condición 12 de las condiciones generales.
            </p>
          </div>
          {invalid && (
            <p className="text-xs text-red-600 dark:text-red-400">
              El aviso legal va de 8 a 365 días y el plazo del requerimiento de {MIN_NOTICE_DAYS} a
              180.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Los recordatorios, el recargo y el corte del acceso están en{' '}
            <Link
              href="/settings/dunning"
              className="font-medium underline-offset-2 hover:underline"
            >
              Configuración → Escalado de impagos
            </Link>
            .
          </p>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending || invalid}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
