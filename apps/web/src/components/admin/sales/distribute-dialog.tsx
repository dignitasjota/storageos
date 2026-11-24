'use client';

import {
  SALES_BATCH_MAX,
  SALES_DISTRIBUTION_MODE_LABELS,
  SALES_DISTRIBUTION_ROW_STATUS_LABELS,
  type SalesDistributionMode,
  type SalesDistributionResultDto,
  type SalesDistributionRowStatus,
} from '@storageos/shared';
import { Loader2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { errorText, Field } from '@/components/admin/sales/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useDistributeImport,
  useDistributeLeads,
  useSalesTeam,
} from '@/lib/admin/sales-team-hooks';
import { plural } from '@/lib/format';
import { readImportFile } from '@/lib/import-file';
import { cn } from '@/lib/utils';

type Source = { kind: 'file' } | { kind: 'leads'; leadIds: string[] };

const STATUS_STYLE: Record<SalesDistributionRowStatus, string> = {
  new: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  assign:
    'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300',
  taken:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  customer: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  error:
    'border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300',
};

/**
 * Repartir prospectos entre comerciales: de un fichero (CSV o Excel) o los
 * leads elegidos en la lista. Primero la vista previa (qué pasa con cada uno y
 * a quién va) y después «Repartir».
 */
export function DistributeDialog({
  source,
  defaultRepId,
  onClose,
  onDone,
}: {
  source: Source;
  defaultRepId?: string;
  onClose: () => void;
  onDone?: (res: SalesDistributionResultDto) => void;
}) {
  const team = useSalesTeam();
  const importer = useDistributeImport();
  const distributor = useDistributeLeads();
  const reps = useMemo(() => (team.data?.reps ?? []).filter((r) => r.isActive), [team.data]);
  const isFile = source.kind === 'file';
  const [file, setFile] = useState<{
    name: string;
    content: string;
    format: 'csv' | 'xlsx';
  } | null>(null);
  const [mode, setMode] = useState<SalesDistributionMode>('single');
  const [repId, setRepId] = useState(defaultRepId ?? '');
  const [repIds, setRepIds] = useState<string[]>(defaultRepId ? [defaultRepId] : []);
  const [batch, setBatch] = useState('');
  const [preview, setPreview] = useState<SalesDistributionResultDto | null>(null);
  const [result, setResult] = useState<SalesDistributionResultDto | null>(null);
  const [busy, setBusy] = useState(false);
  const leadIds = source.kind === 'leads' ? source.leadIds : null;

  // Cambiar lo que se reparte o cómo obliga a revisar otra vez.
  useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [file, mode, repId, repIds, batch]);

  const ready =
    (isFile ? !!file : (leadIds?.length ?? 0) > 0) &&
    (mode === 'single' ? !!repId : mode === 'even' ? repIds.length > 0 : true);

  async function run(commit: boolean) {
    if (!ready) return;
    const target = {
      mode,
      ...(mode === 'single' ? { repId } : {}),
      ...(mode === 'even' ? { repIds } : {}),
      ...(batch.trim() ? { batch: batch.trim() } : {}),
      commit,
    };
    setBusy(true);
    try {
      const res =
        isFile && file
          ? await importer.mutateAsync({ csv: file.content, format: file.format, ...target })
          : await distributor.mutateAsync({
              leadIds: leadIds ?? [],
              ...target,
              mode: mode === 'column' ? 'single' : mode,
            });
      if (commit) {
        setResult(res);
        toast.success(
          `${plural(res.assigned, 'prospecto repartido', 'prospectos repartidos')}. Cada comercial tiene su aviso.`,
        );
        onDone?.(res);
      } else {
        setPreview(res);
      }
    } catch (err) {
      toast.error(
        errorText(err, commit ? 'No se ha podido repartir.' : 'No se ha podido revisar.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const shown = result ?? preview;
  const modes: SalesDistributionMode[] = isFile ? ['single', 'column', 'even'] : ['single', 'even'];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isFile ? 'Importar y repartir prospectos' : 'Repartir entre comerciales'}
          </DialogTitle>
          <DialogDescription>
            {isFile
              ? 'Un CSV o Excel con una fila por prospecto: empresa, persona, email, teléfono, ciudad, trasteros, locales, programa, perfil, origen, nota y, si repartes por columna, «comercial» (su código o su email). Cada fila necesita la empresa o la persona y un email o un teléfono.'
              : `${plural(leadIds?.length ?? 0, 'lead elegido', 'leads elegidos')}. Los que ya lleva un comercial no se tocan y los que ya son clientes se omiten.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {isFile && (
            <Field id="dist-file" label="Fichero" className="sm:col-span-2">
              <Input
                id="dist-file"
                type="file"
                accept=".csv,.xlsx,.xls,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  void readImportFile(f)
                    .then((r) => setFile({ name: f.name, ...r }))
                    .catch(() => toast.error('No se ha podido leer el fichero.'));
                }}
              />
            </Field>
          )}
          <Field id="dist-mode" label="Cómo se reparte" className="sm:col-span-2">
            <div className="flex flex-wrap gap-2" role="radiogroup" id="dist-mode">
              {modes.map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={mode === m}
                  variant={mode === m ? 'default' : 'outline'}
                  onClick={() => setMode(m)}
                >
                  {SALES_DISTRIBUTION_MODE_LABELS[m]}
                </Button>
              ))}
            </div>
          </Field>

          {mode === 'single' && (
            <Field id="dist-rep" label="Comercial">
              <Select value={repId} onValueChange={setRepId}>
                <SelectTrigger id="dist-rep">
                  <SelectValue placeholder="Elige un comercial" />
                </SelectTrigger>
                <SelectContent>
                  {reps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.fullName} · {plural(r.prospects, 'prospecto', 'prospectos')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {mode === 'even' && (
            <Field
              id="dist-reps"
              label="Entre quiénes"
              hint="Cada uno va al que menos prospectos lleva en ese momento."
              className="sm:col-span-2"
            >
              <div id="dist-reps" className="grid gap-1.5 rounded-md border p-2 sm:grid-cols-2">
                {reps.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={repIds.includes(r.id)}
                      onChange={(e) =>
                        setRepIds((ids) =>
                          e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id),
                        )
                      }
                    />
                    <span>
                      {r.fullName}{' '}
                      <span className="text-muted-foreground">
                        · {plural(r.prospects, 'prospecto', 'prospectos')}
                      </span>
                    </span>
                  </label>
                ))}
                {reps.length === 0 && (
                  <p className="text-sm text-muted-foreground">No hay comerciales activos.</p>
                )}
              </div>
            </Field>
          )}
          {mode === 'column' && (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Cada fila va al comercial de su columna «comercial», con su código (p. ej.{' '}
              {reps[0]?.salesCode ?? 'ANA7K2P'}) o su email.
            </p>
          )}
          <Field
            id="dist-batch"
            label="Lote (opcional)"
            hint="P. ej. «Feria Valencia». Para filtrarlos después y ver cómo van."
            className={mode === 'single' ? '' : 'sm:col-span-2'}
          >
            <Input
              id="dist-batch"
              value={batch}
              maxLength={SALES_BATCH_MAX}
              onChange={(e) => setBatch(e.target.value)}
            />
          </Field>
        </div>

        {shown && <DistributionSummary result={shown} />}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {result ? 'Cerrar' : 'Cancelar'}
          </Button>
          {!result && (
            <>
              <Button variant="outline" disabled={!ready || busy} onClick={() => void run(false)}>
                {busy && !preview && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Revisar
              </Button>
              <Button
                disabled={!preview || busy || preview.summary.toAssign === 0}
                onClick={() => void run(true)}
              >
                {busy && preview && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                <Users className="mr-1.5 size-4" aria-hidden />
                {preview
                  ? `Repartir ${plural(preview.summary.toAssign, 'prospecto', 'prospectos')}`
                  : 'Repartir'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Lo que pasa con cada fila y cuántos le tocan a cada comercial. */
function DistributionSummary({ result }: { result: SalesDistributionResultDto }) {
  const [only, setOnly] = useState<SalesDistributionRowStatus | 'all'>('all');
  const s = result.summary;
  const chips: [SalesDistributionRowStatus, number, string][] = [
    ['new', s.new, plural(s.new, 'nuevo', 'nuevos')],
    ['assign', s.assign, plural(s.assign, 'ya existía sin comercial', 'ya existían sin comercial')],
    ['taken', s.taken, plural(s.taken, 'ya lo lleva un comercial', 'ya los lleva un comercial')],
    ['customer', s.customers, plural(s.customers, 'ya es cliente', 'ya son clientes')],
    ['error', s.errors, plural(s.errors, 'con error', 'con error')],
  ];
  const rows = only === 'all' ? result.rows : result.rows.filter((r) => r.status === only);
  return (
    <div className="space-y-2">
      {result.committed ? (
        <p className="rounded-md bg-muted p-2 text-sm">
          Hecho: {plural(result.assigned, 'prospecto repartido', 'prospectos repartidos')}
          {result.batch ? ` en el lote «${result.batch}»` : ''}. Cada comercial ha recibido un aviso
          en su panel y por correo, y los verá como «Nuevos para ti».
        </p>
      ) : (
        <p className="text-sm">
          Se repartirán <strong>{plural(s.toAssign, 'prospecto', 'prospectos')}</strong>
          {result.batch ? ` en el lote «${result.batch}»` : ''}. Los que ya lleva un comercial no se
          tocan y los clientes se omiten.
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setOnly('all')}
          className={cn(
            'rounded-full border px-2 py-0.5 text-xs',
            only === 'all' && 'ring-2 ring-primary/40',
          )}
        >
          Todos · {s.total}
        </button>
        {chips
          .filter(([, n]) => n > 0)
          .map(([status, , label]) => (
            <button
              key={status}
              type="button"
              onClick={() => setOnly(status)}
              className={cn(
                'rounded-full border px-2 py-0.5 text-xs',
                STATUS_STYLE[status],
                only === status && 'ring-2 ring-primary/40',
              )}
            >
              {label}
            </button>
          ))}
      </div>
      {result.byRep.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {result.byRep.map((r) => `${r.repName}: ${r.count}`).join(' · ')}
        </p>
      )}
      <div className="max-h-72 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr className="text-left">
              {result.rows.some((r) => r.line !== null) && (
                <th className="px-2 py-1 font-medium">Fila</th>
              )}
              <th className="px-2 py-1 font-medium">Prospecto</th>
              <th className="px-2 py-1 font-medium">Qué pasa</th>
              <th className="px-2 py-1 font-medium">Comercial</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.line ?? r.leadId}-${i}`} className="border-t align-top">
                {r.line !== null && <td className="px-2 py-1 tabular-nums">{r.line}</td>}
                <td className="max-w-[16rem] px-2 py-1">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block truncate text-muted-foreground">
                    {[r.email, r.phone, r.city].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className="px-2 py-1">
                  <Badge variant="outline" className={STATUS_STYLE[r.status]}>
                    {SALES_DISTRIBUTION_ROW_STATUS_LABELS[r.status]}
                  </Badge>
                  {r.message && (
                    <span className="mt-0.5 block text-muted-foreground">{r.message}</span>
                  )}
                </td>
                <td className="px-2 py-1">{r.repName ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
