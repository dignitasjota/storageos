'use client';

import {
  SEO_SITE_CHANGE_TYPES,
  SEO_SITE_CHANGE_TYPE_LABELS,
  SEO_TASK_PRIORITIES,
  SEO_TASK_PRIORITY_LABELS,
  SEO_TASK_STATUSES,
  SEO_TASK_STATUS_LABELS,
  SEO_TASK_TYPES,
  SEO_TASK_TYPE_LABELS,
  type SeoDomainRole,
  type SeoSiteChangeDto,
  type SeoSiteChangeType,
  type SeoTaskDto,
  type SeoTaskPriority,
  type SeoTaskStatus,
  type SeoTaskType,
} from '@storageos/shared';
import { Loader2, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
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
import { Textarea } from '@/components/ui/textarea';
import { useOpportunityAssignees } from '@/lib/seo-advanced/opportunity-hooks';
import {
  type PlanScope,
  useCreateSeoTask,
  useCreateSiteChange,
  useDeleteSeoTask,
  useDeleteSiteChange,
  useUpdateSeoTask,
  useUpdateSiteChange,
} from '@/lib/seo-advanced/plan-hooks';

export type PlanDomain = { id: string; domain: string; role: SeoDomainRole };

const NONE = '__none__';
const PRIMARY = '__primary__';

/** Hoy en el navegador (YYYY-MM-DD). */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const splitList = (text: string) =>
  text
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Lo que motivó la actuación o la tarea (se enlaza y rellena el alcance). */
export interface PlanSourceLink {
  opportunityId?: string | null;
  cannibalizationId?: string | null;
  indexFindingId?: string | null;
}

/** Valores iniciales para una actuación nueva (desde una oportunidad, una tarea…). */
export interface ChangeDraft extends PlanSourceLink {
  title?: string;
  type?: SeoSiteChangeType;
  urls?: string[];
  keywords?: string[];
  domainId?: string | null;
  taskId?: string | null;
}

/** Valores iniciales para una tarea nueva. */
export interface TaskDraft extends PlanSourceLink {
  title?: string;
  type?: SeoTaskType;
  url?: string | null;
  keywords?: string[];
  domainId?: string | null;
  dueDate?: string | null;
}

function DomainSelect({
  domains,
  value,
  onChange,
  id,
}: {
  domains: PlanDomain[];
  value: string | null;
  onChange: (v: string | null) => void;
  id: string;
}) {
  if (domains.length < 2) return null;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Dominio</Label>
      <Select value={value ?? PRIMARY} onValueChange={(v) => onChange(v === PRIMARY ? null : v)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PRIMARY}>El principal</SelectItem>
          {domains.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.domain}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// --------------------------------------------------------------- actuación

/** Registrar (o editar) una actuación: qué se cambió, cuándo y a qué afecta. */
export function ChangeDialog({
  scope,
  domains,
  open,
  onOpenChange,
  change,
  draft,
  onSaved,
  onDeleted,
}: {
  scope: PlanScope;
  domains: PlanDomain[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Para editar una existente. */
  change?: SeoSiteChangeDto | null;
  draft?: ChangeDraft | null;
  onSaved?: (change: SeoSiteChangeDto) => void;
  onDeleted?: () => void;
}) {
  const ids = useId();
  const create = useCreateSiteChange(scope);
  const update = useUpdateSiteChange(scope);
  const remove = useDeleteSiteChange(scope);
  const confirm = useConfirm();
  const [date, setDate] = useState<string | undefined>(localToday());
  const [time, setTime] = useState('');
  const [type, setType] = useState<SeoSiteChangeType>('content');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [urls, setUrls] = useState('');
  const [keywords, setKeywords] = useState('');
  const [notes, setNotes] = useState('');
  const [domainId, setDomainId] = useState<string | null>(null);

  // Se rellena al abrir (con lo que llega en ese momento), no en cada render.
  const initial = useRef({ change, draft });
  initial.current = { change, draft };
  const changeId = change?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const { change, draft } = initial.current;
    setDate(change?.date ?? localToday());
    setTime(change?.time ?? '');
    setType(change?.type ?? draft?.type ?? 'content');
    setTitle(change?.title ?? draft?.title ?? '');
    setDescription(change?.description ?? '');
    setUrls((change?.urls ?? draft?.urls ?? []).join('\n'));
    setKeywords((change?.keywords ?? draft?.keywords ?? []).join(', '));
    setNotes(change?.notes ?? '');
    setDomainId(change?.domainId ?? draft?.domainId ?? null);
  }, [open, changeId]);

  const timeOk = time === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  const busy = create.isPending || update.isPending;

  const save = async () => {
    if (!date) return;
    const input = {
      date,
      time: time || null,
      type,
      title: title.trim(),
      description: description.trim() || null,
      urls: splitList(urls),
      keywords: splitList(keywords),
      notes: notes.trim() || null,
      domainId,
    };
    try {
      const saved = change
        ? await update.mutateAsync({ id: change.id, input })
        : await create.mutateAsync({
            ...input,
            opportunityId: draft?.opportunityId ?? null,
            cannibalizationId: draft?.cannibalizationId ?? null,
            indexFindingId: draft?.indexFindingId ?? null,
            taskId: draft?.taskId ?? null,
          });
      toast.success(change ? 'Actuación guardada' : 'Actuación registrada');
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const del = async () => {
    if (!change) return;
    const yes = await confirm({
      title: '¿Borrar esta actuación?',
      description: 'Se quita del registro y de los gráficos. No se puede deshacer.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(change.id);
      toast.success('Actuación borrada');
      onDeleted?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{change ? 'Editar actuación' : 'Registrar una actuación'}</DialogTitle>
          <DialogDescription>
            Un cambio hecho en la web. Pasados 7, 28 y 90 días se compara con los mismos días de
            antes en Search Console.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1">
              <Label>Día del cambio</Label>
              <DateSelect value={date} onChange={setDate} max={localToday()} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-time`}>Hora (opcional)</Label>
              <Input
                id={`${ids}-time`}
                value={time}
                inputMode="numeric"
                placeholder="10:30"
                maxLength={5}
                className="sm:w-24"
                onChange={(e) => setTime(e.target.value)}
                aria-invalid={!timeOk}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-type`}>Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as SeoSiteChangeType)}>
                <SelectTrigger id={`${ids}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEO_SITE_CHANGE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SEO_SITE_CHANGE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DomainSelect
              id={`${ids}-domain`}
              domains={domains}
              value={domainId}
              onChange={setDomainId}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-title`}>Qué se cambió</Label>
            <Input
              id={`${ids}-title`}
              value={title}
              maxLength={200}
              placeholder="Título nuevo en la página de precios"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-desc`}>Detalle (opcional)</Label>
            <Textarea
              id={`${ids}-desc`}
              value={description}
              rows={2}
              maxLength={4000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-urls`}>URLs afectadas (una por línea)</Label>
            <Textarea
              id={`${ids}-urls`}
              value={urls}
              rows={2}
              placeholder={'https://tuweb.es/precios\n/blog/trasteros'}
              onChange={(e) => setUrls(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-kw`}>Palabras afectadas (separadas por comas)</Label>
            <Textarea
              id={`${ids}-kw`}
              value={keywords}
              rows={2}
              placeholder="trasteros valencia, guardamuebles"
              onChange={(e) => setKeywords(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Sin URLs ni palabras, se compara el sitio entero.
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-notes`}>Notas (opcional)</Label>
            <Textarea
              id={`${ids}-notes`}
              value={notes}
              rows={2}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {change ? (
            <Button variant="ghost" onClick={() => void del()} disabled={remove.isPending}>
              <Trash2 className="mr-1 size-4" aria-hidden /> Borrar
            </Button>
          ) : (
            <span />
          )}
          <Button
            onClick={() => void save()}
            disabled={busy || !date || title.trim().length < 2 || !timeOk}
          >
            {busy && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            {change ? 'Guardar' : 'Registrar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ tarea

/** Crear o editar una tarea SEO. */
export function TaskDialog({
  scope,
  domains,
  open,
  onOpenChange,
  task,
  draft,
  canEdit,
  onSaved,
}: {
  scope: PlanScope;
  domains: PlanDomain[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task?: SeoTaskDto | null;
  draft?: TaskDraft | null;
  canEdit: boolean;
  onSaved?: (task: SeoTaskDto) => void;
}) {
  const ids = useId();
  const create = useCreateSeoTask(scope);
  const update = useUpdateSeoTask(scope);
  const remove = useDeleteSeoTask(scope);
  const assignees = useOpportunityAssignees(scope, open && canEdit);
  const confirm = useConfirm();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SeoTaskType>('other');
  const [status, setStatus] = useState<SeoTaskStatus>('todo');
  const [priority, setPriority] = useState<SeoTaskPriority>('medium');
  const [assignedToId, setAssignedToId] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | undefined>(undefined);
  const [publishDate, setPublishDate] = useState<string | undefined>(undefined);
  const [url, setUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [domainId, setDomainId] = useState<string | null>(null);

  const initial = useRef({ task, draft });
  initial.current = { task, draft };
  const taskId = task?.id ?? null;
  useEffect(() => {
    if (!open) return;
    const { task, draft } = initial.current;
    setTitle(task?.title ?? draft?.title ?? '');
    setDescription(task?.description ?? '');
    setType(task?.type ?? draft?.type ?? 'other');
    setStatus(task?.status ?? 'todo');
    setPriority(task?.priority ?? 'medium');
    setAssignedToId(task?.assignedToId ?? null);
    setDueDate(task?.dueDate ?? draft?.dueDate ?? undefined);
    setPublishDate(task?.publishDate ?? undefined);
    setUrl(task?.url ?? draft?.url ?? '');
    setKeywords((task?.keywords ?? draft?.keywords ?? []).join(', '));
    setDomainId(task?.domainId ?? draft?.domainId ?? null);
  }, [open, taskId]);

  const busy = create.isPending || update.isPending;
  const save = async () => {
    const input = {
      title: title.trim(),
      description: description.trim() || null,
      type,
      status,
      priority,
      assignedToId,
      dueDate: dueDate ?? null,
      publishDate: type === 'content' ? (publishDate ?? null) : null,
      url: url.trim() || null,
      keywords: splitList(keywords),
      domainId,
    };
    try {
      const saved = task
        ? await update.mutateAsync({ id: task.id, input })
        : await create.mutateAsync({
            ...input,
            opportunityId: draft?.opportunityId ?? null,
            cannibalizationId: draft?.cannibalizationId ?? null,
            indexFindingId: draft?.indexFindingId ?? null,
          });
      toast.success(task ? 'Tarea guardada' : 'Tarea creada');
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const del = async () => {
    if (!task) return;
    const yes = await confirm({
      title: `¿Borrar «${task.title}»?`,
      description: 'No se puede deshacer. La actuación que registraste, si la hay, se queda.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(task.id);
      toast.success('Tarea borrada');
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const readOnly = !canEdit;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {task ? (readOnly ? 'Tarea' : 'Editar tarea') : 'Nueva tarea SEO'}
          </DialogTitle>
          <DialogDescription>
            {task?.sourceLabel ?? 'Algo que hay que hacer en la web o en Google.'}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={readOnly} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-title`}>Título</Label>
            <Input
              id={`${ids}-title`}
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-desc`}>Descripción (opcional)</Label>
            <Textarea
              id={`${ids}-desc`}
              value={description}
              rows={3}
              maxLength={4000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-type`}>Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as SeoTaskType)}>
                <SelectTrigger id={`${ids}-type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEO_TASK_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SEO_TASK_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-status`}>Estado</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as SeoTaskStatus)}>
                <SelectTrigger id={`${ids}-status`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEO_TASK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SEO_TASK_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-prio`}>Prioridad</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as SeoTaskPriority)}>
                <SelectTrigger id={`${ids}-prio`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEO_TASK_PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {SEO_TASK_PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-who`}>Responsable</Label>
            <Select
              value={assignedToId ?? NONE}
              onValueChange={(v) => setAssignedToId(v === NONE ? null : v)}
            >
              <SelectTrigger id={`${ids}-who`}>
                <SelectValue placeholder="Sin asignar" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Sin asignar</SelectItem>
                {(assignees.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
                {assignedToId && !assignees.data?.some((a) => a.id === assignedToId) && (
                  <SelectItem value={assignedToId}>
                    {task?.assignedToName ?? 'Otra persona'}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Le llegará un aviso al asignársela.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Fecha límite</Label>
              <DateSelect value={dueDate} onChange={setDueDate} around />
              {dueDate && !readOnly && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => setDueDate(undefined)}
                >
                  Quitar la fecha
                </Button>
              )}
            </div>
            {type === 'content' && (
              <div className="space-y-1">
                <Label>Publicación</Label>
                <DateSelect value={publishDate} onChange={setPublishDate} around />
                {publishDate && !readOnly && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => setPublishDate(undefined)}
                  >
                    Quitar la fecha
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${ids}-url`}>URL (opcional)</Label>
              <Input
                id={`${ids}-url`}
                value={url}
                maxLength={2000}
                placeholder="https://tuweb.es/precios"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <DomainSelect
              id={`${ids}-domain`}
              domains={domains}
              value={domainId}
              onChange={setDomainId}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-kw`}>Palabras (separadas por comas)</Label>
            <Input
              id={`${ids}-kw`}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
            />
          </div>
          {task?.changeTitle && (
            <p className="text-sm text-muted-foreground">
              Actuación registrada: <span className="text-foreground">{task.changeTitle}</span>
            </p>
          )}
        </fieldset>
        {canEdit && (
          <DialogFooter className="gap-2 sm:justify-between">
            {task ? (
              <Button variant="ghost" onClick={() => void del()} disabled={remove.isPending}>
                <Trash2 className="mr-1 size-4" aria-hidden /> Borrar
              </Button>
            ) : (
              <span />
            )}
            <Button onClick={() => void save()} disabled={busy || title.trim().length < 2}>
              {busy && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
              {task ? 'Guardar' : 'Crear tarea'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
