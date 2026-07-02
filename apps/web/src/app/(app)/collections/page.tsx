'use client';

import { Loader2, Lock, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { CASE_STATUS_CLASSES, CASE_STATUS_LABELS, eur } from './status';

import type { DelinquencyCaseStatus } from '@storageos/shared';

import { Can } from '@/components/auth/can';
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

const FILTERS: { value: DelinquencyCaseStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'open', label: 'Abiertos' },
  { value: 'overlocked', label: 'Con candado' },
  { value: 'final_notice', label: 'Requerimiento' },
  { value: 'resolution_pending', label: 'Plazo vencido' },
  { value: 'disposal', label: 'En disposición' },
];

export default function CollectionsPage() {
  const [filter, setFilter] = useState<DelinquencyCaseStatus | 'all'>('all');
  const cases = useCollectionsCases(filter === 'all' ? undefined : filter);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Expedientes de impago</h1>
          <p className="text-sm text-muted-foreground">
            Overlock (candado) → requerimiento → disposición. El sistema orquesta el expediente; la
            validez del procedimiento depende de tu contrato y asesoría.
          </p>
        </div>
        <Can permission="settings:manage">
          <CollectionsSettingsDialog />
        </Can>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={filter === f.value ? 'default' : 'outline'}
            onClick={() => setFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {cases.isLoading ? (
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
                {c.overlockedAt && <Lock className="size-4 text-orange-500" />}
                <div>
                  <div className="font-medium">{c.customerName}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.unitCode ? `${c.unitCode} · ` : ''}
                    {c.facilityName ?? ''}
                  </div>
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
  const [noticeDays, setNoticeDays] = useState(15);
  const [clauseRef, setClauseRef] = useState('');

  function sync() {
    if (settings.data) {
      setEnabled(settings.data.collectionsEnabled);
      setOpenAfter(settings.data.collectionsOpenAfterDays);
      setNoticeDays(settings.data.collectionsNoticeDays);
      setClauseRef(settings.data.collectionsClauseRef ?? '');
    }
  }

  async function save() {
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
          <Settings2 className="mr-1.5 size-4" /> Ajustes de impagos
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Impagos físicos (overlock)</DialogTitle>
          <DialogDescription>
            Herramienta de gestión y trazabilidad. La validez del overlock y de cualquier
            disposición depende de tu contrato de alquiler y de tu asesoría legal. Los plazos son
            orientativos: ajústalos a lo que estipule tu contrato.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2">
            <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
            <span className="text-sm">
              Abrir expediente automáticamente cuando el dunning llega a +30 días
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Abrir tras (días de impago)</Label>
              <Input
                type="number"
                value={openAfter}
                onChange={(e) => setOpenAfter(e.target.valueAsNumber || 0)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Plazo del requerimiento (días)</Label>
              <Input
                type="number"
                value={noticeDays}
                onChange={(e) => setNoticeDays(e.target.valueAsNumber || 0)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Referencia de la cláusula del contrato</Label>
            <Input
              value={clauseRef}
              onChange={(e) => setClauseRef(e.target.value)}
              placeholder="Ej. Cláusula 9 (impago y retención)"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
