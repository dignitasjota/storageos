'use client';

import { Loader2, Save, Trash2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { AnnouncementSegment } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useAnnouncementPreview,
  useDeleteSegment,
  useSaveSegment,
  useSavedSegments,
} from '@/lib/admin/comms-hooks';
import { useAdminAddons, useAdminSubscriptionPlans, useAdminTenantTags } from '@/lib/admin/hooks';

const AUDIENCES = [
  { value: 'active', label: 'Activos' },
  { value: 'trial', label: 'En prueba' },
  { value: 'all', label: 'Activos y en prueba' },
] as const;

const HEALTH = [
  { value: 'healthy', label: 'Sana' },
  { value: 'warm', label: 'Tibia' },
  { value: 'at_risk', label: 'En riesgo' },
  { value: 'dormant', label: 'Dormida' },
] as const;

const NONE = '__none__';

function toggle<T>(list: T[] | undefined, value: T): T[] {
  const cur = list ?? [];
  return cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
}

/** Quita los filtros vacíos (para guardar y comparar). */
export function cleanSegment(s: AnnouncementSegment): AnnouncementSegment {
  const out: AnnouncementSegment = { audience: s.audience };
  if (s.tenantIds?.length) out.tenantIds = s.tenantIds;
  if (s.tag) out.tag = s.tag;
  if (s.plans?.length) out.plans = s.plans;
  if (s.addons?.length) out.addons = s.addons;
  if (s.missingAddons?.length) out.missingAddons = s.missingAddons;
  if (s.health?.length) out.health = s.health;
  if (s.inactiveDays) out.inactiveDays = s.inactiveDays;
  if (s.minFacilities != null) out.minFacilities = s.minFacilities;
  if (s.maxFacilities != null) out.maxFacilities = s.maxFacilities;
  return out;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-primary bg-primary text-primary-foreground'
          : 'bg-background hover:bg-muted'
      }`}
    >
      {children}
    </button>
  );
}

/** A quién va: público, filtros, segmentos guardados y recuento previo. */
export function SegmentBuilder({
  value,
  onChange,
  commercial,
}: {
  value: AnnouncementSegment;
  onChange: (s: AnnouncementSegment) => void;
  commercial: boolean;
}) {
  const plans = useAdminSubscriptionPlans();
  const addonsQuery = useAdminAddons();
  const addons = { data: (addonsQuery.data ?? []).filter((a) => a.isActive) };
  const tags = useAdminTenantTags();
  const saved = useSavedSegments();
  const saveSegment = useSaveSegment();
  const deleteSegment = useDeleteSegment();
  const [segmentName, setSegmentName] = useState('');

  // El recuento se pide tras dejar de tocar los filtros.
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cleanSegment(value)), 400);
    return () => clearTimeout(t);
  }, [value]);
  const preview = useAnnouncementPreview(debounced, commercial);

  const set = (patch: Partial<AnnouncementSegment>) => onChange({ ...value, ...patch });
  const selection = !!value.tenantIds?.length;

  return (
    <div className="space-y-4">
      {selection ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {value.tenantIds?.length} tenant(s) elegidos desde la lista.{' '}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => set({ tenantIds: undefined })}
          >
            Usar filtros
          </button>
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Estado</Label>
              <Select
                value={value.audience}
                onValueChange={(v) => set({ audience: v as AnnouncementSegment['audience'] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCES.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Etiqueta</Label>
              <Select
                value={value.tag ?? NONE}
                onValueChange={(v) => set({ tag: v === NONE ? undefined : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Cualquiera</SelectItem>
                  {(tags.data ?? []).map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Plan</Label>
            <div className="flex flex-wrap gap-1.5">
              {(plans.data ?? []).map((p) => (
                <Chip
                  key={p.slug}
                  active={!!value.plans?.includes(p.slug)}
                  onClick={() => set({ plans: toggle(value.plans, p.slug) })}
                >
                  {p.name}
                </Chip>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Con el extra</Label>
              <div className="flex flex-wrap gap-1.5">
                {(addons.data ?? []).map((a) => (
                  <Chip
                    key={a.slug}
                    active={!!value.addons?.includes(a.slug)}
                    onClick={() => set({ addons: toggle(value.addons, a.slug) })}
                  >
                    {a.name}
                  </Chip>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Sin el extra</Label>
              <div className="flex flex-wrap gap-1.5">
                {(addons.data ?? []).map((a) => (
                  <Chip
                    key={a.slug}
                    active={!!value.missingAddons?.includes(a.slug)}
                    onClick={() => set({ missingAddons: toggle(value.missingAddons, a.slug) })}
                  >
                    {a.name}
                  </Chip>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Salud</Label>
            <div className="flex flex-wrap gap-1.5">
              {HEALTH.map((h) => (
                <Chip
                  key={h.value}
                  active={!!value.health?.includes(h.value)}
                  onClick={() => set({ health: toggle(value.health, h.value) })}
                >
                  {h.label}
                </Chip>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="seg-inactive">Sin entrar desde (días)</Label>
              <Input
                id="seg-inactive"
                type="number"
                min={1}
                max={365}
                value={value.inactiveDays ?? ''}
                onChange={(e) =>
                  set({ inactiveDays: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seg-min">Locales, mínimo</Label>
              <Input
                id="seg-min"
                type="number"
                min={0}
                value={value.minFacilities ?? ''}
                onChange={(e) =>
                  set({ minFacilities: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="seg-max">Locales, máximo</Label>
              <Input
                id="seg-max"
                type="number"
                min={0}
                value={value.maxFacilities ?? ''}
                onChange={(e) =>
                  set({ maxFacilities: e.target.value ? Number(e.target.value) : undefined })
                }
              />
            </div>
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <Users className="size-4 text-muted-foreground" />
        {preview.isFetching && !preview.data ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <span>
            <strong>{preview.data?.tenants ?? 0}</strong> tenant(s) ·{' '}
            <strong>{preview.data?.recipients ?? 0}</strong> correo(s)
            {preview.data?.optedOut ? ` · ${preview.data.optedOut} de baja` : ''}
          </span>
        )}
        {preview.data?.sample.length ? (
          <span className="truncate text-xs text-muted-foreground">
            {preview.data.sample.join(', ')}
            {preview.data.tenants > preview.data.sample.length ? '…' : ''}
          </span>
        ) : null}
      </div>

      {!selection && (
        <div className="flex flex-wrap items-end gap-2">
          {(saved.data ?? []).length > 0 && (
            <div className="space-y-1.5">
              <Label>Segmentos guardados</Label>
              <div className="flex flex-wrap gap-1.5">
                {(saved.data ?? []).map((v) => (
                  <span
                    key={v.id}
                    className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs"
                  >
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() => onChange(v.filters as AnnouncementSegment)}
                    >
                      {v.name}
                    </button>
                    <button
                      type="button"
                      aria-label={`Borrar el segmento ${v.name}`}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => deleteSegment.mutate(v.id)}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="ml-auto flex items-end gap-2">
            <Input
              className="h-8 w-44"
              placeholder="Nombre del segmento"
              value={segmentName}
              onChange={(e) => setSegmentName(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!segmentName.trim() || saveSegment.isPending}
              onClick={async () => {
                await saveSegment.mutateAsync({
                  name: segmentName.trim(),
                  segment: cleanSegment(value),
                });
                setSegmentName('');
                toast.success('Segmento guardado.');
              }}
            >
              <Save className="mr-1.5 size-3.5" /> Guardar segmento
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
