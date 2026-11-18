'use client';

import {
  SALES_COMMISSION_KIND_LABELS,
  SALES_COMMISSION_STATUS_LABELS,
  SALES_SOURCE_LABELS,
  type SalesCommissionConceptDto,
  type SalesRepDetailDto,
} from '@storageos/shared';
import { ArrowLeft, Loader2, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import {
  CopyButton,
  Empty,
  errorText,
  Field,
  QueryState,
  relativeDays,
  SalesPage,
  Stat,
  TenantStatusBadge,
  todayInSpain,
} from '@/components/admin/sales/common';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateCommissionItem,
  useCreateSettlement,
  useDecideItem,
  useDeleteSalesConcept,
  useReassignPortfolio,
  useSalesRep,
  useSalesRepAccounts,
  useSalesTeam,
  useSaveSalesConcept,
  useSaveSalesPlan,
  useSaveSalesTarget,
  useSetSalesRepActive,
  useSettlementPaid,
  useTeamCommissions,
  useTeamSettlements,
  useUpdateSalesRep,
} from '@/lib/admin/sales-team-hooks';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatEur, parseAmount } from '@/lib/format';
import { cn } from '@/lib/utils';

const NONE = '-';

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const label = new Date(y, m - 1, 1).toLocaleDateString('es-ES', {
    month: 'long',
    year: 'numeric',
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Los últimos meses y el siguiente (AAAA-MM), del más reciente al más antiguo. */
function monthOptions(back: number, ahead: number): string[] {
  const [y, m] = todayInSpain().split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = ahead; i >= -back; i--) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/** Importe escrito («1.500,50»); vacío = 0. Si no es un número, avisa y no guarda. */
function money(v: string): number {
  if (!v.trim()) return 0;
  const n = parseAmount(v);
  if (n === null) {
    throw new ApiError({
      statusCode: 400,
      error: 'Bad Request',
      code: 'invalid_amount',
      message: `«${v}» no es un importe válido`,
    });
  }
  return n;
}

/** Lo mismo sin avisar (para activar o desactivar botones). */
function moneyOrNaN(v: string): number {
  return v.trim() ? (parseAmount(v) ?? Number.NaN) : 0;
}

function EditRepDialog({ rep, onClose }: { rep: SalesRepDetailDto; onClose: () => void }) {
  const save = useUpdateSalesRep(rep.id);
  const [form, setForm] = useState({
    fullName: rep.fullName,
    phone: rep.phone ?? '',
    whatsapp: rep.whatsapp ?? '',
    bookingUrl: rep.bookingUrl ?? '',
    salesCode: rep.salesCode ?? '',
  });
  async function submit() {
    try {
      await save.mutateAsync({
        fullName: form.fullName.trim(),
        phone: form.phone.trim() || null,
        whatsapp: form.whatsapp.trim() || null,
        bookingUrl: form.bookingUrl.trim() || null,
        ...(form.salesCode.trim() && form.salesCode.trim() !== rep.salesCode
          ? { salesCode: form.salesCode.trim() }
          : {}),
      });
      toast.success('Guardado.');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar comercial</DialogTitle>
          <DialogDescription>
            Si cambias el código, su enlace y su QR antiguos dejan de valer.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Nombre">
            <Input
              value={form.fullName}
              maxLength={120}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
            />
          </Field>
          <Field label="Código">
            <Input
              value={form.salesCode}
              maxLength={12}
              onChange={(e) => setForm((f) => ({ ...f, salesCode: e.target.value.toUpperCase() }))}
            />
          </Field>
          <Field label="Teléfono">
            <Input
              value={form.phone}
              maxLength={30}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
            />
          </Field>
          <Field label="WhatsApp">
            <Input
              value={form.whatsapp}
              maxLength={30}
              onChange={(e) => setForm((f) => ({ ...f, whatsapp: e.target.value }))}
            />
          </Field>
          <Field label="Enlace para reservar demos">
            <Input
              value={form.bookingUrl}
              maxLength={500}
              onChange={(e) => setForm((f) => ({ ...f, bookingUrl: e.target.value }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={form.fullName.trim().length < 2 || save.isPending}
            onClick={() => void submit()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanCard({ rep }: { rep: SalesRepDetailDto }) {
  const save = useSaveSalesPlan(rep.id);
  const p = rep.plan;
  const [form, setForm] = useState({
    revenuePct: String(p.revenuePct),
    revenueMonths: p.revenueMonths === null ? '' : String(p.revenueMonths),
    perSaleAmount: String(p.perSaleAmount),
    perAddonAmount: String(p.perAddonAmount),
    notes: p.notes ?? '',
  });
  useEffect(() => {
    setForm({
      revenuePct: String(p.revenuePct),
      revenueMonths: p.revenueMonths === null ? '' : String(p.revenueMonths),
      perSaleAmount: String(p.perSaleAmount),
      perAddonAmount: String(p.perAddonAmount),
      notes: p.notes ?? '',
    });
  }, [p.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    try {
      const months = form.revenueMonths.trim() ? Math.floor(money(form.revenueMonths)) : null;
      await save.mutateAsync({
        revenuePct: Math.min(100, Math.max(0, money(form.revenuePct))),
        revenueMonths: months && months > 0 ? months : null,
        perSaleAmount: Math.max(0, money(form.perSaleAmount)),
        perAddonAmount: Math.max(0, money(form.perAddonAmount)),
        notes: form.notes.trim() || null,
      });
      toast.success('Condiciones guardadas. Valen para lo que se cobre a partir de ahora.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sus condiciones</CardTitle>
        <CardDescription>
          Las ve el comercial. Los extras que contrate un cliente después de la venta solo cuentan
          si los apruebas.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="% de lo que pagan sus clientes (sin IVA)">
            <Input
              inputMode="decimal"
              value={form.revenuePct}
              onChange={(e) => setForm((f) => ({ ...f, revenuePct: e.target.value }))}
            />
          </Field>
          <Field label="Durante los primeros (meses)" hint="Vacío = mientras sigan pagando.">
            <Input
              inputMode="numeric"
              value={form.revenueMonths}
              onChange={(e) => setForm((f) => ({ ...f, revenueMonths: e.target.value }))}
            />
          </Field>
          <Field label="Fijo por venta (€)" hint="Cuando un cliente suyo paga por primera vez.">
            <Input
              inputMode="decimal"
              value={form.perSaleAmount}
              onChange={(e) => setForm((f) => ({ ...f, perSaleAmount: e.target.value }))}
            />
          </Field>
          <Field label="Fijo por extra aprobado (€)" hint="Extras contratados después de la venta.">
            <Input
              inputMode="decimal"
              value={form.perAddonAmount}
              onChange={(e) => setForm((f) => ({ ...f, perAddonAmount: e.target.value }))}
            />
          </Field>
          <Field label="Notas (las ve el comercial)" className="sm:col-span-2">
            <Textarea
              rows={2}
              value={form.notes}
              maxLength={2000}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Guardar condiciones
          </Button>
        </div>
        <ConceptsBlock repId={rep.id} concepts={p.concepts} />
      </CardContent>
    </Card>
  );
}

function ConceptsBlock({
  repId,
  concepts,
}: {
  repId: string;
  concepts: SalesCommissionConceptDto[];
}) {
  const save = useSaveSalesConcept(repId);
  const remove = useDeleteSalesConcept(repId);
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  async function add() {
    try {
      await save.mutateAsync({
        conceptId: null,
        input: { name: name.trim(), amount: money(amount), isActive: true },
      });
      setName('');
      setAmount('');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-medium">Trabajos extra que cobra</p>
      <p className="text-xs text-muted-foreground">
        Por ejemplo, «Migración de datos». El comercial lo anota por un cliente y tú lo apruebas.
      </p>
      {concepts.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {concepts.map((c) => (
            <li key={c.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className={cn('flex-1', !c.isActive && 'text-muted-foreground line-through')}>
                {c.name}
              </span>
              <span className="tabular-nums">{formatEur(c.amount)}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void save
                    .mutateAsync({
                      conceptId: c.id,
                      input: { name: c.name, amount: c.amount, isActive: !c.isActive },
                    })
                    .catch((e) => toast.error(errorText(e)))
                }
              >
                {c.isActive ? 'Desactivar' : 'Activar'}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Borrar"
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: `Borrar «${c.name}»`,
                      confirmLabel: 'Borrar',
                      destructive: true,
                    }))
                  )
                    return;
                  remove.mutate(c.id, { onError: (e) => toast.error(errorText(e)) });
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-[180px] flex-1"
          placeholder="Concepto"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          className="w-28"
          inputMode="decimal"
          placeholder="€"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={name.trim().length < 2 || !(moneyOrNaN(amount) > 0) || save.isPending}
          onClick={() => void add()}
        >
          <Plus className="mr-1 size-4" />
          Añadir
        </Button>
      </div>
    </div>
  );
}

function TargetsCard({ rep }: { rep: SalesRepDetailDto }) {
  const save = useSaveSalesTarget(rep.id);
  const months = monthOptions(2, 2);
  const [month, setMonth] = useState(todayInSpain().slice(0, 7));
  const current = rep.targets.find((t) => t.month === month);
  const [clients, setClients] = useState('');
  const [mrr, setMrr] = useState('');
  useEffect(() => {
    setClients(current ? String(current.newClients) : '');
    setMrr(current ? String(current.newMrr) : '');
  }, [month, current?.newClients, current?.newMrr]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    try {
      await save.mutateAsync({
        month,
        newClients: Math.max(0, Math.floor(money(clients))),
        newMrr: Math.max(0, money(mrr)),
      });
      toast.success('Objetivo guardado.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Objetivos</CardTitle>
        <CardDescription>
          Clientes nuevos y cuotas nuevas al mes. Los ve en su «Hoy».
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-4">
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="sm:col-span-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m} value={m}>
                  {monthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            inputMode="numeric"
            placeholder="Clientes"
            value={clients}
            onChange={(e) => setClients(e.target.value)}
          />
          <Input
            inputMode="decimal"
            placeholder="€/mes"
            value={mrr}
            onChange={(e) => setMrr(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={save.isPending} onClick={() => void submit()}>
            Guardar objetivo
          </Button>
        </div>
        {rep.targets.length > 0 && (
          <ul className="divide-y rounded-md border">
            {rep.targets.map((t) => (
              <li key={t.month} className="flex flex-wrap justify-between gap-2 px-3 py-1.5">
                <span>{monthLabel(t.month)}</span>
                <span className="text-muted-foreground">
                  {t.achieved.newClients}/{t.newClients} clientes · {formatEur(t.achieved.newMrr)}/
                  {formatEur(t.newMrr)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AdjustmentDialog({ rep, onClose }: { rep: SalesRepDetailDto; onClose: () => void }) {
  const accounts = useSalesRepAccounts(rep.id);
  const create = useCreateCommissionItem();
  const [kind, setKind] = useState<'adjustment' | 'concept'>('adjustment');
  const [tenantId, setTenantId] = useState('');
  const [conceptId, setConceptId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');

  async function submit() {
    try {
      await create.mutateAsync({
        repId: rep.id,
        tenantId,
        kind,
        ...(kind === 'concept' ? { conceptId } : {}),
        ...(amount.trim() ? { amount: money(amount) } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast.success('Añadido (aprobado).');
      onClose();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const clients = accounts.data?.clients ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Añadir a sus comisiones</DialogTitle>
          <DialogDescription>
            Un trabajo extra o un ajuste (en negativo, para descontar).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Tipo">
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="adjustment">Ajuste</SelectItem>
                <SelectItem value="concept">Trabajo extra</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cliente">
            <Select value={tenantId} onValueChange={setTenantId}>
              <SelectTrigger>
                <SelectValue placeholder="Elige un cliente" />
              </SelectTrigger>
              <SelectContent>
                {clients.map((c) => (
                  <SelectItem key={c.tenantId} value={c.tenantId}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {kind === 'concept' && (
            <Field label="Concepto">
              <Select value={conceptId} onValueChange={setConceptId}>
                <SelectTrigger>
                  <SelectValue placeholder="Elige un concepto" />
                </SelectTrigger>
                <SelectContent>
                  {rep.plan.concepts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {formatEur(c.amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field
            label={
              kind === 'concept' ? 'Importe (vacío = el del concepto)' : 'Importe (€, con signo)'
            }
          >
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={kind === 'concept' ? 'Detalle (opcional)' : 'Motivo'}>
            <Input
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={
              !tenantId ||
              (kind === 'concept' && !conceptId) ||
              (kind === 'adjustment' &&
                (!moneyOrNaN(amount) || Number.isNaN(moneyOrNaN(amount)) || !description.trim())) ||
              create.isPending
            }
            onClick={() => void submit()}
          >
            Añadir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CommissionsTab({ rep }: { rep: SalesRepDetailDto }) {
  const [month, setMonth] = useState<string>(NONE);
  const items = useTeamCommissions({ repId: rep.id, ...(month !== NONE ? { month } : {}) });
  const settlements = useTeamSettlements(rep.id);
  const decide = useDecideItem();
  const createSettlement = useCreateSettlement();
  const paid = useSettlementPaid();
  const confirm = useConfirm();
  const [adjOpen, setAdjOpen] = useState(false);
  const months = monthOptions(12, 0);
  const [settleMonth, setSettleMonth] = useState(months[1] ?? months[0]!);
  const rows = items.data ?? [];

  async function settle() {
    const ok = await confirm({
      title: `Liquidar ${monthLabel(settleMonth)}`,
      description:
        'Junta todas sus comisiones aprobadas y sin liquidar hasta ese mes y la da por pagada en efectivo. No se le avisa: la verá en «Mis comisiones».',
      confirmLabel: 'Liquidar',
    });
    if (!ok) return;
    try {
      const s = await createSettlement.mutateAsync({ repId: rep.id, month: settleMonth });
      toast.success(`Liquidado ${formatEur(s.total)} en efectivo.`);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Todos los meses</SelectItem>
            {months.map((m) => (
              <SelectItem key={m} value={m}>
                {monthLabel(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => setAdjOpen(true)}>
          <Plus className="mr-1 size-4" />
          Ajuste o trabajo extra
        </Button>
      </div>
      {adjOpen && <AdjustmentDialog rep={rep} onClose={() => setAdjOpen(false)} />}
      {items.isLoading || items.isError ? (
        <QueryState query={items} />
      ) : rows.length === 0 ? (
        <Empty>Sin movimientos.</Empty>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mes</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Concepto</TableHead>
                <TableHead className="text-right">Importe</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="whitespace-nowrap text-xs">{monthLabel(i.month)}</TableCell>
                  <TableCell className="text-sm">
                    <Link href={`/admin/tenants/${i.tenantId}`} className="hover:underline">
                      {i.tenantName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">
                    {SALES_COMMISSION_KIND_LABELS[i.kind]}
                    <span className="block text-xs text-muted-foreground">{i.description}</span>
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums',
                      i.amount < 0 && 'text-rose-600 dark:text-rose-400',
                    )}
                  >
                    {formatEur(i.amount)}
                  </TableCell>
                  <TableCell>
                    {i.status === 'pending' ? (
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void decide
                              .mutateAsync({ id: i.id, approve: true })
                              .catch((e) => toast.error(errorText(e)))
                          }
                        >
                          Aprobar
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const r = await confirm({
                              title: 'Rechazar',
                              input: { label: 'Motivo (lo ve el comercial)' },
                              destructive: true,
                              confirmLabel: 'Rechazar',
                            });
                            if (!r) return;
                            await decide
                              .mutateAsync({
                                id: i.id,
                                approve: false,
                                ...(r.value ? { note: r.value } : {}),
                              })
                              .catch((e) => toast.error(errorText(e)));
                          }}
                        >
                          Rechazar
                        </Button>
                      </div>
                    ) : (
                      <Badge variant={i.status === 'approved' ? 'default' : 'destructive'}>
                        {i.settlementId ? 'Liquidada' : SALES_COMMISSION_STATUS_LABELS[i.status]}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Liquidaciones</CardTitle>
          <CardDescription>Lo que le pagas en efectivo cada mes.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={settleMonth} onValueChange={setSettleMonth}>
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {monthLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" disabled={createSettlement.isPending} onClick={() => void settle()}>
              Liquidar
            </Button>
          </div>
          {settlements.isLoading || settlements.isError ? (
            <QueryState query={settlements} />
          ) : (settlements.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin liquidaciones.</p>
          ) : (
            <ul className="divide-y rounded-md border text-sm">
              {settlements.data!.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                >
                  <span>
                    {monthLabel(s.month)} · {s.itemsCount} movimientos
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium tabular-nums">{formatEur(s.total)}</span>
                    {s.status === 'paid' ? (
                      <Badge>Pagada en efectivo {formatDate(s.paidAt)}</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={paid.isPending}
                        onClick={() =>
                          void paid.mutateAsync(s.id).catch((e) => toast.error(errorText(e)))
                        }
                      >
                        Marcar pagada
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PortfolioTab({ rep }: { rep: SalesRepDetailDto }) {
  const accounts = useSalesRepAccounts(rep.id);
  const team = useSalesTeam();
  const reassign = useReassignPortfolio(rep.id);
  const confirm = useConfirm();
  const [toRep, setToRep] = useState(NONE);
  const [scope, setScope] = useState<'all' | 'prospects' | 'clients'>('all');
  const others = (team.data?.reps ?? []).filter((r) => r.id !== rep.id && r.isActive);

  async function move() {
    const target = others.find((r) => r.id === toRep);
    const ok = await confirm({
      title: target ? `Pasar la cartera a ${target.fullName}` : 'Dejar la cartera sin comercial',
      description:
        'Las comisiones de lo que ya se ha cobrado no cambian; lo que se cobre después será del nuevo comercial.',
      confirmLabel: 'Pasar',
    });
    if (!ok) return;
    try {
      const r = await reassign.mutateAsync({ toRepId: toRep === NONE ? null : toRep, scope });
      toast.success(`${r.moved} cuentas movidas.`);
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  const leads = accounts.data?.leads ?? [];
  const clients = accounts.data?.clients ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Pasar su cartera a otro</CardTitle>
          <CardDescription>Si deja la empresa o para repartir cuentas.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todo</SelectItem>
              <SelectItem value="prospects">Solo prospectos</SelectItem>
              <SelectItem value="clients">Solo clientes</SelectItem>
            </SelectContent>
          </Select>
          <Select value={toRep} onValueChange={setToRep}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin comercial</SelectItem>
              {others.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={reassign.isPending}
            onClick={() => void move()}
          >
            Pasar
          </Button>
        </CardContent>
      </Card>

      <div>
        <p className="mb-2 text-sm font-medium">Clientes ({clients.length})</p>
        {clients.length === 0 ? (
          <Empty>Sin clientes.</Empty>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableBody>
                {clients.map((c) => (
                  <TableRow key={c.tenantId}>
                    <TableCell>
                      <Link
                        href={`/admin/tenants/${c.tenantId}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {c.salesSource ? (SALES_SOURCE_LABELS[c.salesSource] ?? c.salesSource) : ''}
                        {c.assignedAt && ` · desde ${formatDate(c.assignedAt)}`}
                      </span>
                    </TableCell>
                    <TableCell>
                      <TenantStatusBadge status={c.status} pastDue={c.pastDue} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatEur(c.monthly)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">
          Prospectos ({leads.filter((l) => !l.tenant).length})
        </p>
        {leads.filter((l) => !l.tenant).length === 0 ? (
          <Empty>Sin prospectos.</Empty>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {leads
              .filter((l) => !l.tenant)
              .map((l) => (
                <li key={l.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                  <span>
                    {l.displayName}
                    {l.salesProfile?.status && (
                      <span className="block text-xs text-muted-foreground">
                        {l.salesProfile.status}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    último contacto{' '}
                    {relativeDays(l.salesProfile?.lastContactAt ?? l.lastActivityAt)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function SalesRepPage() {
  const params = useParams<{ id: string }>();
  const rep = useSalesRep(params.id);
  const setActive = useSetSalesRepActive(params.id);
  const update = useUpdateSalesRep(params.id);
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = useState(false);

  if (!rep.data) {
    return (
      <SalesPage>
        {rep.isError ? (
          <Empty>No se ha encontrado este comercial.</Empty>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Cargando…
          </div>
        )}
      </SalesPage>
    );
  }
  const r = rep.data;

  async function toggleTwoFactor() {
    const required = !r.twoFactorRequired;
    const ok = await confirm({
      title: required
        ? `Exigir la verificación en dos pasos a ${r.fullName}`
        : `Quitar la verificación en dos pasos a ${r.fullName}`,
      description: required
        ? r.twoFactorEnabled
          ? 'Ya la tiene activada; a partir de ahora no podrá desactivarla.'
          : 'No podrá usar su panel hasta que la active.'
        : 'Podrá entrar solo con su contraseña y desactivarla si la tiene. Su cuenta queda menos protegida.',
      confirmLabel: required ? 'Exigirla' : 'Quitarla',
      destructive: !required,
    });
    if (!ok) return;
    try {
      await update.mutateAsync({ twoFactorRequired: required });
      await rep.refetch();
      toast.success(required ? 'Verificación en dos pasos exigida.' : 'Ya no se le exige.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  async function toggleActive() {
    const ok = await confirm({
      title: r.isActive ? `Desactivar a ${r.fullName}` : `Reactivar a ${r.fullName}`,
      description: r.isActive
        ? 'No podrá entrar y su enlace deja de asignar cuentas. Su cartera queda pendiente de pasar a otro.'
        : 'Podrá volver a entrar con su cuenta.',
      confirmLabel: r.isActive ? 'Desactivar' : 'Reactivar',
      destructive: r.isActive,
    });
    if (!ok) return;
    try {
      await setActive.mutateAsync(!r.isActive);
      await rep.refetch();
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <SalesPage>
      <Link
        href="/admin/sales-team"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Equipo comercial
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{r.fullName}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {r.email} · código {r.salesCode}
            {r.phone && ` · ${r.phone}`}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {!r.isActive && <Badge variant="secondary">Desactivado</Badge>}
            {!r.twoFactorRequired ? (
              <Badge variant="outline">Verificación en dos pasos no obligatoria</Badge>
            ) : (
              !r.twoFactorEnabled && (
                <Badge variant="outline">Sin verificación en dos pasos (no puede entrar)</Badge>
              )
            )}
            <span className="text-xs text-muted-foreground">
              Entró {relativeDays(r.lastLoginAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil className="mr-1.5 size-4" />
            Editar
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => void toggleTwoFactor()}
          >
            <ShieldCheck className="mr-1.5 size-4" />
            {r.twoFactorRequired
              ? 'Quitar verificación en dos pasos'
              : 'Exigir verificación en dos pasos'}
          </Button>
          <Button
            size="sm"
            variant={r.isActive ? 'destructive' : 'outline'}
            disabled={setActive.isPending}
            onClick={() => void toggleActive()}
          >
            {r.isActive ? 'Desactivar' : 'Reactivar'}
          </Button>
        </div>
      </div>
      {editOpen && <EditRepDialog rep={r} onClose={() => setEditOpen(false)} />}
      {r.signupUrl && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Su enlace:</span>
          <span className="break-all">{r.signupUrl}</span>
          <CopyButton text={r.signupUrl} size="icon" variant="ghost" />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Prospectos" value={r.prospects} />
        <Stat label="En prueba" value={r.trials} />
        <Stat label="Clientes" value={r.customers} />
        <Stat label="Pagan al mes" value={formatEur(r.mrr)} />
        <Stat
          label="Nuevos este mes"
          value={r.newClientsMonth}
          hint={`${formatEur(r.newMrrMonth)} al mes`}
        />
        <Stat label="Comisión del mes" value={formatEur(r.commissionMonth)} tone="good" />
      </div>

      <Tabs defaultValue="plan">
        <TabsList className="flex-wrap">
          <TabsTrigger value="plan">Condiciones y objetivos</TabsTrigger>
          <TabsTrigger value="commissions">Comisiones</TabsTrigger>
          <TabsTrigger value="portfolio">Cartera</TabsTrigger>
        </TabsList>
        <TabsContent value="plan">
          <div className="grid gap-4 lg:grid-cols-2">
            <PlanCard rep={r} />
            <TargetsCard rep={r} />
          </div>
        </TabsContent>
        <TabsContent value="commissions">
          <CommissionsTab rep={r} />
        </TabsContent>
        <TabsContent value="portfolio">
          <PortfolioTab rep={r} />
        </TabsContent>
      </Tabs>
    </SalesPage>
  );
}
