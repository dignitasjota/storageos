'use client';

import { ChevronLeft, ChevronRight, Loader2, MapPin } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAdminTenantFacilities, useAdminTenantFacilityUnits } from '@/lib/admin/hooks';

const STATUS_LABELS: Record<string, string> = {
  available: 'Disponible',
  occupied: 'Ocupado',
  reserved: 'Reservado',
  maintenance: 'Mantenimiento',
  blocked: 'Bloqueado',
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  available: 'secondary',
  occupied: 'default',
  reserved: 'outline',
  maintenance: 'outline',
  blocked: 'destructive',
};

function fmtMoney(n: number): string {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
}

function fmtArea(m2: number | null): string {
  return m2 === null ? '—' : `${m2.toLocaleString('es-ES', { maximumFractionDigits: 2 })} m²`;
}

export function TenantFacilitiesDialog({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);

  function handleClose() {
    setSelected(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        {selected ? (
          <UnitsView tenantId={tenantId} facility={selected} onBack={() => setSelected(null)} />
        ) : (
          <FacilitiesView tenantId={tenantId} open={open} onSelect={(f) => setSelected(f)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FacilitiesView({
  tenantId,
  open,
  onSelect,
}: {
  tenantId: string;
  open: boolean;
  onSelect: (f: { id: string; name: string }) => void;
}) {
  const facilities = useAdminTenantFacilities(tenantId, open);
  const rows = facilities.data ?? [];

  return (
    <>
      <DialogHeader>
        <DialogTitle>Locales del tenant</DialogTitle>
        <DialogDescription>
          {rows.length > 0
            ? `${rows.length} local(es). Pincha uno para ver sus trasteros.`
            : 'Locales físicos del tenant.'}
        </DialogDescription>
      </DialogHeader>

      {facilities.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Sin locales.</p>
      ) : (
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {rows.map((f) => {
            const pct = f.unitCount > 0 ? Math.round((f.occupiedCount / f.unitCount) * 100) : 0;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ id: f.id, name: f.name })}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/60 focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{f.name}</div>
                    {(f.city || f.address) && (
                      <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <MapPin className="size-3" />
                        {[f.address, f.city].filter(Boolean).join(', ')}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right text-xs text-muted-foreground">
                      <div className="text-sm font-medium text-foreground">{f.unitCount}</div>
                      trasteros · {f.occupiedCount} ocup. ({pct}%)
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function UnitsView({
  tenantId,
  facility,
  onBack,
}: {
  tenantId: string;
  facility: { id: string; name: string };
  onBack: () => void;
}) {
  const units = useAdminTenantFacilityUnits(tenantId, facility.id);
  const rows = units.data ?? [];

  return (
    <>
      <DialogHeader>
        <button
          type="button"
          onClick={onBack}
          className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" /> Locales
        </button>
        <DialogTitle>{facility.name} — trasteros</DialogTitle>
        <DialogDescription>
          {rows.length > 0 ? `${rows.length} trastero(s).` : 'Trasteros de este local.'}
        </DialogDescription>
      </DialogHeader>

      {units.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Este local no tiene trasteros.
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Código</th>
                <th className="p-2">Tipo</th>
                <th className="p-2 text-right">m²</th>
                <th className="p-2 text-right">Precio/mes</th>
                <th className="p-2">Estado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-t">
                  <td className="p-2 font-medium">{u.code}</td>
                  <td className="p-2 text-muted-foreground">{u.unitTypeName}</td>
                  <td className="p-2 text-right tabular-nums">{fmtArea(u.areaM2)}</td>
                  <td className="p-2 text-right tabular-nums">{fmtMoney(u.basePriceMonthly)}</td>
                  <td className="p-2">
                    <Badge variant={STATUS_VARIANT[u.status] ?? 'secondary'}>
                      {STATUS_LABELS[u.status] ?? u.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
