'use client';

import {
  PLATFORM_LEAD_ASSIGN_MODE_LABELS,
  PLATFORM_LEAD_ASSIGN_MODES,
  PLATFORM_LEAD_DISCARD_REASON_LABELS,
  PLATFORM_LEAD_MANUAL_DISCARD_REASONS,
  PLATFORM_LEAD_SOURCE_LABELS,
  PLATFORM_LEAD_SOURCES,
  PLATFORM_LEAD_STAGE_LABELS,
  type ImportCommitDto,
  type ImportPreviewDto,
  type PlatformLeadAssignMode,
  type PlatformLeadDiscardReason,
  type PlatformLeadDuplicateDto,
  type PlatformLeadSequenceDto,
  type PlatformLeadSequenceStep,
  type PlatformLeadSettingsDto,
  type PlatformLeadSource,
} from '@storageos/shared';
import { Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
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
import { useAdminSuperAdmins } from '@/lib/admin/hooks';
import {
  useDeleteLeadSequence,
  useDiscardLead,
  useImportLeads,
  useLeadSequences,
  useLeadSettings,
  useLeadTemplates,
  useMergeLead,
  useSaveLeadSequence,
  useUpdateLeadSettings,
} from '@/lib/admin/leads-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { plural } from '@/lib/format';

const NONE = '-';
type ManualDiscard = Exclude<PlatformLeadDiscardReason, 'merged'>;
const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

// ------------------------------------------------------------ descartar

/** «No es un lead», con su motivo (sale en Resultados). */
export function DiscardLeadDialog({
  leadIds,
  name,
  onClose,
  onDone,
  submit,
}: {
  leadIds: string[];
  name: string;
  onClose: () => void;
  onDone?: () => void;
  /** Otra forma de enviarlo (en lote). */
  submit?: (reasonCode: ManualDiscard, reason: string) => Promise<void>;
}) {
  const discard = useDiscardLead();
  const [reasonCode, setReasonCode] = useState<ManualDiscard>('spam');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      if (submit) await submit(reasonCode, reason);
      else await discard.mutateAsync({ id: leadIds[0]!, input: { reasonCode, reason } });
      toast.success('Fuera del tablero.');
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido descartar.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>No es un lead: {name}</DialogTitle>
          <DialogDescription>
            Sale del tablero y de las cifras. El motivo sale en «Resultados» y se puede recuperar
            desde «Descartados».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Motivo</Label>
            <Select value={reasonCode} onValueChange={(v) => setReasonCode(v as ManualDiscard)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_LEAD_MANUAL_DISCARD_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {PLATFORM_LEAD_DISCARD_REASON_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="discard-detail" className="text-xs">
              Detalle (opcional)
            </Label>
            <Textarea
              id="discard-detail"
              rows={2}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy} onClick={() => void go()}>
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            No es un lead
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- fusionar

/** Une otro lead (`source`) a este: el otro queda descartado como «Fusionado». */
export function MergeLeadDialog({
  leadId,
  leadName,
  source,
  onClose,
}: {
  leadId: string;
  leadName: string;
  source: PlatformLeadDuplicateDto;
  onClose: () => void;
}) {
  const merge = useMergeLead();
  async function go() {
    try {
      await merge.mutateAsync({ id: leadId, sourceId: source.id });
      toast.success('Leads fusionados.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se han podido fusionar.'));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fusionar «{source.name}» con este lead</DialogTitle>
          <DialogDescription>
            Su actividad, seguimientos, propuestas y citas pasan a «{leadName}», se completan los
            datos que aquí faltan y «{source.name}» queda descartado como «Fusionado». Queda en el
            registro de acciones.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={merge.isPending} onClick={() => void go()}>
            {merge.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Fusionar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------- importar

function readFile(file: File): Promise<{ content: string; format: 'csv' | 'xlsx' }> {
  const isXlsx = /\.xlsx?$/i.test(file.name);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      if (isXlsx) {
        const bytes = new Uint8Array(reader.result as ArrayBuffer);
        let bin = '';
        for (const b of bytes) bin += String.fromCharCode(b);
        resolve({ content: btoa(bin), format: 'xlsx' });
      } else {
        resolve({ content: String(reader.result ?? ''), format: 'csv' });
      }
    };
    if (isXlsx) reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

const STATUS_LABEL = { valid: 'Se crea', duplicate: 'Ya existe', error: 'Error' } as const;

/** Importar leads de un CSV o Excel: vista previa con lo que pasa con cada fila. */
export function ImportLeadsDialog({ onClose }: { onClose: () => void }) {
  const admins = useAdminSuperAdmins();
  const importer = useImportLeads();
  const [file, setFile] = useState<{
    name: string;
    content: string;
    format: 'csv' | 'xlsx';
  } | null>(null);
  const [source, setSource] = useState<PlatformLeadSource>('other');
  const [assignedTo, setAssignedTo] = useState(NONE);
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'merge'>('skip');
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null);
  const [result, setResult] = useState<ImportCommitDto | null>(null);
  const [busy, setBusy] = useState(false);
  const input = () =>
    file
      ? {
          csv: file.content,
          format: file.format,
          source,
          onDuplicate,
          assignedToId: assignedTo === NONE ? null : assignedTo,
        }
      : null;

  async function runPreview() {
    const body = input();
    if (!body) return;
    setBusy(true);
    try {
      setPreview(await importer.preview(body));
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido leer el fichero.'));
    } finally {
      setBusy(false);
    }
  }

  async function runCommit() {
    const body = input();
    if (!body) return;
    setBusy(true);
    try {
      const res = await importer.commit(body);
      setResult(res);
      toast.success(`${plural(res.summary.created, 'lead importado', 'leads importados')}.`);
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido importar.'));
    } finally {
      setBusy(false);
    }
  }

  // Cambiar las opciones obliga a revisar de nuevo.
  useEffect(() => {
    setPreview(null);
    setResult(null);
  }, [file, source, assignedTo, onDuplicate]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar leads</DialogTitle>
          <DialogDescription>
            Un CSV o Excel con una fila por lead. Columnas que se entienden: empresa, persona,
            email, teléfono, ciudad, trasteros, locales, programa, perfil, origen, nota y campaña.
            Cada fila necesita la empresa o la persona y un email o un teléfono.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="imp-file" className="text-xs">
              Fichero
            </Label>
            <Input
              id="imp-file"
              type="file"
              accept=".csv,.xlsx,.xls,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                void readFile(f)
                  .then((r) => setFile({ name: f.name, ...r }))
                  .catch(() => toast.error('No se ha podido leer el fichero.'));
              }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Origen (si el fichero no lo dice)</Label>
            <Select value={source} onValueChange={(v) => setSource(v as PlatformLeadSource)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_LEAD_SOURCES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {PLATFORM_LEAD_SOURCE_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Quién los lleva</Label>
            <Select value={assignedTo} onValueChange={setAssignedTo}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Nadie</SelectItem>
                {(admins.data ?? [])
                  .filter((a) => a.isActive)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.fullName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">Si ya existe (mismo email o teléfono)</Label>
            <Select
              value={onDuplicate}
              onValueChange={(v) => setOnDuplicate(v as 'skip' | 'merge')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">Se omite</SelectItem>
                <SelectItem value="merge">
                  Se le suman los datos que le faltan y una nota
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {preview && (
          <div className="space-y-2">
            <p className="text-sm">
              {plural(preview.summary.valid, 'se crea', 'se crean')} ·{' '}
              {plural(preview.summary.duplicates, 'ya existe', 'ya existen')} ·{' '}
              {plural(preview.summary.invalid, 'con error', 'con error')}
            </p>
            <div className="max-h-72 overflow-auto rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left">
                    <th className="px-2 py-1 font-medium">Fila</th>
                    <th className="px-2 py-1 font-medium">Qué pasa</th>
                    <th className="px-2 py-1 font-medium">Datos</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.index} className="border-t align-top">
                      <td className="px-2 py-1 tabular-nums">{r.index}</td>
                      <td className="px-2 py-1">
                        <Badge
                          variant={
                            r.status === 'valid'
                              ? 'default'
                              : r.status === 'duplicate'
                                ? 'secondary'
                                : 'destructive'
                          }
                        >
                          {STATUS_LABEL[r.status]}
                        </Badge>
                        {r.errors.length > 0 && (
                          <span className="mt-0.5 block text-muted-foreground">
                            {r.errors.join(' · ')}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[18rem] truncate px-2 py-1 text-muted-foreground">
                        {Object.values(r.raw).filter(Boolean).join(' · ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {result && (
          <p className="rounded-md bg-muted p-2 text-sm">
            Hecho:{' '}
            {plural(result.summary.created, 'creado o actualizado', 'creados o actualizados')},{' '}
            {plural(result.summary.skipped, 'omitido', 'omitidos')} y{' '}
            {plural(result.summary.errors, 'con error', 'con error')}.
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {result ? 'Cerrar' : 'Cancelar'}
          </Button>
          {!result && (
            <>
              <Button variant="outline" disabled={!file || busy} onClick={() => void runPreview()}>
                {busy && !preview && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Revisar
              </Button>
              <Button
                disabled={
                  !preview || busy || preview.summary.valid + preview.summary.duplicates === 0
                }
                onClick={() => void runCommit()}
              >
                {busy && preview && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                <Upload className="mr-1.5 size-4" aria-hidden /> Importar
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- ajustes

/** Ajustes de los leads: reparto, plazos, parados y secuencias de correos. */
export function LeadSettingsDialog({ onClose }: { onClose: () => void }) {
  const superadmin = useIsSuperadmin();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ajustes de los leads</DialogTitle>
          <DialogDescription>
            Cómo se reparten los que entran solos, el plazo para la primera respuesta, cuándo un
            lead está parado y los correos automáticos si no contesta.
            {!superadmin && ' Solo el rol superadmin puede cambiarlos.'}
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="assign">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="assign">Reparto</TabsTrigger>
            <TabsTrigger value="times">Plazos y parados</TabsTrigger>
            <TabsTrigger value="sequences">Correos automáticos</TabsTrigger>
          </TabsList>
          <TabsContent value="assign" className="pt-3">
            <AssignSettings readOnly={!superadmin} />
          </TabsContent>
          <TabsContent value="times" className="pt-3">
            <TimesSettings readOnly={!superadmin} />
          </TabsContent>
          <TabsContent value="sequences" className="pt-3">
            <SequencesSettings readOnly={!superadmin} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function useSettingsForm() {
  const q = useLeadSettings();
  const update = useUpdateLeadSettings();
  const [form, setForm] = useState<PlatformLeadSettingsDto | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data);
  }, [q.data]);
  const dirty = !!form && !!q.data && JSON.stringify(form) !== JSON.stringify(q.data);
  async function save(fields: (keyof PlatformLeadSettingsDto)[]) {
    if (!form) return;
    const input = Object.fromEntries(fields.map((f) => [f, form[f]]));
    try {
      await update.mutateAsync(input);
      toast.success('Ajustes guardados.');
    } catch (err) {
      toast.error(errorText(err, 'No se han podido guardar.'));
    }
  }
  return { form, setForm, dirty, save, saving: update.isPending };
}

function AssignSettings({ readOnly }: { readOnly: boolean }) {
  const admins = useAdminSuperAdmins();
  const { form, setForm, dirty, save, saving } = useSettingsForm();
  if (!form) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const active = (admins.data ?? []).filter((a) => a.isActive);
  const nameOf = (id: string) => active.find((a) => a.id === id)?.fullName ?? 'Desactivado';
  const toggle = (id: string) =>
    setForm({
      ...form,
      roundRobinIds: form.roundRobinIds.includes(id)
        ? form.roundRobinIds.filter((x) => x !== id)
        : [...form.roundRobinIds, id],
    });
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <div className="space-y-1">
        <Label className="text-xs">Leads que entran solos sin responsable (web, registros)</Label>
        <Select
          value={form.assignMode}
          onValueChange={(v) => setForm({ ...form, assignMode: v as PlatformLeadAssignMode })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLATFORM_LEAD_ASSIGN_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {PLATFORM_LEAD_ASSIGN_MODE_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Un lead que ya es de un comercial (por su código) no se reparte.
        </p>
      </div>
      {form.assignMode !== 'off' && (
        <div className="space-y-1">
          <Label className="text-xs">
            Quién entra en el turno{form.assignMode === 'zone' ? ' (si no casa ninguna zona)' : ''}
          </Label>
          <div className="flex flex-wrap gap-2">
            {active.map((a) => (
              <label
                key={a.id}
                className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  checked={form.roundRobinIds.includes(a.id)}
                  onChange={() => toggle(a.id)}
                />
                {a.fullName}
              </label>
            ))}
          </div>
        </div>
      )}
      {form.assignMode === 'zone' && (
        <div className="space-y-2">
          <Label className="text-xs">Zonas (ciudad o provincia → persona)</Label>
          {form.zoneRules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Ciudad o provincia"
                className="h-8 w-40"
                value={r.match}
                maxLength={80}
                onChange={(e) =>
                  setForm({
                    ...form,
                    zoneRules: form.zoneRules.map((x, n) =>
                      n === i ? { ...x, match: e.target.value } : x,
                    ),
                  })
                }
              />
              <Select
                value={r.superAdminId}
                onValueChange={(v) =>
                  setForm({
                    ...form,
                    zoneRules: form.zoneRules.map((x, n) =>
                      n === i ? { ...x, superAdminId: v } : x,
                    ),
                  })
                }
              >
                <SelectTrigger className="h-8 w-44" aria-label="Persona">
                  <SelectValue placeholder={nameOf(r.superAdminId)} />
                </SelectTrigger>
                <SelectContent>
                  {active.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label="Quitar zona"
                onClick={() =>
                  setForm({ ...form, zoneRules: form.zoneRules.filter((_, n) => n !== i) })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={active.length === 0}
            onClick={() =>
              setForm({
                ...form,
                zoneRules: [...form.zoneRules, { match: '', superAdminId: active[0]!.id }],
              })
            }
          >
            <Plus className="mr-1 size-3.5" aria-hidden /> Añadir zona
          </Button>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.zoneFallbackRoundRobin}
              onChange={(e) => setForm({ ...form, zoneFallbackRoundRobin: e.target.checked })}
            />
            Si no casa ninguna zona, por turnos
          </label>
        </div>
      )}
      {!readOnly && (
        <div className="flex justify-end">
          <Button
            disabled={!dirty || saving || form.zoneRules.some((r) => r.match.trim().length < 2)}
            onClick={() =>
              void save(['assignMode', 'roundRobinIds', 'zoneRules', 'zoneFallbackRoundRobin'])
            }
          >
            Guardar
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function TimesSettings({ readOnly }: { readOnly: boolean }) {
  const { form, setForm, dirty, save, saving } = useSettingsForm();
  if (!form) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  const numberInput = (
    id: string,
    label: string,
    value: number,
    onChange: (n: number) => void,
    min: number,
    max: number,
  ) => (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(min, Math.min(max, e.target.valueAsNumber || min)))}
      />
    </div>
  );
  return (
    <fieldset disabled={readOnly} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {numberInput(
          'st-hours',
          'Horas para la primera respuesta',
          form.responseHours,
          (n) => setForm({ ...form, responseHours: n }),
          1,
          72,
        )}
        {numberInput(
          'st-value',
          'Alto valor desde (€ al mes sin IVA)',
          form.highValueMonthly,
          (n) => setForm({ ...form, highValueMonthly: n }),
          0,
          100000,
        )}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.businessHours}
          onChange={(e) => setForm({ ...form, businessHours: e.target.checked })}
        />
        Contar solo horas laborables (lunes a viernes, de 9:00 a 18:00)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.reassignEnabled}
          onChange={(e) => setForm({ ...form, reassignEnabled: e.target.checked })}
        />
        Si se pasa el plazo, pasarlo al siguiente del turno (una vez, avisando a los dos)
      </label>
      <div className="space-y-1">
        <p className="text-xs font-medium">Días sin actividad para darlo por parado</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(['new', 'contacted', 'interested', 'trial'] as const).map((k) =>
            numberInput(
              `st-${k}`,
              PLATFORM_LEAD_STAGE_LABELS[k],
              form.staleDays[k],
              (n) => setForm({ ...form, staleDays: { ...form.staleDays, [k]: n } }),
              1,
              90,
            ),
          )}
        </div>
      </div>
      {!readOnly && (
        <div className="flex justify-end">
          <Button
            disabled={!dirty || saving}
            onClick={() =>
              void save([
                'responseHours',
                'businessHours',
                'reassignEnabled',
                'staleDays',
                'highValueMonthly',
              ])
            }
          >
            Guardar
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function SequencesSettings({ readOnly }: { readOnly: boolean }) {
  const confirm = useConfirm();
  const list = useLeadSequences();
  const del = useDeleteLeadSequence();
  const { form, setForm, dirty, save, saving } = useSettingsForm();
  const [editing, setEditing] = useState<PlatformLeadSequenceDto | 'new' | null>(null);
  if (editing) {
    return (
      <SequenceEditor
        sequence={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="space-y-3">
      {form && (
        <fieldset disabled={readOnly} className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.sequenceAutoStart}
              onChange={(e) => setForm({ ...form, sequenceAutoStart: e.target.checked })}
            />
            Empieza sola la de por defecto con el primer correo o la propuesta
          </label>
          {!readOnly && dirty && (
            <Button size="sm" disabled={saving} onClick={() => void save(['sequenceAutoStart'])}>
              Guardar
            </Button>
          )}
        </fieldset>
      )}
      <p className="text-xs text-muted-foreground">
        Se paran solas si contesta (correo, llamada, demo o reunión), crea su cuenta, se pierde o se
        descarta. Desde la ficha se puede parar o activar para cada lead.
      </p>
      {(list.data ?? []).map((s) => (
        <div
          key={s.id}
          className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-3 text-sm"
        >
          <div className="min-w-0">
            <p className="font-medium">
              {s.name} {s.isDefault && <Badge variant="secondary">Por defecto</Badge>}{' '}
              {!s.isActive && <Badge variant="outline">Desactivada</Badge>}
            </p>
            <p className="text-xs text-muted-foreground">
              Días {s.steps.map((st) => st.day).join(', ')} ·{' '}
              {plural(s.activeCount, 'lead en marcha', 'leads en marcha')}
            </p>
          </div>
          {!readOnly && (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(s)}>
                Editar
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Borrar ${s.name}`}
                onClick={async () => {
                  const ok = await confirm({
                    title: `¿Borrar «${s.name}»?`,
                    description:
                      'Si algún lead la ha usado, se desactiva (y se para donde esté en marcha) para conservar su historial.',
                    confirmLabel: 'Borrar',
                    destructive: true,
                  });
                  if (!ok) return;
                  await del
                    .mutateAsync(s.id)
                    .catch((err) => toast.error(errorText(err, 'No se ha podido borrar.')));
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
          <Plus className="mr-1 size-3.5" aria-hidden /> Nueva secuencia
        </Button>
      )}
    </div>
  );
}

function SequenceEditor({
  sequence,
  onClose,
}: {
  sequence: PlatformLeadSequenceDto | null;
  onClose: () => void;
}) {
  const templates = useLeadTemplates();
  const saveSeq = useSaveLeadSequence();
  const [name, setName] = useState(sequence?.name ?? '');
  const [description, setDescription] = useState(sequence?.description ?? '');
  const [isActive, setIsActive] = useState(sequence?.isActive ?? true);
  const [isDefault, setIsDefault] = useState(sequence?.isDefault ?? false);
  const [steps, setSteps] = useState<PlatformLeadSequenceStep[]>(
    sequence?.steps ?? [{ day: 2, subject: '', body: '' }],
  );
  const setStep = (i: number, patch: Partial<PlatformLeadSequenceStep>) =>
    setSteps(steps.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const valid =
    name.trim().length >= 2 &&
    steps.length > 0 &&
    steps.every((s) => !!s.templateId || (!!s.subject?.trim() && !!s.body?.trim()));

  async function submit() {
    try {
      await saveSeq.mutateAsync({
        id: sequence?.id ?? null,
        input: { name, description, steps, isActive, isDefault },
      });
      toast.success('Secuencia guardada.');
      onClose();
    } catch (err) {
      toast.error(errorText(err, 'No se ha podido guardar.'));
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="seq-name" className="text-xs">
            Nombre
          </Label>
          <Input
            id="seq-name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="seq-desc" className="text-xs">
            Para qué es (opcional)
          </Label>
          <Input
            id="seq-desc"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
          />
          Activa
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Por defecto (la que empieza sola)
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Variables: {'{nombre}'}, {'{empresa}'}, {'{trasteros}'}, {'{ciudad}'} y {'{comercial}'}{' '}
        (quien lo lleva).
      </p>
      {steps.map((s, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Paso {i + 1}</span>
            <Label htmlFor={`seq-day-${i}`} className="text-xs text-muted-foreground">
              Día
            </Label>
            <Input
              id={`seq-day-${i}`}
              type="number"
              min={0}
              max={180}
              className="h-8 w-20"
              value={s.day}
              onChange={(e) =>
                setStep(i, { day: Math.max(0, Math.min(180, e.target.valueAsNumber || 0)) })
              }
            />
            <Select
              value={s.templateId ?? NONE}
              onValueChange={(v) => setStep(i, { templateId: v === NONE ? null : v })}
            >
              <SelectTrigger className="h-8 w-[200px]" aria-label="Plantilla">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Texto propio</SelectItem>
                {(templates.data ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              className="ml-auto size-8"
              aria-label={`Quitar el paso ${i + 1}`}
              disabled={steps.length === 1}
              onClick={() => setSteps(steps.filter((_, n) => n !== i))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          {!s.templateId && (
            <>
              <Input
                aria-label={`Asunto del paso ${i + 1}`}
                placeholder="Asunto"
                maxLength={200}
                value={s.subject ?? ''}
                onChange={(e) => setStep(i, { subject: e.target.value })}
              />
              <Textarea
                aria-label={`Texto del paso ${i + 1}`}
                placeholder="Texto"
                rows={4}
                maxLength={10_000}
                value={s.body ?? ''}
                onChange={(e) => setStep(i, { body: e.target.value })}
              />
            </>
          )}
        </div>
      ))}
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={steps.length >= 10}
          onClick={() =>
            setSteps([
              ...steps,
              { day: (steps[steps.length - 1]?.day ?? 0) + 3, subject: '', body: '' },
            ])
          }
        >
          <Plus className="mr-1 size-3.5" aria-hidden /> Añadir paso
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Volver
          </Button>
          <Button disabled={!valid || saveSeq.isPending} onClick={() => void submit()}>
            {saveSeq.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </div>
    </div>
  );
}
