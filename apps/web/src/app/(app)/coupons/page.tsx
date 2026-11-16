'use client';

import {
  COUPON_MAX_MONTHS,
  CreateCouponSchema,
  couponSummary,
  type CouponDiscountType,
  type CouponDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { Copy, History, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { OptionalDateSelect } from '@/components/optional-date-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { ApiError } from '@/lib/auth/api';
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import {
  useCouponRedemptions,
  useCouponResults,
  useCoupons,
  useCouponSettings,
  useCreateCoupon,
  useCreatePersonalCoupon,
  useDeleteCoupon,
  useUpdateCoupon,
  useUpdateCouponSettings,
} from '@/lib/coupons/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const day = (iso: string) => formatDate(iso);

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'Error';
}

export default function CouponsPage() {
  const ask = useConfirm();
  const coupons = useCoupons();
  const unitTypes = useUnitTypes();
  const facilities = useFacilities();
  const update = useUpdateCoupon();
  const remove = useDeleteCoupon();
  // Valen para todo el negocio: los gestiona quien ve todos los locales.
  const companyWide = useCompanyWide();
  const canManage = useHasPermission('promotions:manage') && companyWide;
  const [editing, setEditing] = useState<CouponDto | 'new' | null>(null);
  const [usesOf, setUsesOf] = useState<CouponDto | null>(null);
  const [personalOpen, setPersonalOpen] = useState(false);

  const typeName = new Map((unitTypes.data ?? []).map((t) => [t.id, t.name]));
  const facilityName = new Map((facilities.data ?? []).map((f) => [f.id, f.name]));

  function conditions(c: CouponDto): string[] {
    const out: string[] = [];
    if (c.unitTypeIds.length)
      out.push(c.unitTypeIds.map((id) => typeName.get(id) ?? '—').join(', '));
    if (c.facilityIds.length)
      out.push(c.facilityIds.map((id) => facilityName.get(id) ?? '—').join(', '));
    if (c.minAmount) out.push(`desde ${eur(c.minAmount)} sin IVA`);
    if (c.newCustomersOnly) out.push('clientes nuevos');
    if (c.oncePerCustomer) out.push('un uso por cliente');
    if (c.preOpeningOnly) out.push('solo reservas antes de la apertura');
    if (c.validUntil) out.push(`hasta el ${day(c.validUntil)}`);
    return out;
  }

  async function toggleActive(c: CouponDto) {
    try {
      await update.mutateAsync({ id: c.id, input: { isActive: !c.isActive } });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function toggleWeb(c: CouponDto) {
    try {
      await update.mutateAsync({ id: c.id, input: { announceOnWeb: !c.announceOnWeb } });
      toast.success(
        c.announceOnWeb ? 'Ya no se anuncia en tu web.' : 'Se anuncia en tu web con su código.',
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDelete(c: CouponDto) {
    if (!(await ask({ title: `¿Borrar el cupón ${c.code}?`, destructive: true }))) return;
    try {
      await remove.mutateAsync(c.id);
      toast.success('Cupón borrado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const columns: ColumnDef<CouponDto>[] = [
    {
      accessorKey: 'code',
      header: 'Código',
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span>,
    },
    {
      accessorKey: 'name',
      header: 'Nombre',
      cell: ({ row }) =>
        row.original.kind === 'personal' ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="font-normal">
              Personal
            </Badge>
            {row.original.personalFor ?? row.original.name}
          </span>
        ) : (
          row.original.name
        ),
    },
    { id: 'discount', header: 'Descuento', cell: ({ row }) => couponSummary(row.original) },
    {
      id: 'conditions',
      header: 'Condiciones',
      cell: ({ row }) => {
        const list = conditions(row.original);
        return list.length ? (
          <div className="flex flex-wrap gap-1">
            {list.map((t) => (
              <Badge key={t} variant="outline" className="font-normal">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">Ninguna</span>
        );
      },
    },
    {
      id: 'uses',
      header: 'Usos',
      cell: ({ row }) =>
        `${row.original.usedCount}${row.original.maxUses ? ` / ${row.original.maxUses}` : ''}`,
    },
    {
      accessorKey: 'isActive',
      header: 'Estado',
      cell: ({ row }) => {
        const badge = (
          <Badge variant={row.original.isActive ? 'default' : 'outline'}>
            {row.original.isActive ? 'Activo' : 'Desactivado'}
          </Badge>
        );
        return canManage ? (
          <button type="button" onClick={() => toggleActive(row.original)}>
            {badge}
          </button>
        ) : (
          badge
        );
      },
    },
    {
      id: 'web',
      header: 'En la web',
      cell: ({ row }) => {
        // Un cupón personal es de una persona: no se anuncia.
        if (row.original.kind !== 'standard')
          return <span className="text-muted-foreground">—</span>;
        const badge = (
          <Badge variant={row.original.announceOnWeb ? 'default' : 'outline'}>
            {row.original.announceOnWeb ? 'Anunciado' : 'No'}
          </Badge>
        );
        return canManage ? (
          <button
            type="button"
            onClick={() => toggleWeb(row.original)}
            title="Anunciarlo en tu web con su código"
          >
            {badge}
          </button>
        ) : (
          badge
        );
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setUsesOf(row.original)}
            aria-label="Usos y resultados"
            title="Usos y resultados"
          >
            <History className="h-4 w-4" />
          </Button>
          {canManage && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setEditing(row.original)}
                aria-label="Editar"
                title="Editar"
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleDelete(row.original)}
                aria-label="Borrar"
                title="Borrar"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cupones</h1>
        <p className="text-sm text-muted-foreground">
          Descuentos sobre el pago que se hace al contratar: si se pagan 3 meses por adelantado, el
          descuento cubre esos 3 meses; las renovaciones van al precio normal. Nunca se descuentan
          la fianza ni el seguro. Para un descuento en todas las cuotas usa las{' '}
          <Link href="/promotions" className="underline">
            promociones
          </Link>
          .
        </p>
        {!companyWide && (
          <p className="mt-1 text-xs text-muted-foreground">
            Los cupones valen para todo el negocio: los crea y cambia quien ve todos los locales.
          </p>
        )}
      </div>

      {coupons.isError ? (
        <SectionError onRetry={() => void coupons.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={coupons.data ?? []}
          isLoading={coupons.isLoading}
          searchPlaceholder="Buscar por código o nombre..."
          guide="promociones"
          emptyText="Un cupón descuenta el primer pago al contratar: útil en anuncios y en la web."
          toolbarRight={
            canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setPersonalOpen(true)}>
                  <UserRound className="mr-1 h-4 w-4" /> Cupón personal
                </Button>
                <Button onClick={() => setEditing('new')}>
                  <Plus className="mr-1 h-4 w-4" /> Nuevo cupón
                </Button>
              </div>
            ) : null
          }
        />
      )}

      <RecoveryCouponCard canManage={canManage} />
      {personalOpen && <PersonalCouponDialog onClose={() => setPersonalOpen(false)} />}

      {editing && (
        <CouponDialog
          coupon={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {usesOf && <RedemptionsDialog coupon={usesOf} onClose={() => setUsesOf(null)} />}
    </div>
  );
}

/** Fecha del campo en hora local (con `toISOString` el inicio del día salía el día anterior). */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Inicio del día en hora local o, para la fecha de fin, su último instante. */
function fromDateInput(value: string, endOfDay: boolean): string | null {
  if (!value) return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function CouponDialog({ coupon, onClose }: { coupon: CouponDto | null; onClose: () => void }) {
  const create = useCreateCoupon();
  const update = useUpdateCoupon();
  const unitTypes = useUnitTypes();
  const facilities = useFacilities();
  const [code, setCode] = useState(coupon?.code ?? '');
  const [name, setName] = useState(coupon?.name ?? '');
  const [type, setType] = useState<CouponDiscountType>(coupon?.discountType ?? 'percentage');
  const [value, setValue] = useState(String(coupon?.discountValue ?? 10));
  const [minMonths, setMinMonths] = useState(String(coupon?.minMonths ?? 1));
  const [minAmount, setMinAmount] = useState(coupon?.minAmount ? String(coupon.minAmount) : '');
  const [maxUses, setMaxUses] = useState(coupon?.maxUses ? String(coupon.maxUses) : '');
  const [unitTypeIds, setUnitTypeIds] = useState<string[]>(coupon?.unitTypeIds ?? []);
  const [facilityIds, setFacilityIds] = useState<string[]>(coupon?.facilityIds ?? []);
  const [newOnly, setNewOnly] = useState(coupon?.newCustomersOnly ?? false);
  const [oncePerCustomer, setOncePerCustomer] = useState(coupon?.oncePerCustomer ?? false);
  const [preOpeningOnly, setPreOpeningOnly] = useState(coupon?.preOpeningOnly ?? false);
  const [announce, setAnnounce] = useState(coupon?.announceOnWeb ?? false);
  const [validFrom, setValidFrom] = useState(toDateInput(coupon?.validFrom ?? null));
  const [validUntil, setValidUntil] = useState(toDateInput(coupon?.validUntil ?? null));
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      code,
      name,
      discountType: type,
      discountValue: Number(value),
      minMonths: Number(minMonths) || 1,
      minAmount: minAmount ? Number(minAmount) : null,
      unitTypeIds,
      facilityIds,
      newCustomersOnly: newOnly,
      oncePerCustomer,
      preOpeningOnly,
      maxUses: maxUses ? Number(maxUses) : null,
      validFrom: fromDateInput(validFrom, false),
      validUntil: fromDateInput(validUntil, true),
      isActive: coupon?.isActive ?? true,
      announceOnWeb: announce,
    };
    const parsed = CreateCouponSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
      return;
    }
    setError(null);
    try {
      if (coupon) {
        const { code: _code, ...rest } = parsed.data;
        void _code;
        await update.mutateAsync({ id: coupon.id, input: rest });
        toast.success('Cupón guardado.');
      } else {
        await create.mutateAsync(parsed.data);
        toast.success('Cupón creado.');
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const freeMonths = type === 'free_months';
  const valueNumber = Number(value) || 0;
  const minNumber = Number(minMonths) || 1;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{coupon ? `Editar ${coupon.code}` : 'Nuevo cupón'}</DialogTitle>
          <DialogDescription>
            Se aplica al pago que se hace al contratar. Los importes son sin IVA, como el precio del
            trastero.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="coupon-code">Código</Label>
              <Input
                id="coupon-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="TRESXDOS"
                disabled={!!coupon}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-name">Nombre</Label>
              <Input
                id="coupon-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contrata 3 y paga 2"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as CouponDiscountType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Porcentaje</SelectItem>
                  <SelectItem value="fixed">Importe fijo</SelectItem>
                  <SelectItem value="free_months">Meses gratis</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-value">
                {type === 'percentage' ? '%' : type === 'fixed' ? '€ sin IVA' : 'Meses gratis'}
              </Label>
              <Input
                id="coupon-value"
                type="number"
                min={freeMonths ? 1 : 0}
                step={freeMonths ? 1 : 0.01}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-min-months">Meses mínimos</Label>
              <Input
                id="coupon-min-months"
                type="number"
                min={1}
                max={COUPON_MAX_MONTHS}
                value={minMonths}
                onChange={(e) => setMinMonths(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {freeMonths
              ? `Quien pague ${minNumber} meses o más por adelantado no paga ${valueNumber} de ellos.`
              : type === 'percentage'
                ? `Descuenta el ${valueNumber} % de todos los meses que se pagan ahora${minNumber > 1 ? ` (a partir de ${minNumber})` : ''}.`
                : `Descuenta ${eur(valueNumber)} del pago${minNumber > 1 ? ` a partir de ${minNumber} meses` : ''}.`}
          </p>

          {(unitTypes.data ?? []).length > 0 && (
            <div className="space-y-2">
              <Label>Tipos de trastero</Label>
              <p className="text-xs text-muted-foreground">Sin marcar ninguno, vale para todos.</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(unitTypes.data ?? []).map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={unitTypeIds.includes(t.id)}
                      onCheckedChange={() => setUnitTypeIds((l) => toggle(l, t.id))}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {(facilities.data ?? []).length > 1 && (
            <div className="space-y-2">
              <Label>Locales</Label>
              <p className="text-xs text-muted-foreground">Sin marcar ninguno, vale en todos.</p>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {(facilities.data ?? []).map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={facilityIds.includes(f.id)}
                      onCheckedChange={() => setFacilityIds((l) => toggle(l, f.id))}
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="coupon-min-amount">Importe mínimo del pago (sin IVA)</Label>
              <Input
                id="coupon-min-amount"
                type="number"
                min={0}
                step="0.01"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="Sin mínimo"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-max-uses">Usos máximos</Label>
              <Input
                id="coupon-max-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Sin límite"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Válido desde</Label>
              <OptionalDateSelect value={validFrom} onChange={setValidFrom} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Válido hasta</Label>
              <OptionalDateSelect value={validUntil} onChange={setValidUntil} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={newOnly} onCheckedChange={(v) => setNewOnly(v === true)} />
            Solo para clientes nuevos (que no hayan sido inquilinos antes)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={oncePerCustomer}
              onCheckedChange={(v) => setOncePerCustomer(v === true)}
            />
            Un solo uso por cliente
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={preOpeningOnly}
              onCheckedChange={(v) => setPreOpeningOnly(v === true)}
            />
            <span>
              Solo para reservas antes de la apertura
              <span className="block text-xs text-muted-foreground">
                Oferta de preapertura: vale para reservar en un local que aún no ha abierto y
                descuenta la primera mensualidad (no la fianza).
              </span>
            </span>
          </label>

          {(!coupon || coupon.kind === 'standard') && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                className="mt-0.5"
                checked={announce}
                onCheckedChange={(v) => setAnnounce(v === true)}
              />
              <span>
                Anunciarlo en tu web
                <span className="block text-xs text-muted-foreground">
                  Sale en un aviso de tu web con su código y lo que descuenta del primer pago. Un
                  cupón vale siempre en la reserva online, se anuncie o no.
                </span>
              </span>
            </label>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando...' : coupon ? 'Guardar' : 'Crear cupón'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RedemptionsDialog({ coupon, onClose }: { coupon: CouponDto; onClose: () => void }) {
  const uses = useCouponRedemptions(coupon.id);
  const results = useCouponResults(coupon.id);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Usos de {coupon.code}</DialogTitle>
          <DialogDescription>
            Lo que ha descontado y lo que pagan cada mes los contratos que lo usaron. Importes sin
            IVA.
          </DialogDescription>
        </DialogHeader>
        {results.data && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Figure label="Descuento concedido" value={eur(results.data.totalDiscount)} />
            <Figure label="Contratos en vigor" value={String(results.data.liveContracts)} />
            <Figure label="Pagan al mes" value={eur(results.data.monthlyRevenue)} />
          </div>
        )}
        {uses.isLoading ? (
          <p className="text-sm text-muted-foreground">Cargando...</p>
        ) : (uses.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se ha usado.</p>
        ) : (
          <ul className="divide-y">
            {(uses.data ?? []).map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="text-sm">
                  <div className="font-medium">
                    {u.customerId ? (
                      <Link href={`/customers/${u.customerId}`} className="hover:underline">
                        {u.customerName ?? 'Inquilino'}
                      </Link>
                    ) : (
                      'Sin inquilino'
                    )}
                    {u.contractId && u.contractNumber && (
                      <>
                        {' · '}
                        <Link href={`/contracts/${u.contractId}`} className="hover:underline">
                          {u.contractNumber}
                        </Link>
                      </>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {day(u.createdAt)} · {u.months} {u.months === 1 ? 'mes' : 'meses'}
                    {u.freeMonths > 0 &&
                      ` · ${u.freeMonths} ${u.freeMonths === 1 ? 'mes gratis' : 'meses gratis'}`}
                  </div>
                </div>
                <span className="text-sm font-medium">−{eur(u.discountAmount)}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** Cupón de un solo uso para una persona: el código lo pone el sistema. */
function PersonalCouponDialog({ onClose }: { onClose: () => void }) {
  const create = useCreatePersonalCoupon();
  const [personalFor, setPersonalFor] = useState('');
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState('10');
  const [validDays, setValidDays] = useState('7');
  const [created, setCreated] = useState<CouponDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!personalFor.trim()) {
      setError('Escribe para quién es.');
      return;
    }
    setError(null);
    try {
      setCreated(
        await create.mutateAsync({
          personalFor: personalFor.trim(),
          discountType: type,
          discountValue: Number(value),
          validDays: Number(validDays) || 7,
          minMonths: 1,
        }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success('Código copiado.');
    } catch {
      toast.error('No se ha podido copiar.');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cupón personal</DialogTitle>
          <DialogDescription>
            Para una persona concreta: vale una sola vez, caduca solo y descuenta el primer pago.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 text-center">
              <div className="text-xs text-muted-foreground">Código para {created.personalFor}</div>
              <div className="mt-1 font-mono text-2xl font-semibold tracking-wide">
                {created.code}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {couponSummary(created)}
                {created.validUntil ? ` · hasta el ${day(created.validUntil)}` : ''}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => copy(created.code)}>
                <Copy className="mr-1 h-4 w-4" /> Copiar código
              </Button>
              <Button onClick={onClose}>Hecho</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit} noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="personal-for">Para quién</Label>
              <Input
                id="personal-for"
                value={personalFor}
                onChange={(e) => setPersonalFor(e.target.value)}
                placeholder="Nombre o email"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label>Tipo</Label>
                <Select value={type} onValueChange={(v) => setType(v as 'percentage' | 'fixed')}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Porcentaje</SelectItem>
                    <SelectItem value="fixed">Importe fijo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="personal-value">{type === 'percentage' ? '%' : '€ sin IVA'}</Label>
                <Input
                  id="personal-value"
                  type="number"
                  min={0}
                  step="0.01"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="personal-days">Días que vale</Label>
                <Input
                  id="personal-days"
                  type="number"
                  min={1}
                  max={90}
                  value={validDays}
                  onChange={(e) => setValidDays(e.target.value)}
                />
              </div>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={create.isPending}>
                {create.isPending ? 'Creando...' : 'Crear cupón'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Cupón que acompaña al recordatorio de una reserva online sin terminar. */
function RecoveryCouponCard({ canManage }: { canManage: boolean }) {
  const settings = useCouponSettings();
  const save = useUpdateCouponSettings();
  const [enabled, setEnabled] = useState(false);
  const [pct, setPct] = useState('10');
  const [days, setDays] = useState('2');

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.bookingRecoveryCouponPct > 0);
    if (settings.data.bookingRecoveryCouponPct > 0) {
      setPct(String(settings.data.bookingRecoveryCouponPct));
    }
    setDays(String(settings.data.bookingRecoveryCouponDays));
  }, [settings.data]);

  if (!settings.data) return null;

  async function submit() {
    try {
      await save.mutateAsync({
        bookingRecoveryCouponPct: enabled ? Math.min(100, Math.max(1, Number(pct) || 0)) : 0,
        bookingRecoveryCouponDays: Math.min(30, Math.max(1, Number(days) || 2)),
      });
      toast.success('Guardado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Reservas sin terminar</CardTitle>
        <CardDescription>
          Quien empieza a reservar en tu web y no termina recibe un recordatorio por correo. Puedes
          acompañarlo de un cupón personal, de un solo uso, para animarle a terminar.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            disabled={!canManage}
            onCheckedChange={(v) => setEnabled(v === true)}
          />
          Añadir un cupón al recordatorio
        </label>
        {enabled && (
          <div className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-pct">Descuento del primer pago (%)</Label>
              <Input
                id="recovery-pct"
                type="number"
                min={1}
                max={100}
                value={pct}
                disabled={!canManage}
                onChange={(e) => setPct(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="recovery-days">Días que vale</Label>
              <Input
                id="recovery-days"
                type="number"
                min={1}
                max={30}
                value={days}
                disabled={!canManage}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>
          </div>
        )}
        {canManage && (
          <Button onClick={submit} disabled={save.isPending}>
            {save.isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
