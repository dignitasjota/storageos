'use client';

import {
  BUSINESS_REMINDER_CATEGORY_LABELS,
  BUSINESS_REMINDER_DAY_OPTIONS,
  BUSINESS_REMINDER_DEFAULT_DAYS,
  BUSINESS_REMINDER_RECURRENCE_LABELS,
  BusinessReminderCategoryEnum,
  BusinessReminderRecurrenceEnum,
  recurrenceLabel,
  reminderWhenLabel,
  type BusinessReminderCategory,
  type BusinessReminderDto,
  type BusinessReminderRecurrence,
  type CreateBusinessReminderInput,
  type ReminderTemplateDto,
} from '@storageos/shared';
import {
  BellRing,
  CalendarPlus,
  Check,
  Clock,
  ExternalLink,
  FileText,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import {
  openReminderReceipt,
  useApplyReminderTemplate,
  useBusinessReminders,
  useCompleteReminder,
  useCreateReminder,
  useDeleteReminder,
  useReminderCalendar,
  useReminderCompletions,
  useReminderSettings,
  useReminderTemplates,
  useSnoozeReminder,
  useUpdateReminder,
  useUpdateReminderSettings,
} from '@/lib/business-reminders/hooks';
import { localDateString } from '@/lib/dates';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate, formatDateTime, formatEur } from '@/lib/format';
import { useUsers } from '@/lib/users/hooks';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : err instanceof Error ? err.message : 'Error';
}

function stateBadge(r: BusinessReminderDto) {
  if (r.state === 'done') return <Badge variant="secondary">Hecho</Badge>;
  if (r.state === 'paused') return <Badge variant="outline">Pausado</Badge>;
  const cls =
    r.state === 'overdue'
      ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
      : r.state === 'soon'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
        : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
  return <Badge className={`${cls} border-0`}>{reminderWhenLabel(r.daysLeft)}</Badge>;
}

export default function RemindersPage() {
  return (
    <Suspense fallback={null}>
      <RemindersContent />
    </Suspense>
  );
}

function RemindersContent() {
  const ask = useConfirm();
  const params = useSearchParams();
  const canManage = useHasPermission('reminders:manage');
  const [showDone, setShowDone] = useState(false);
  const list = useBusinessReminders(showDone);
  const update = useUpdateReminder();
  const del = useDeleteReminder();
  const [editing, setEditing] = useState<BusinessReminderDto | 'new' | null>(null);
  const [completing, setCompleting] = useState<BusinessReminderDto | null>(null);
  const [snoozing, setSnoozing] = useState<BusinessReminderDto | null>(null);
  const [history, setHistory] = useState<BusinessReminderDto | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const highlight = params.get('reminder');

  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`reminder-${highlight}`)?.scrollIntoView({ block: 'center' });
  }, [highlight, list.data]);

  const groups = useMemo(() => {
    const items = list.data?.items ?? [];
    return [
      { key: 'overdue', title: 'Vencidos', items: items.filter((i) => i.state === 'overdue') },
      {
        key: 'soon',
        title: 'En los próximos 7 días',
        items: items.filter((i) => i.state === 'soon'),
      },
      {
        key: 'upcoming',
        title: 'Más adelante',
        items: items.filter((i) => i.state === 'upcoming'),
      },
      { key: 'paused', title: 'Pausados', items: items.filter((i) => i.state === 'paused') },
      { key: 'done', title: 'Hechos', items: items.filter((i) => i.state === 'done') },
    ].filter((g) => g.items.length > 0);
  }, [list.data]);

  async function togglePause(r: BusinessReminderDto) {
    try {
      await update.mutateAsync({
        id: r.id,
        input: { status: r.status === 'paused' ? 'active' : 'paused' },
      });
      toast.success(r.status === 'paused' ? 'Reactivado' : 'Pausado: no se enviarán avisos');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function remove(r: BusinessReminderDto) {
    const ok = await ask({
      title: '¿Borrar este vencimiento?',
      description: 'Se borra también su historial. Los gastos ya apuntados no se tocan.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await del.mutateAsync(r.id);
      toast.success('Borrado');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const system = list.data?.system ?? [];
  const empty = !list.isLoading && (list.data?.items.length ?? 0) === 0;

  return (
    <div className="space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BellRing className="size-6 text-muted-foreground" />
            Vencimientos
          </h1>
          <p className="text-sm text-muted-foreground">
            Lo que no se te puede pasar: dominio, alquiler del local, Hacienda, seguros, revisiones…
            Te avisamos antes de cada fecha.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="mr-1 h-4 w-4" /> Ajustes
          </Button>
          {canManage && (
            <>
              <Button variant="outline" onClick={() => setTemplatesOpen(true)}>
                <Sparkles className="mr-1 h-4 w-4" /> Plantillas
              </Button>
              <Button onClick={() => setEditing('new')}>
                <Plus className="mr-1 h-4 w-4" /> Nuevo vencimiento
              </Button>
            </>
          )}
        </div>
      </div>

      {list.isLoading && (
        <div className="flex justify-center py-10">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      )}

      {empty && (
        <Card>
          <CardContent className="space-y-3 py-10 text-center">
            <p className="font-medium">Aún no tienes vencimientos</p>
            <p className="text-sm text-muted-foreground">
              Empieza con las plantillas: el calendario fiscal, el dominio, el alquiler del local…
            </p>
            {canManage && (
              <Button variant="outline" onClick={() => setTemplatesOpen(true)}>
                <Sparkles className="mr-1 h-4 w-4" /> Ver plantillas
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {groups.map((g) => (
        <section key={g.key} className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {g.title} <span className="font-normal">({g.items.length})</span>
          </h2>
          <div className="grid gap-2">
            {g.items.map((r) => (
              <Card
                key={r.id}
                id={`reminder-${r.id}`}
                className={highlight === r.id ? 'ring-2 ring-primary' : undefined}
              >
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.title}</span>
                      {stateBadge(r)}
                      <Badge variant="outline">
                        {BUSINESS_REMINDER_CATEGORY_LABELS[r.category]}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatDate(r.dueDate)} · {recurrenceLabel(r.recurrence, r.intervalMonths)}
                      {r.facilityName ? ` · ${r.facilityName}` : ''}
                      {r.amount !== null ? ` · ${formatEur(r.amount)}` : ''}
                      {r.vendor ? ` · ${r.vendor}` : ''}
                      {r.snoozedUntil && r.state !== 'done'
                        ? ` · Pospuesto hasta el ${formatDate(r.snoozedUntil)}`
                        : ''}
                    </p>
                    {r.link && (
                      <a
                        href={r.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      >
                        Abrir enlace <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {canManage && r.status === 'active' && (
                      <Button size="sm" onClick={() => setCompleting(r)}>
                        <Check className="mr-1 h-4 w-4" /> Hecho
                      </Button>
                    )}
                    {canManage && r.status === 'active' && (
                      <Button size="sm" variant="outline" onClick={() => setSnoozing(r)}>
                        <Clock className="mr-1 h-4 w-4" /> Posponer
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Historial"
                      title="Historial"
                      onClick={() => setHistory(r)}
                    >
                      <History className="h-4 w-4" />
                    </Button>
                    {canManage && r.status !== 'done' && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label="Editar"
                          title="Editar"
                          onClick={() => setEditing(r)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={r.status === 'paused' ? 'Reactivar' : 'Pausar'}
                          title={r.status === 'paused' ? 'Reactivar' : 'Pausar'}
                          onClick={() => void togglePause(r)}
                        >
                          {r.status === 'paused' ? (
                            <Play className="h-4 w-4" />
                          ) : (
                            <Pause className="h-4 w-4" />
                          )}
                        </Button>
                      </>
                    )}
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Borrar"
                        title="Borrar"
                        onClick={() => void remove(r)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}

      <label className="flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={showDone} onCheckedChange={(v) => setShowDone(v === true)} />
        Mostrar los que ya están hechos
      </label>

      {system.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plazos que ya conocemos</CardTitle>
            <p className="text-sm text-muted-foreground">
              Salen solos de tus datos (certificado, documentos de los locales, tu suscripción). Se
              gestionan desde su sitio.
            </p>
          </CardHeader>
          <CardContent className="divide-y">
            {system.map((d) => (
              <Link
                key={d.key}
                href={d.href}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm hover:underline"
              >
                <span>
                  {d.title}
                  {d.detail ? <span className="text-muted-foreground"> · {d.detail}</span> : null}
                </span>
                <span
                  className={
                    d.daysLeft < 0
                      ? 'text-red-600 dark:text-red-400'
                      : d.daysLeft <= 30
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-muted-foreground'
                  }
                >
                  {formatDate(d.date)} · {reminderWhenLabel(d.daysLeft)}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      {editing && (
        <ReminderDialog
          reminder={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {completing && <CompleteDialog reminder={completing} onClose={() => setCompleting(null)} />}
      {snoozing && <SnoozeDialog reminder={snoozing} onClose={() => setSnoozing(null)} />}
      {history && <HistoryDialog reminder={history} onClose={() => setHistory(null)} />}
      {templatesOpen && <TemplatesDialog onClose={() => setTemplatesOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog canManage={canManage} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type FormState = CreateBusinessReminderInput & { extraEmailsText: string };

function initialForm(r: BusinessReminderDto | null): FormState {
  if (!r) {
    return {
      title: '',
      category: 'other',
      dueDate: localDateString(new Date()),
      recurrence: 'none',
      intervalMonths: null,
      notifyDaysBefore: BUSINESS_REMINDER_DEFAULT_DAYS.other,
      notifyEmail: true,
      notifyInApp: true,
      notifyPush: true,
      recipientMode: 'managers',
      recipientUserIds: [],
      extraEmails: [],
      extraEmailsText: '',
      overdueReminders: true,
      overdueMaxDays: 7,
      amount: null,
      vendor: '',
      link: '',
      notes: '',
      facilityId: null,
    };
  }
  return {
    title: r.title,
    category: r.category,
    dueDate: r.dueDate,
    recurrence: r.recurrence,
    intervalMonths: r.intervalMonths,
    notifyDaysBefore: r.notifyDaysBefore,
    notifyEmail: r.notifyEmail,
    notifyInApp: r.notifyInApp,
    notifyPush: r.notifyPush,
    recipientMode: r.recipientMode,
    recipientUserIds: r.recipientUserIds,
    extraEmails: r.extraEmails,
    extraEmailsText: r.extraEmails.join(', '),
    overdueReminders: r.overdueReminders,
    overdueMaxDays: r.overdueMaxDays,
    amount: r.amount,
    vendor: r.vendor ?? '',
    link: r.link ?? '',
    notes: r.notes ?? '',
    facilityId: r.facilityId,
  };
}

function ReminderDialog({
  reminder,
  onClose,
}: {
  reminder: BusinessReminderDto | null;
  onClose: () => void;
}) {
  const create = useCreateReminder();
  const update = useUpdateReminder();
  const facilities = useFacilities();
  const users = useUsers();
  const [f, setF] = useState<FormState>(() => initialForm(reminder));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));
  const busy = create.isPending || update.isPending;

  function toggleDay(d: number) {
    set(
      'notifyDaysBefore',
      f.notifyDaysBefore.includes(d)
        ? f.notifyDaysBefore.filter((x) => x !== d)
        : [...f.notifyDaysBefore, d].sort((a, b) => b - a),
    );
  }

  async function save() {
    const extraEmails = f.extraEmailsText
      .split(/[,;\s]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    const { extraEmailsText: _ignored, ...rest } = f;
    const input: CreateBusinessReminderInput = { ...rest, extraEmails };
    try {
      if (reminder) await update.mutateAsync({ id: reminder.id, input });
      else await create.mutateAsync(input);
      toast.success(reminder ? 'Guardado' : 'Vencimiento creado');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const activeUsers = (users.data ?? []).filter((u) => u.isActive);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{reminder ? 'Editar vencimiento' : 'Nuevo vencimiento'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="r-title">Qué vence</Label>
            <Input
              id="r-title"
              value={f.title}
              placeholder="Renovar el dominio trasterosgarcia.es"
              onChange={(e) => set('title', e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Tipo</Label>
              <Select
                value={f.category}
                onValueChange={(v) => {
                  const c = v as BusinessReminderCategory;
                  setF((prev) => ({
                    ...prev,
                    category: c,
                    // Si no se han tocado los días, se proponen los del tipo.
                    notifyDaysBefore: reminder
                      ? prev.notifyDaysBefore
                      : BUSINESS_REMINDER_DEFAULT_DAYS[c],
                  }));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BusinessReminderCategoryEnum.options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {BUSINESS_REMINDER_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Fecha</Label>
              <DateSelect value={f.dueDate} future onChange={(v) => v && set('dueDate', v)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Se repite</Label>
              <Select
                value={f.recurrence}
                onValueChange={(v) => set('recurrence', v as BusinessReminderRecurrence)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BusinessReminderRecurrenceEnum.options.map((r) => (
                    <SelectItem key={r} value={r}>
                      {BUSINESS_REMINDER_RECURRENCE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {f.recurrence === 'custom' && (
              <div className="grid gap-1.5">
                <Label htmlFor="r-interval">Cada cuántos meses</Label>
                <Input
                  id="r-interval"
                  type="number"
                  min={1}
                  max={60}
                  value={f.intervalMonths ?? ''}
                  onChange={(e) =>
                    set('intervalMonths', e.target.value ? Number(e.target.value) : null)
                  }
                />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label>Local</Label>
              <Select
                value={f.facilityId ?? 'none'}
                onValueChange={(v) => set('facilityId', v === 'none' ? null : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Toda la empresa</SelectItem>
                  {(facilities.data ?? []).map((fa) => (
                    <SelectItem key={fa.id} value={fa.id}>
                      {fa.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="r-amount">Importe (opcional)</Label>
              <Input
                id="r-amount"
                type="number"
                min={0}
                step="0.01"
                value={f.amount ?? ''}
                onChange={(e) => set('amount', e.target.value ? Number(e.target.value) : null)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="r-vendor">Proveedor (opcional)</Label>
              <Input
                id="r-vendor"
                value={f.vendor ?? ''}
                onChange={(e) => set('vendor', e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="r-link">Enlace (opcional)</Label>
              <Input
                id="r-link"
                value={f.link ?? ''}
                placeholder="https://"
                onChange={(e) => set('link', e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Avisar</Label>
            <div className="flex flex-wrap gap-1.5">
              {BUSINESS_REMINDER_DAY_OPTIONS.map((d) => {
                const on = f.notifyDaysBefore.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDay(d)}
                    aria-pressed={on}
                    className={`rounded-full border px-3 py-1 text-sm ${
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {d === 0 ? 'El mismo día' : d === 1 ? '1 día antes' : `${d} días antes`}
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={f.overdueReminders}
                onCheckedChange={(v) => set('overdueReminders', v === true)}
              />
              Si vence sin marcarlo hecho, seguir avisando cada día durante
              <Input
                type="number"
                min={1}
                max={60}
                className="h-8 w-16"
                value={f.overdueMaxDays}
                onChange={(e) => set('overdueMaxDays', Number(e.target.value) || 1)}
              />
              días
            </label>
          </div>

          <div className="grid gap-2">
            <Label>Cómo</Label>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={f.notifyEmail}
                  onCheckedChange={(v) => set('notifyEmail', v === true)}
                />
                Correo
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={f.notifyInApp}
                  onCheckedChange={(v) => set('notifyInApp', v === true)}
                />
                Avisos del panel
              </label>
              <label className="flex items-center gap-2">
                <Checkbox
                  checked={f.notifyPush}
                  onCheckedChange={(v) => set('notifyPush', v === true)}
                />
                Móvil (si tienes la app con avisos)
              </label>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>A quién</Label>
            <Select
              value={f.recipientMode}
              onValueChange={(v) => set('recipientMode', v as FormState['recipientMode'])}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managers">Propietarios y gestores (de ese local)</SelectItem>
                <SelectItem value="users">Elegir personas</SelectItem>
              </SelectContent>
            </Select>
            {f.recipientMode === 'users' && (
              <div className="grid gap-1.5 rounded-md border p-3 sm:grid-cols-2">
                {activeUsers.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={f.recipientUserIds.includes(u.id)}
                      onCheckedChange={(v) =>
                        set(
                          'recipientUserIds',
                          v === true
                            ? [...f.recipientUserIds, u.id]
                            : f.recipientUserIds.filter((x) => x !== u.id),
                        )
                      }
                    />
                    {u.fullName}
                  </label>
                ))}
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="r-extra">Correos de fuera del equipo (opcional)</Label>
              <Input
                id="r-extra"
                value={f.extraEmailsText}
                placeholder="asesoria@ejemplo.es"
                onChange={(e) => set('extraEmailsText', e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Por ejemplo tu asesoría. Hasta 5, separados por comas. Les llega el aviso por
                correo, sin acceso al panel.
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="r-notes">Notas (opcional)</Label>
            <Textarea
              id="r-notes"
              rows={2}
              value={f.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={busy || f.title.trim().length < 2}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({
  reminder,
  onClose,
}: {
  reminder: BusinessReminderDto;
  onClose: () => void;
}) {
  const complete = useCompleteReminder();
  const [amount, setAmount] = useState<string>(reminder.amount?.toString() ?? '');
  const [note, setNote] = useState('');
  const [registerExpense, setRegisterExpense] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const repeats = reminder.recurrence !== 'none';

  async function submit() {
    if (file && file.size > 10 * 1024 * 1024) {
      toast.error('El justificante no puede pasar de 10 MB');
      return;
    }
    try {
      const res = await complete.mutateAsync({
        id: reminder.id,
        input: {
          note,
          amount: amount ? Number(amount) : null,
          registerExpense: registerExpense && !!amount && Number(amount) > 0,
        },
        file,
      });
      toast.success(
        res.status === 'done'
          ? 'Marcado como hecho'
          : `Hecho. El siguiente, el ${formatDate(res.dueDate)}`,
      );
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Marcar como hecho</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            {reminder.title} · {formatDate(reminder.dueDate)}.{' '}
            {repeats
              ? 'Pasará a la siguiente fecha y volveremos a avisarte.'
              : 'No se repite: dejará de avisarte.'}
          </p>
          <div className="grid gap-1.5">
            <Label htmlFor="c-amount">Importe pagado (opcional)</Label>
            <Input
              id="c-amount"
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={registerExpense}
              disabled={!amount || Number(amount) <= 0}
              onCheckedChange={(v) => setRegisterExpense(v === true)}
            />
            Apuntarlo en Gastos
          </label>
          <div className="grid gap-1.5">
            <Label htmlFor="c-file">Justificante (opcional)</Label>
            <Input
              id="c-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <p className="text-xs text-muted-foreground">PDF, PNG o JPG, hasta 10 MB.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="c-note">Nota (opcional)</Label>
            <Textarea id="c-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={complete.isPending}>
            {complete.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Marcar hecho
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SnoozeDialog({
  reminder,
  onClose,
}: {
  reminder: BusinessReminderDto;
  onClose: () => void;
}) {
  const snooze = useSnoozeReminder();
  async function go(days: number) {
    try {
      await snooze.mutateAsync({ id: reminder.id, days });
      toast.success(days === 1 ? 'Te lo recordamos mañana' : `Te lo recordamos en ${days} días`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Posponer los avisos</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          La fecha de «{reminder.title}» no cambia; solo dejamos de avisarte hasta el día que
          elijas.
        </p>
        <div className="flex flex-wrap gap-2">
          {[1, 3, 7, 14].map((d) => (
            <Button
              key={d}
              variant="outline"
              disabled={snooze.isPending}
              onClick={() => void go(d)}
            >
              {d === 1 ? 'Mañana' : `${d} días`}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  reminder,
  onClose,
}: {
  reminder: BusinessReminderDto;
  onClose: () => void;
}) {
  const rows = useReminderCompletions(reminder.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Historial · {reminder.title}</DialogTitle>
        </DialogHeader>
        {rows.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (rows.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no se ha marcado como hecho.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.data!.map((c) => (
              <li key={c.id} className="space-y-1 py-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">Vencía el {formatDate(c.dueDate)}</span>
                  <span className="text-muted-foreground">{formatDateTime(c.completedAt)}</span>
                </div>
                <p className="text-muted-foreground">
                  {[
                    c.completedByName,
                    c.amount !== null ? formatEur(c.amount) : null,
                    c.expenseId ? 'apuntado en Gastos' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {c.note && <p>{c.note}</p>}
                {c.hasReceipt && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                    onClick={() =>
                      void openReminderReceipt(reminder.id, c.id).catch((err) =>
                        toast.error(errorMessage(err)),
                      )
                    }
                  >
                    <FileText className="size-3.5" /> {c.receiptName ?? 'Justificante'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TemplatesDialog({ onClose }: { onClose: () => void }) {
  const templates = useReminderTemplates();
  const apply = useApplyReminderTemplate();
  const [dates, setDates] = useState<Record<string, string>>({});

  async function add(t: ReminderTemplateDto) {
    const dueDate = dates[t.key];
    if (t.needsDate && !dueDate) {
      toast.error('Elige la fecha del próximo vencimiento');
      return;
    }
    try {
      const created = await apply.mutateAsync({ key: t.key, ...(dueDate ? { dueDate } : {}) });
      toast.success(
        created.length === 1 ? 'Vencimiento añadido' : `${created.length} vencimientos añadidos`,
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const render = (group: 'fiscal' | 'business') =>
    (templates.data ?? [])
      .filter((t) => t.group === group)
      .map((t) => (
        <div
          key={t.key}
          className="flex flex-col gap-2 border-b py-3 last:border-0 sm:flex-row sm:items-center"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            <p className="text-xs text-muted-foreground">
              {t.description}
              {t.count > 1 ? ` Crea ${t.count} vencimientos.` : ''}
            </p>
          </div>
          {t.needsDate && !t.applied && (
            <DateSelect
              value={dates[t.key]}
              future
              onChange={(v) => setDates((p) => ({ ...p, [t.key]: v ?? '' }))}
            />
          )}
          {t.applied ? (
            <Badge variant="secondary">Añadida</Badge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={apply.isPending}
              onClick={() => void add(t)}
            >
              <Plus className="mr-1 h-4 w-4" /> Añadir
            </Button>
          )}
        </div>
      ));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Plantillas</DialogTitle>
        </DialogHeader>
        {templates.isLoading ? (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold">Calendario fiscal</h3>
              <p className="mb-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Fechas orientativas del calendario de la AEAT. Añade solo los modelos que presentes
                y revisa las fechas con tu asesoría.
              </p>
              {render('fiscal')}
            </div>
            <div>
              <h3 className="text-sm font-semibold">Del negocio</h3>
              {render('business')}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SettingsDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const ask = useConfirm();
  const settings = useReminderSettings();
  const updateSettings = useUpdateReminderSettings();
  const calendar = useReminderCalendar();

  async function toggleDigest(v: boolean) {
    try {
      await updateSettings.mutateAsync(v);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function createCalendar(replace: boolean) {
    if (replace) {
      const ok = await ask({
        title: '¿Cambiar el enlace?',
        description: 'El enlace anterior dejará de funcionar en los calendarios donde lo añadiste.',
        confirmLabel: 'Cambiar',
      });
      if (!ok) return;
    }
    try {
      await calendar.mutateAsync('create');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function revokeCalendar() {
    try {
      await calendar.mutateAsync('revoke');
      toast.success('Enlace desactivado');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const icsUrl = settings.data?.icsUrl ?? null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustes de los vencimientos</DialogTitle>
        </DialogHeader>
        <div className="grid gap-5">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={settings.data?.weeklyDigest ?? false}
              disabled={!canManage || updateSettings.isPending}
              onCheckedChange={(v) => void toggleDigest(v === true)}
            />
            <span>
              Resumen semanal por correo
              <span className="block text-xs text-muted-foreground">
                Los lunes, a propietarios y gestores: lo vencido y lo que vence esa semana.
              </span>
            </span>
          </label>
          <div className="grid gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CalendarPlus className="size-4" /> En tu calendario
            </p>
            <p className="text-xs text-muted-foreground">
              Suscríbete desde Google Calendar («Añadir otro calendario → Desde URL») o desde el
              iPhone (Ajustes → Calendario → Cuentas → Añadir calendario suscrito).
            </p>
            {icsUrl ? (
              <>
                <div className="flex gap-2">
                  <Input readOnly value={icsUrl} onFocus={(e) => e.target.select()} />
                  <Button
                    variant="outline"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(icsUrl)
                        .then(() => toast.success('Enlace copiado'))
                    }
                  >
                    Copiar
                  </Button>
                </div>
                {canManage && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => void createCalendar(true)}>
                      Cambiar el enlace
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void revokeCalendar()}>
                      Desactivar
                    </Button>
                  </div>
                )}
              </>
            ) : canManage ? (
              <Button
                variant="outline"
                className="w-fit"
                disabled={calendar.isPending}
                onClick={() => void createCalendar(false)}
              >
                Crear enlace de calendario
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Aún no se ha creado.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
