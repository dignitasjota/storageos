'use client';

import {
  COUPON_MAX_MONTHS,
  CreateCouponSchema,
  couponSummary,
  type CouponDiscountType,
  type CouponDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { History, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataTable } from '@/components/data-table';
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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCouponRedemptions,
  useCoupons,
  useCreateCoupon,
  useDeleteCoupon,
  useUpdateCoupon,
} from '@/lib/coupons/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';

const eur = (n: number) =>
  n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString('es-ES');

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'Error';
}

export default function CouponsPage() {
  const coupons = useCoupons();
  const unitTypes = useUnitTypes();
  const facilities = useFacilities();
  const update = useUpdateCoupon();
  const remove = useDeleteCoupon();
  const canManage = useHasPermission('promotions:manage');
  const [editing, setEditing] = useState<CouponDto | 'new' | null>(null);
  const [usesOf, setUsesOf] = useState<CouponDto | null>(null);

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

  async function handleDelete(c: CouponDto) {
    if (!window.confirm(`¿Borrar el cupón ${c.code}?`)) return;
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
    { accessorKey: 'name', header: 'Nombre' },
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
      id: 'actions',
      header: '',
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setUsesOf(row.original)}
            aria-label="Ver usos"
            title="Ver usos"
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
      </div>

      <DataTable
        columns={columns}
        data={coupons.data ?? []}
        isLoading={coupons.isLoading}
        searchPlaceholder="Buscar por código o nombre..."
        emptyText="Aún no has creado ningún cupón."
        toolbarRight={
          canManage ? (
            <Button onClick={() => setEditing('new')}>
              <Plus className="mr-1 h-4 w-4" /> Nuevo cupón
            </Button>
          ) : null
        }
      />

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

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
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
      maxUses: maxUses ? Number(maxUses) : null,
      validFrom: fromDateInput(validFrom, false),
      validUntil: fromDateInput(validUntil, true),
      isActive: coupon?.isActive ?? true,
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
            <div className="space-y-1.5">
              <Label htmlFor="coupon-from">Válido desde</Label>
              <Input
                id="coupon-from"
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="coupon-until">Válido hasta</Label>
              <Input
                id="coupon-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={newOnly} onCheckedChange={(v) => setNewOnly(v === true)} />
            Solo para clientes nuevos (sin ningún contrato firmado antes)
          </label>

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
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Usos de {coupon.code}</DialogTitle>
        </DialogHeader>
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
