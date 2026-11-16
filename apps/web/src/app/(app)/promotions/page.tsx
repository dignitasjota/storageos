'use client';

import {
  CreatePromotionSchema,
  type PromotionDiscountTypeValue,
  type PromotionDto,
} from '@storageos/shared';
import { type ColumnDef } from '@tanstack/react-table';
import { BarChart3, Pencil, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DataTable } from '@/components/data-table';
import { OptionalDateSelect } from '@/components/optional-date-select';
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
import { useCompanyWide, useHasPermission } from '@/lib/auth/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { formatDate, formatEur } from '@/lib/format';
import {
  useCreatePromotion,
  useDeletePromotion,
  usePromotionResults,
  usePromotions,
  useUpdatePromotion,
} from '@/lib/promotions/hooks';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'Error';
}

function discountLabel(p: PromotionDto): string {
  if (p.discountType === 'free_months') {
    return `${p.discountValue} ${p.discountValue === 1 ? 'mes gratis' : 'meses gratis'}`;
  }
  const amount =
    p.discountType === 'percentage' ? `${p.discountValue} %` : formatEur(p.discountValue);
  if (!p.durationMonths) return `${amount} en cada cuota`;
  return `${amount} ${p.durationMonths === 1 ? 'el primer mes' : `los ${p.durationMonths} primeros meses`}`;
}

const CONTRACT_STATUS: Record<string, string> = {
  draft: 'Borrador',
  active: 'En vigor',
  ending: 'Con baja pedida',
  ended: 'Terminado',
  cancelled: 'Cancelado',
};

export default function PromotionsPage() {
  const ask = useConfirm();
  const promotions = usePromotions();
  const unitTypes = useUnitTypes();
  const facilities = useFacilities();
  const update = useUpdatePromotion();
  const remove = useDeletePromotion();
  // Valen para todo el negocio: las gestiona quien ve todos los locales.
  const companyWide = useCompanyWide();
  const canManage = useHasPermission('promotions:manage') && companyWide;
  const [editing, setEditing] = useState<PromotionDto | 'new' | null>(null);
  const [resultsOf, setResultsOf] = useState<PromotionDto | null>(null);

  const typeName = new Map((unitTypes.data ?? []).map((t) => [t.id, t.name]));
  const facilityName = new Map((facilities.data ?? []).map((f) => [f.id, f.name]));

  function conditions(p: PromotionDto): string[] {
    const out: string[] = [];
    if (p.unitTypeIds.length)
      out.push(p.unitTypeIds.map((id) => typeName.get(id) ?? '—').join(', '));
    if (p.facilityIds.length)
      out.push(p.facilityIds.map((id) => facilityName.get(id) ?? '—').join(', '));
    if (p.newCustomersOnly) out.push('clientes nuevos');
    if (p.oncePerCustomer) out.push('un uso por cliente');
    if (p.validUntil) out.push(`hasta el ${formatDate(p.validUntil)}`);
    else if (p.validFrom) out.push(`desde el ${formatDate(p.validFrom)}`);
    return out;
  }

  async function toggleActive(p: PromotionDto) {
    try {
      await update.mutateAsync({ id: p.id, input: { isActive: !p.isActive } });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function toggleWeb(p: PromotionDto) {
    try {
      await update.mutateAsync({ id: p.id, input: { announceOnWeb: !p.announceOnWeb } });
      toast.success(
        p.announceOnWeb
          ? 'Ya no se anuncia en tu web.'
          : 'Se anuncia en tu web y su código vale en la reserva online.',
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleDelete(id: string) {
    if (
      !(await ask({
        title: '¿Eliminar esta promoción? Si ya se ha usado no se puede borrar: desactívala.',
        destructive: true,
      }))
    )
      return;
    try {
      await remove.mutateAsync(id);
      toast.success('Promoción eliminada.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const columns: ColumnDef<PromotionDto>[] = [
    {
      accessorKey: 'code',
      header: 'Código',
      cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span>,
    },
    { accessorKey: 'name', header: 'Nombre' },
    { id: 'discount', header: 'Descuento', cell: ({ row }) => discountLabel(row.original) },
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
            {row.original.isActive ? 'Activa' : 'Inactiva'}
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
        const badge = (
          <Badge variant={row.original.announceOnWeb ? 'default' : 'outline'}>
            {row.original.announceOnWeb ? 'Anunciada' : 'No'}
          </Badge>
        );
        return canManage ? (
          <button
            type="button"
            onClick={() => toggleWeb(row.original)}
            title="Anunciarla en tu web: su código valdrá en la reserva online"
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
            onClick={() => setResultsOf(row.original)}
            aria-label="Resultados"
            title="Resultados"
          >
            <BarChart3 className="h-4 w-4" />
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
                onClick={() => handleDelete(row.original.id)}
                aria-label="Eliminar"
                title="Eliminar"
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
        <h1 className="text-2xl font-semibold tracking-tight">Promociones</h1>
        <p className="text-sm text-muted-foreground">
          Códigos de descuento aplicables al crear un contrato: descuentan las cuotas (todas o las
          primeras) o regalan meses. Para un descuento solo en el pago que se hace al contratar, usa
          los{' '}
          <Link href="/coupons" className="underline">
            cupones
          </Link>
          . La que marques «En la web» se anuncia en tu web y su código vale en la reserva online;
          las demás las aplica el equipo.
        </p>
        {!companyWide && (
          <p className="mt-1 text-xs text-muted-foreground">
            Las promociones valen para todo el negocio: las crea y cambia quien ve todos los
            locales.
          </p>
        )}
      </div>

      {promotions.isError ? (
        <SectionError onRetry={() => void promotions.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          data={promotions.data ?? []}
          isLoading={promotions.isLoading}
          searchPlaceholder="Buscar por código o nombre..."
          guide="promociones"
          emptyText="Una promoción descuenta las cuotas del contrato en el que se aplica."
          toolbarRight={
            canManage ? (
              <Button onClick={() => setEditing('new')}>
                <Plus className="mr-1 h-4 w-4" /> Nueva promoción
              </Button>
            ) : null
          }
        />
      )}

      {editing && (
        <PromotionDialog
          promotion={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {resultsOf && <ResultsDialog promotion={resultsOf} onClose={() => setResultsOf(null)} />}
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

function PromotionDialog({
  promotion,
  onClose,
}: {
  promotion: PromotionDto | null;
  onClose: () => void;
}) {
  const create = useCreatePromotion();
  const update = useUpdatePromotion();
  const unitTypes = useUnitTypes();
  const facilities = useFacilities();
  const [code, setCode] = useState(promotion?.code ?? '');
  const [name, setName] = useState(promotion?.name ?? '');
  const [type, setType] = useState<PromotionDiscountTypeValue>(
    promotion?.discountType ?? 'percentage',
  );
  const [value, setValue] = useState(String(promotion?.discountValue ?? 10));
  const [duration, setDuration] = useState(
    promotion?.durationMonths ? String(promotion.durationMonths) : '',
  );
  const [maxUses, setMaxUses] = useState(promotion?.maxUses ? String(promotion.maxUses) : '');
  const [unitTypeIds, setUnitTypeIds] = useState<string[]>(promotion?.unitTypeIds ?? []);
  const [facilityIds, setFacilityIds] = useState<string[]>(promotion?.facilityIds ?? []);
  const [newOnly, setNewOnly] = useState(promotion?.newCustomersOnly ?? false);
  const [oncePerCustomer, setOncePerCustomer] = useState(promotion?.oncePerCustomer ?? false);
  const [announce, setAnnounce] = useState(promotion?.announceOnWeb ?? false);
  const [validFrom, setValidFrom] = useState(toDateInput(promotion?.validFrom ?? null));
  const [validUntil, setValidUntil] = useState(toDateInput(promotion?.validUntil ?? null));
  const [error, setError] = useState<string | null>(null);
  const saving = create.isPending || update.isPending;
  // Ya usada: los contratos llevan su descuento y el código puede estar repartido.
  const locked = !!promotion && promotion.usedCount > 0;
  const freeMonths = type === 'free_months';
  const valueNumber = Number(value) || 0;
  const durationNumber = Number(duration) || 0;
  const amountText = type === 'percentage' ? `el ${valueNumber} %` : formatEur(valueNumber);

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const from = fromDateInput(validFrom, false);
    const until = fromDateInput(validUntil, true);
    const conditions = {
      durationMonths: freeMonths || !duration ? null : Number(duration),
      unitTypeIds,
      facilityIds,
      newCustomersOnly: newOnly,
      oncePerCustomer,
    };
    const parsed = CreatePromotionSchema.safeParse({
      code: promotion?.code ?? code,
      name,
      discountType: type,
      discountValue: Number(value),
      appliesTo: {},
      ...(maxUses ? { maxUses: Number(maxUses) } : {}),
      ...(from ? { validFrom: from } : {}),
      ...(until ? { validUntil: until } : {}),
      isActive: promotion?.isActive ?? true,
      announceOnWeb: announce,
      ...conditions,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revisa los datos');
      return;
    }
    setError(null);
    try {
      if (promotion) {
        await update.mutateAsync({
          id: promotion.id,
          input: {
            name: parsed.data.name,
            ...(locked
              ? {}
              : {
                  discountType: parsed.data.discountType,
                  discountValue: parsed.data.discountValue,
                }),
            maxUses: maxUses ? Number(maxUses) : null,
            validFrom: from,
            validUntil: until,
            announceOnWeb: announce,
            ...conditions,
          },
        });
        toast.success('Promoción guardada.');
      } else {
        await create.mutateAsync(parsed.data);
        toast.success('Promoción creada.');
      }
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{promotion ? `Editar ${promotion.code}` : 'Nueva promoción'}</DialogTitle>
          <DialogDescription>
            Descuenta las cuotas del contrato. Los importes son sin IVA, como el precio del
            trastero.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit} noValidate>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="promo-code">Código</Label>
              <Input
                id="promo-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="VERANO20"
                disabled={!!promotion}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promo-name">Nombre</Label>
              <Input
                id="promo-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Promo verano"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as PromotionDiscountTypeValue)}
                disabled={locked}
              >
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
              <Label htmlFor="promo-value">
                {type === 'percentage'
                  ? '%'
                  : type === 'fixed'
                    ? '€ al mes, sin IVA'
                    : 'Meses gratis'}
              </Label>
              <Input
                id="promo-value"
                type="number"
                min={freeMonths ? 1 : 0}
                step={freeMonths ? 1 : 0.01}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={locked}
              />
            </div>
            {!freeMonths && (
              <div className="space-y-1.5">
                <Label htmlFor="promo-duration">Meses que dura</Label>
                <Input
                  id="promo-duration"
                  type="number"
                  min={1}
                  max={36}
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  placeholder="Todo el contrato"
                />
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {freeMonths
              ? `${valueNumber === 1 ? 'La primera factura mensual sale' : `Las ${valueNumber} primeras facturas mensuales salen`} a 0 €. No se puede combinar con el pago semestral o anual.`
              : durationNumber > 0
                ? `Descuenta ${amountText} de la cuota ${durationNumber === 1 ? 'el primer mes' : `los ${durationNumber} primeros meses`}; después el contrato vuelve solo a su precio.`
                : `Descuenta ${amountText} de todas las cuotas mientras dure el contrato.`}
          </p>
          {locked && (
            <p className="text-xs text-muted-foreground">
              Ya se ha usado: el tipo y el valor no se pueden cambiar. Para otro descuento, crea
              otra promoción.
            </p>
          )}

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

          <div className="grid grid-cols-1 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="promo-max-uses">Usos máximos</Label>
              <Input
                id="promo-max-uses"
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Sin límite"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Válida desde</Label>
              <OptionalDateSelect value={validFrom} onChange={setValidFrom} />
            </div>
            <div className="space-y-1.5">
              <Label>Válida hasta</Label>
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
              checked={announce}
              onCheckedChange={(v) => setAnnounce(v === true)}
            />
            <span>
              Anunciarla en tu web
              <span className="block text-xs text-muted-foreground">
                Sale en un aviso de tu web con su código, que valdrá también en la reserva online.
                Sin marcar, solo la aplica el equipo al crear un contrato.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? 'Guardando...' : promotion ? 'Guardar' : 'Crear'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResultsDialog({ promotion, onClose }: { promotion: PromotionDto; onClose: () => void }) {
  const results = usePromotionResults(promotion.id);
  const data = results.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Resultados de {promotion.code}</DialogTitle>
          <DialogDescription>
            Lo que cuesta y lo que trae cada mes en los contratos que la usan. Importes sin IVA.
          </DialogDescription>
        </DialogHeader>
        {results.isError ? (
          <SectionError onRetry={() => void results.refetch()} />
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Cargando...</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Figure label="Contratos en vigor" value={String(data.liveContracts)} />
              <Figure label="Descuenta al mes" value={formatEur(data.monthlyCost)} />
              <Figure label="Pagan al mes" value={formatEur(data.monthlyRevenue)} />
            </div>
            {data.contracts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Todavía no se ha usado.</p>
            ) : (
              <ul className="divide-y">
                {data.contracts.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="text-sm">
                      <div className="font-medium">
                        <Link href={`/customers/${c.customerId}`} className="hover:underline">
                          {c.customerName}
                        </Link>
                        {' · '}
                        <Link href={`/contracts/${c.id}`} className="hover:underline">
                          {c.contractNumber}
                        </Link>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Trastero {c.unitCode} · desde el {formatDate(c.startDate)} ·{' '}
                        {CONTRACT_STATUS[c.status] ?? c.status}
                      </div>
                    </div>
                    <span className="text-sm font-medium">
                      {c.freeMonthsRemaining > 0
                        ? `${c.freeMonthsRemaining} ${c.freeMonthsRemaining === 1 ? 'mes gratis pendiente' : 'meses gratis pendientes'}`
                        : c.monthlyDiscount > 0
                          ? `−${formatEur(c.monthlyDiscount)} al mes`
                          : 'Descuento terminado'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
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
