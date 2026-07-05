'use client';

import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PlatformCouponDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { useAdminCoupons, useCreateCoupon, useUpdateCoupon } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

type DiscountType = 'percentage' | 'fixed';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-ES') : 'Nunca');

function discountLabel(c: PlatformCouponDto): string {
  return c.discountType === 'percentage'
    ? `${c.discountValue}%`
    : c.discountValue.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

export default function AdminCouponsPage() {
  const coupons = useAdminCoupons();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformCouponDto | null>(null);

  if (coupons.isError) {
    return <AdminError onRetry={() => void coupons.refetch()} />;
  }
  if (coupons.isLoading) {
    return (
      <div className="flex h-[40vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const rows = coupons.data ?? [];

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cupones de plataforma</h1>
          <p className="text-sm text-muted-foreground">
            Descuentos aplicables al cobro manual de la suscripción SaaS de un tenant.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          Nuevo cupón
        </Button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hay cupones. Crea uno para ofrecer un descuento en el cobro de la suscripción.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Código</th>
                <th className="p-2">Descuento</th>
                <th className="p-2">Caduca</th>
                <th className="p-2">Usos</th>
                <th className="p-2">Estado</th>
                <th className="p-2 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="p-2 font-mono font-medium">{c.code}</td>
                  <td className="p-2">{discountLabel(c)}</td>
                  <td className="p-2 whitespace-nowrap">{fmtDate(c.validUntil)}</td>
                  <td className="p-2 whitespace-nowrap">
                    {c.usedCount}
                    {c.maxUses != null ? ` / ${c.maxUses}` : ' / ∞'}
                  </td>
                  <td className="p-2">
                    {c.isActive ? (
                      <Badge variant="secondary">Activo</Badge>
                    ) : (
                      <Badge variant="outline">Inactivo</Badge>
                    )}
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => {
                        setEditing(c);
                        setDialogOpen(true);
                      }}
                    >
                      Editar
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CouponDialog open={dialogOpen} coupon={editing} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

function CouponDialog({
  open,
  coupon,
  onClose,
}: {
  open: boolean;
  coupon: PlatformCouponDto | null;
  onClose: () => void;
}) {
  const create = useCreateCoupon();
  const update = useUpdateCoupon();
  const isEdit = coupon !== null;

  // `open` fuerza el remount del contenido → el estado interno se inicializa
  // desde `coupon` cada vez que se abre el diálogo.
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        {open ? (
          <CouponForm
            coupon={coupon}
            isEdit={isEdit}
            pending={create.isPending || update.isPending}
            onSubmit={async (values) => {
              try {
                if (isEdit && coupon) {
                  await update.mutateAsync({
                    id: coupon.id,
                    input: {
                      discountType: values.discountType,
                      discountValue: values.discountValue,
                      validUntil: values.validUntil,
                      maxUses: values.maxUses,
                      isActive: values.isActive,
                    },
                  });
                  toast.success('Cupón actualizado.');
                } else {
                  await create.mutateAsync({
                    code: values.code,
                    discountType: values.discountType,
                    discountValue: values.discountValue,
                    validUntil: values.validUntil,
                    maxUses: values.maxUses,
                    isActive: values.isActive,
                  });
                  toast.success('Cupón creado.');
                }
                onClose();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
              }
            }}
            onCancel={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface FormValues {
  code: string;
  discountType: DiscountType;
  discountValue: number;
  validUntil: string | null;
  maxUses: number | null;
  isActive: boolean;
}

function CouponForm({
  coupon,
  isEdit,
  pending,
  onSubmit,
  onCancel,
}: {
  coupon: PlatformCouponDto | null;
  isEdit: boolean;
  pending: boolean;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(coupon?.code ?? '');
  const [discountType, setDiscountType] = useState<DiscountType>(
    coupon?.discountType ?? 'percentage',
  );
  const [discountValue, setDiscountValue] = useState(String(coupon?.discountValue ?? ''));
  const [validUntil, setValidUntil] = useState(
    coupon?.validUntil ? coupon.validUntil.slice(0, 10) : '',
  );
  const [maxUses, setMaxUses] = useState(coupon?.maxUses != null ? String(coupon.maxUses) : '');
  const [isActive, setIsActive] = useState(coupon?.isActive ?? true);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(discountValue);
    if (!isEdit && code.trim().length < 2) {
      toast.error('Indica un código de al menos 2 caracteres.');
      return;
    }
    if (!(value > 0)) {
      toast.error('El valor del descuento debe ser mayor que 0.');
      return;
    }
    if (discountType === 'percentage' && value > 100) {
      toast.error('Un descuento porcentual no puede superar el 100%.');
      return;
    }
    const maxUsesNum = maxUses.trim() ? Math.floor(Number(maxUses)) : null;
    onSubmit({
      code: code.trim().toUpperCase(),
      discountType,
      discountValue: value,
      validUntil: validUntil ? new Date(`${validUntil}T23:59:59`).toISOString() : null,
      maxUses: maxUsesNum && maxUsesNum > 0 ? maxUsesNum : null,
      isActive,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{isEdit ? 'Editar cupón' : 'Nuevo cupón'}</DialogTitle>
        <DialogDescription>
          El descuento se calcula en el servidor sobre el importe del cobro manual.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Código</Label>
          <Input
            value={code}
            disabled={isEdit}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="BLACKFRIDAY"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Tipo</Label>
          <Select value={discountType} onValueChange={(v) => setDiscountType(v as DiscountType)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percentage">Porcentaje (%)</SelectItem>
              <SelectItem value="fixed">Importe fijo (€)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Valor ({discountType === 'percentage' ? '%' : '€'})
          </Label>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={discountValue}
            onChange={(e) => setDiscountValue(e.target.value)}
            placeholder={discountType === 'percentage' ? '10' : '5.00'}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Usos máximos (opcional)</Label>
          <Input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="∞"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Caduca (opcional)</Label>
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
            />
            Activo
          </label>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? 'Guardando…' : isEdit ? 'Guardar' : 'Crear cupón'}
        </Button>
      </DialogFooter>
    </form>
  );
}
