'use client';

import {
  addDaysToDay,
  suggestNextFollowupDay,
  type AdminFollowupItemDto,
  type AdminFollowupKind,
  type AdminFollowupTab,
  type SuperAdminDto,
} from '@storageos/shared';
import {
  CalendarPlus,
  Check,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { AdminError } from '@/components/admin/admin-error';
import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAdminAuthStore } from '@/lib/admin/auth-store';
import { useAdminSuperAdmins } from '@/lib/admin/hooks';
import { tenantStatusLabel } from '@/lib/admin/labels';
import {
  useBulkAdminFollowups,
  useCreateAdminFollowup,
  useDeleteAdminFollowup,
  useFollowupInbox,
  useFollowupSubjectSearch,
  useUpdateAdminFollowup,
  type FollowupInboxQuery,
} from '@/lib/admin/tenant-ops-hooks';
import { ApiError } from '@/lib/auth/api';
import { localDateString } from '@/lib/dates';
import { formatDateTime, formatShortDay } from '@/lib/format';

const TABS: { value: AdminFollowupTab; label: string }[] = [
  { value: 'today', label: 'Hoy' },
  { value: 'overdue', label: 'Atrasados' },
  { value: 'upcoming', label: 'Próximos' },
  { value: 'done', label: 'Hechos' },
];

const POSTPONE_DAYS = [1, 3, 7, 14, 30];
const NONE = '__none__';

function dueBadge(due: string): { label: string; className: string } {
  const today = localDateString();
  if (due < today)
    return {
      label: `Vencido · ${formatShortDay(due)}`,
      className: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    };
  if (due === today)
    return {
      label: 'Hoy',
      className: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    };
  return { label: formatShortDay(due), className: 'bg-muted text-muted-foreground' };
}

const errorMessage = (err: unknown, fallback: string) =>
  err instanceof ApiError ? err.body.message : fallback;

/** Quien puede encargarse: activos y, en los de tenants, sin comerciales. */
function assignees(admins: SuperAdminDto[] | undefined, kind: AdminFollowupKind | 'any') {
  return (admins ?? []).filter((a) => a.isActive && (kind === 'lead' || a.role !== 'sales'));
}

export default function AdminFollowupsPage() {
  const ask = useConfirm();
  const [query, setQuery] = useState<FollowupInboxQuery>({
    tab: 'today',
    search: '',
    assignedTo: '',
    kind: '',
  });
  const [search, setSearch] = useState('');
  const inbox = useFollowupInbox(query);
  const admins = useAdminSuperAdmins();
  const update = useUpdateAdminFollowup();
  const remove = useDeleteAdminFollowup();
  const bulk = useBulkAdminFollowups();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminFollowupItemDto | null>(null);
  const [closing, setClosing] = useState<AdminFollowupItemDto[] | null>(null);

  const items = useMemo(() => inbox.data?.items ?? [], [inbox.data]);
  const keyOf = (f: AdminFollowupItemDto) => `${f.kind}:${f.id}`;
  const chosen = items.filter((f) => selected.has(keyOf(f)));
  const allChosen = items.length > 0 && chosen.length === items.length;
  const canSelect = query.tab !== 'done';

  function setTab(tab: AdminFollowupTab) {
    setSelected(new Set());
    setQuery((q) => ({ ...q, tab }));
  }

  function runSearch() {
    setSelected(new Set());
    setQuery((q) => ({ ...q, search }));
  }

  function toggle(f: AdminFollowupItemDto) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(f);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  async function runBulk(
    action: 'postpone' | 'assign',
    extra: { days?: number; assignedToId?: string | null },
  ) {
    try {
      const res = await bulk.mutateAsync({
        items: chosen.map((f) => ({ kind: f.kind, id: f.id })),
        action,
        ...extra,
      });
      toast.success(
        `${res.updated} actualizado(s)${res.skipped ? ` · ${res.skipped} sin cambiar` : ''}.`,
      );
      setSelected(new Set());
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudieron actualizar.'));
    }
  }

  function postpone(f: AdminFollowupItemDto, days: number) {
    const day = addDaysToDay(localDateString(), days);
    update.mutate(
      { kind: f.kind, id: f.id, input: { dueDate: day } },
      {
        onSuccess: () => toast.success(`Pospuesto al ${formatShortDay(day)}.`),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo posponer.')),
      },
    );
  }

  function reopen(f: AdminFollowupItemDto) {
    update.mutate(
      { kind: f.kind, id: f.id, input: { status: 'pending' } },
      {
        onSuccess: () => toast.success('Seguimiento reabierto.'),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo reabrir.')),
      },
    );
  }

  async function onDelete(f: AdminFollowupItemDto) {
    if (!(await ask({ title: '¿Borrar este seguimiento?', destructive: true }))) return;
    remove.mutate(
      { kind: f.kind, id: f.id },
      {
        onSuccess: () => toast.success('Seguimiento borrado.'),
        onError: (err) => toast.error(errorMessage(err, 'No se pudo borrar.')),
      },
    );
  }

  const counts = inbox.data?.counts;
  const everyone = assignees(admins.data, 'any');

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Seguimientos</h1>
          <p className="text-sm text-muted-foreground">
            Recordatorios con los tenants y con los leads, juntos. Los de los prospectos de los
            comerciales los lleva cada comercial.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 size-4" /> Nuevo seguimiento
        </Button>
      </div>

      <Tabs value={query.tab} onValueChange={(v) => setTab(v as AdminFollowupTab)}>
        <TabsList className="h-auto flex-wrap">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {counts ? (
                <span
                  className={`ml-1.5 rounded-full px-1.5 text-xs ${
                    t.value === 'overdue' && counts.overdue > 0
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {counts[t.value]}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <form
          className="flex flex-1 gap-2 sm:min-w-[240px]"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={runSearch}
            placeholder="Buscar por título, tenant o lead"
            aria-label="Buscar"
          />
          <Button type="submit" variant="outline" size="icon" aria-label="Buscar">
            <Search className="size-4" />
          </Button>
        </form>
        <Select
          value={query.assignedTo || 'all'}
          onValueChange={(v) => {
            setSelected(new Set());
            setQuery((q) => ({ ...q, assignedTo: v === 'all' ? '' : v }));
          }}
        >
          <SelectTrigger className="sm:w-48" aria-label="Responsable">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos los responsables</SelectItem>
            <SelectItem value="mine">Solo los míos</SelectItem>
            <SelectItem value="none">Sin asignar</SelectItem>
            {everyone.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.kind || 'all'}
          onValueChange={(v) => {
            setSelected(new Set());
            setQuery((q) => ({ ...q, kind: v === 'all' ? '' : (v as AdminFollowupKind) }));
          }}
        >
          <SelectTrigger className="sm:w-40" aria-label="Tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Tenants y leads</SelectItem>
            <SelectItem value="tenant">Solo tenants</SelectItem>
            <SelectItem value="lead">Solo leads</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {canSelect && chosen.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
          <span className="font-medium">{chosen.length} seleccionado(s)</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={bulk.isPending}>
                <CalendarPlus className="mr-1.5 size-4" /> Posponer
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {POSTPONE_DAYS.map((d) => (
                <DropdownMenuItem key={d} onSelect={() => void runBulk('postpone', { days: d })}>
                  {d === 1 ? 'A mañana' : `${d} días`}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={bulk.isPending}>
                <UserRound className="mr-1.5 size-4" /> Reasignar
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onSelect={() => void runBulk('assign', { assignedToId: null })}>
                Sin asignar
              </DropdownMenuItem>
              {assignees(admins.data, 'tenant').map((a) => (
                <DropdownMenuItem
                  key={a.id}
                  onSelect={() => void runBulk('assign', { assignedToId: a.id })}
                >
                  {a.fullName}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={() => setClosing(chosen)} disabled={bulk.isPending}>
            <Check className="mr-1.5 size-4" /> Marcar hechos
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Limpiar
          </Button>
        </div>
      ) : null}

      {inbox.isError ? (
        <AdminError onRetry={() => void inbox.refetch()} />
      ) : inbox.isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {query.tab === 'done'
              ? 'Nada hecho en los últimos 30 días con estos filtros.'
              : 'Nada por aquí. 🎉'}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {canSelect ? (
              <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={allChosen}
                  onCheckedChange={() =>
                    setSelected(allChosen ? new Set() : new Set(items.map(keyOf)))
                  }
                  aria-label="Seleccionar todos"
                />
                Seleccionar todos
              </div>
            ) : null}
            <ul className="divide-y">
              {items.map((f) => (
                <InboxRow
                  key={keyOf(f)}
                  f={f}
                  selectable={canSelect}
                  selected={selected.has(keyOf(f))}
                  onToggle={() => toggle(f)}
                  onEdit={() => setEditing(f)}
                  onDone={() => setClosing([f])}
                  onPostpone={(d) => postpone(f, d)}
                  onReopen={() => reopen(f)}
                  onDelete={() => void onDelete(f)}
                  busy={update.isPending || remove.isPending}
                />
              ))}
            </ul>
            {inbox.data?.truncated ? (
              <p className="border-t px-4 py-2 text-xs text-muted-foreground">
                Se muestran los {items.length} primeros. Usa el buscador o los filtros para ver el
                resto.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <CreateFollowupDialog open={creating} onOpenChange={setCreating} admins={admins.data} />
      <EditFollowupDialog item={editing} onClose={() => setEditing(null)} admins={admins.data} />
      <DoneDialog
        items={closing}
        onClose={(done) => {
          setClosing(null);
          if (done) setSelected(new Set());
        }}
      />
    </div>
  );
}

function InboxRow({
  f,
  selectable,
  selected,
  onToggle,
  onEdit,
  onDone,
  onPostpone,
  onReopen,
  onDelete,
  busy,
}: {
  f: AdminFollowupItemDto;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDone: () => void;
  onPostpone: (days: number) => void;
  onReopen: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const due = dueBadge(f.dueDate);
  const done = f.status === 'done';
  const href =
    f.kind === 'tenant' ? `/admin/tenants/${f.subjectId}` : `/admin/leads?lead=${f.subjectId}`;
  const status = f.kind === 'tenant' && f.subjectStatus ? tenantStatusLabel(f.subjectStatus) : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start">
      {selectable ? (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Seleccionar ${f.title}`}
          className="mt-1 hidden sm:inline-flex"
        />
      ) : null}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {selectable ? (
            <Checkbox
              checked={selected}
              onCheckedChange={onToggle}
              aria-label={`Seleccionar ${f.title}`}
              className="sm:hidden"
            />
          ) : null}
          <span className="break-words font-medium">{f.title}</span>
          <Badge variant="outline">{f.kind === 'tenant' ? 'Tenant' : 'Lead'}</Badge>
          {!done ? <Badge className={`border-0 ${due.className}`}>{due.label}</Badge> : null}
        </div>
        <div className="text-xs text-muted-foreground">
          <Link href={href} className="font-medium text-foreground hover:underline">
            {f.subjectName}
          </Link>
          {status ? ` · ${status}` : ''}
          {f.assignedToName ? ` · se encarga ${f.assignedToName}` : ' · sin asignar'}
        </div>
        {f.note ? (
          <p className="whitespace-pre-line text-xs text-muted-foreground">{f.note}</p>
        ) : null}
        {done ? (
          <p className="text-xs text-muted-foreground">
            Hecho {formatDateTime(f.completedAt)}
            {f.completedByName ? ` por ${f.completedByName}` : ''}
            {f.outcome ? (
              <span className="block whitespace-pre-line text-foreground">
                Qué pasó: {f.outcome}
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {done ? (
          <Button size="sm" variant="outline" onClick={onReopen} disabled={busy}>
            <RotateCcw className="mr-1 size-4" /> Reabrir
          </Button>
        ) : (
          <>
            <Button size="icon" variant="ghost" onClick={onEdit} aria-label="Editar" title="Editar">
              <Pencil className="size-4 text-muted-foreground" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label="Posponer" title="Posponer">
                  <CalendarPlus className="size-4 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {POSTPONE_DAYS.map((d) => (
                  <DropdownMenuItem key={d} onSelect={() => onPostpone(d)}>
                    {d === 1 ? 'A mañana' : `${d} días`}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" variant="outline" onClick={onDone} disabled={busy}>
              <Check className="mr-1 size-4" /> Hecho
            </Button>
          </>
        )}
        <Button
          size="icon"
          variant="ghost"
          onClick={onDelete}
          disabled={busy}
          aria-label="Borrar seguimiento"
        >
          <Trash2 className="size-4 text-muted-foreground" />
        </Button>
      </div>
    </li>
  );
}

function AssigneeSelect({
  value,
  onChange,
  admins,
  kind,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  admins: SuperAdminDto[] | undefined;
  kind: AdminFollowupKind;
}) {
  return (
    <Select value={value ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger aria-label="Quién se encarga">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Sin asignar</SelectItem>
        {assignees(admins, kind).map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.fullName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreateFollowupDialog({
  open,
  onOpenChange,
  admins,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  admins: SuperAdminDto[] | undefined;
}) {
  const me = useAdminAuthStore((s) => s.superAdmin?.id ?? null);
  const create = useCreateAdminFollowup();
  const [kind, setKind] = useState<AdminFollowupKind>('tenant');
  const [term, setTerm] = useState('');
  const [subject, setSubject] = useState<{ id: string; name: string } | null>(null);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [dueDate, setDueDate] = useState<string | undefined>(() =>
    addDaysToDay(localDateString(), 3),
  );
  const [assignedToId, setAssignedToId] = useState<string | null>(me);
  const results = useFollowupSubjectSearch(kind, term);

  function reset() {
    setKind('tenant');
    setTerm('');
    setSubject(null);
    setTitle('');
    setNote('');
    setDueDate(addDaysToDay(localDateString(), 3));
    setAssignedToId(me);
  }

  async function submit() {
    if (!subject || !title.trim() || !dueDate) return;
    try {
      await create.mutateAsync({
        kind,
        subjectId: subject.id,
        title: title.trim(),
        dueDate,
        assignedToId,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success('Seguimiento creado.');
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo crear.'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nuevo seguimiento</DialogTitle>
          <DialogDescription>Un recordatorio con un tenant o con un lead.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Tabs
            value={kind}
            onValueChange={(v) => {
              setKind(v as AdminFollowupKind);
              setSubject(null);
              setTerm('');
            }}
          >
            <TabsList>
              <TabsTrigger value="tenant">Tenant</TabsTrigger>
              <TabsTrigger value="lead">Lead</TabsTrigger>
            </TabsList>
          </Tabs>
          {subject ? (
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
              <span className="font-medium">{subject.name}</span>
              <Button size="sm" variant="ghost" onClick={() => setSubject(null)}>
                Cambiar
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="fu-search">{kind === 'tenant' ? 'Tenant' : 'Lead'}</Label>
              <Input
                id="fu-search"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder={
                  kind === 'tenant' ? 'Nombre o identificador' : 'Empresa, contacto o email'
                }
              />
              {results.isFetching ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : null}
              {(results.data ?? []).length > 0 ? (
                <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
                  {(results.data ?? []).map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="w-full px-3 py-2 text-left text-sm hover:bg-muted"
                        onClick={() => setSubject({ id: r.id, name: r.name })}
                      >
                        <span className="font-medium">{r.name}</span>{' '}
                        <span className="text-xs text-muted-foreground">{r.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : term.trim().length >= 2 && !results.isFetching ? (
                <p className="text-xs text-muted-foreground">Sin resultados.</p>
              ) : null}
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="fu-title">Qué hay que hacer</Label>
            <Input
              id="fu-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Llamar para ver cómo va"
            />
          </div>
          <div className="space-y-1">
            <Label>Fecha</Label>
            <DateSelect value={dueDate} onChange={setDueDate} future />
          </div>
          <div className="space-y-1">
            <Label>Quién se encarga</Label>
            <AssigneeSelect
              value={assignedToId}
              onChange={setAssignedToId}
              admins={admins}
              kind={kind}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="fu-note">Nota (opcional)</Label>
            <Textarea
              id="fu-note"
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => void submit()}
            disabled={!subject || !title.trim() || !dueDate || create.isPending}
          >
            {create.isPending ? 'Creando…' : 'Crear seguimiento'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditFollowupDialog({
  item,
  onClose,
  admins,
}: {
  item: AdminFollowupItemDto | null;
  onClose: () => void;
  admins: SuperAdminDto[] | undefined;
}) {
  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {item ? (
          <EditFollowupForm
            key={`${item.kind}:${item.id}`}
            item={item}
            onClose={onClose}
            admins={admins}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EditFollowupForm({
  item,
  onClose,
  admins,
}: {
  item: AdminFollowupItemDto;
  onClose: () => void;
  admins: SuperAdminDto[] | undefined;
}) {
  const update = useUpdateAdminFollowup();
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? '');
  const [dueDate, setDueDate] = useState<string | undefined>(item.dueDate);
  const [assignedToId, setAssignedToId] = useState<string | null>(item.assignedToId);

  async function submit() {
    if (!title.trim() || !dueDate) return;
    try {
      await update.mutateAsync({
        kind: item.kind,
        id: item.id,
        input: {
          title: title.trim(),
          note: note.trim() || null,
          ...(dueDate !== item.dueDate ? { dueDate } : {}),
          ...(assignedToId !== item.assignedToId ? { assignedToId } : {}),
        },
      });
      toast.success('Seguimiento guardado.');
      onClose();
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar.'));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Editar seguimiento</DialogTitle>
        <DialogDescription>{item.subjectName}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="fe-title">Qué hay que hacer</Label>
          <Input
            id="fe-title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>Fecha</Label>
          <DateSelect value={dueDate} onChange={setDueDate} future />
        </div>
        <div className="space-y-1">
          <Label>Quién se encarga</Label>
          <AssigneeSelect
            value={assignedToId}
            onChange={setAssignedToId}
            admins={admins}
            kind={item.kind}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="fe-note">Nota</Label>
          <Textarea
            id="fe-note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={!title.trim() || !dueDate || update.isPending}
        >
          {update.isPending ? 'Guardando…' : 'Guardar'}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Marcar hechos (uno o varios) con «qué pasó» y, si es uno, proponer el
 * siguiente seguimiento.
 */
function DoneDialog({
  items,
  onClose,
}: {
  items: AdminFollowupItemDto[] | null;
  onClose: (done: boolean) => void;
}) {
  return (
    <Dialog open={!!items} onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {items ? (
          <DoneForm key={items.map((i) => i.id).join(',')} items={items} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DoneForm({
  items,
  onClose,
}: {
  items: AdminFollowupItemDto[];
  onClose: (done: boolean) => void;
}) {
  const update = useUpdateAdminFollowup();
  const bulk = useBulkAdminFollowups();
  const create = useCreateAdminFollowup();
  const single = items.length === 1 ? items[0]! : null;
  const today = localDateString();
  const [outcome, setOutcome] = useState('');
  const [next, setNext] = useState(!!single);
  const [nextTitle, setNextTitle] = useState(single?.title ?? '');
  const [nextDate, setNextDate] = useState<string | undefined>(
    suggestNextFollowupDay(today, single?.dueDate),
  );
  const busy = update.isPending || bulk.isPending || create.isPending;

  async function submit() {
    try {
      if (single) {
        await update.mutateAsync({
          kind: single.kind,
          id: single.id,
          input: { status: 'done', ...(outcome.trim() ? { outcome: outcome.trim() } : {}) },
        });
        if (next && nextTitle.trim() && nextDate) {
          await create.mutateAsync({
            kind: single.kind,
            subjectId: single.subjectId,
            title: nextTitle.trim(),
            dueDate: nextDate,
            assignedToId: single.assignedToId,
          });
          toast.success(`Hecho. Siguiente seguimiento el ${formatShortDay(nextDate)}.`);
        } else {
          toast.success('Seguimiento hecho.');
        }
      } else {
        const res = await bulk.mutateAsync({
          items: items.map((f) => ({ kind: f.kind, id: f.id })),
          action: 'done',
          ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
        });
        toast.success(
          `${res.updated} hecho(s)${res.skipped ? ` · ${res.skipped} sin cambiar` : ''}.`,
        );
      }
      onClose(true);
    } catch (err) {
      toast.error(errorMessage(err, 'No se pudo guardar.'));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{single ? 'Marcar hecho' : `Marcar ${items.length} hechos`}</DialogTitle>
        <DialogDescription>
          {single
            ? `${single.title} · ${single.subjectName}`
            : 'Lo que escribas se guarda en cada uno.'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="fd-outcome">Qué pasó (opcional)</Label>
          <Textarea
            id="fd-outcome"
            value={outcome}
            maxLength={2000}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="Le he llamado: lo mira con su socio y nos dice el lunes"
          />
          <p className="text-xs text-muted-foreground">
            Queda también en la conversación del tenant o en la actividad del lead.
          </p>
        </div>
        {single ? (
          <div className="space-y-2 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={next} onCheckedChange={(v) => setNext(v === true)} />
              Crear el siguiente seguimiento
            </label>
            {next ? (
              <>
                <Input
                  value={nextTitle}
                  maxLength={200}
                  onChange={(e) => setNextTitle(e.target.value)}
                  aria-label="Título del siguiente"
                />
                <DateSelect value={nextDate} onChange={setNextDate} future />
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onClose(false)}>
          Cancelar
        </Button>
        <Button
          onClick={() => void submit()}
          disabled={busy || (next && (!nextTitle.trim() || !nextDate))}
        >
          {busy ? 'Guardando…' : 'Marcar hecho'}
        </Button>
      </DialogFooter>
    </>
  );
}
