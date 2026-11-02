'use client';

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminPlatformBannerDto, UpsertPlatformBannerInput } from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { DateTimeSelect } from '@/components/date-time-select';
import { PlatformBannerPreview } from '@/components/layout/platform-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useAdminBanners, useDeleteBanner, useSaveBanner } from '@/lib/admin/comms-hooks';
import { useAdminSubscriptionPlans } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const LEVELS = [
  { value: 'info', label: 'Información' },
  { value: 'warning', label: 'Aviso' },
  { value: 'critical', label: 'Crítico' },
] as const;

const STATUSES = [
  { value: 'active', label: 'Activos' },
  { value: 'trial', label: 'En prueba' },
  { value: 'suspended', label: 'Suspendidos' },
] as const;

const EMPTY: UpsertPlatformBannerInput = {
  message: '',
  level: 'info',
  enabled: true,
  startsAt: null,
  endsAt: null,
  dismissible: true,
  linkUrl: null,
  linkLabel: null,
  plans: [],
  statuses: [],
  priority: 0,
};

export default function AdminPlatformBannerPage() {
  const banners = useAdminBanners();
  const del = useDeleteBanner();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const [editing, setEditing] = useState<AdminPlatformBannerDto | 'new' | null>(null);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Banners y avisos</h1>
          <p className="text-sm text-muted-foreground">
            Se ven en la parte superior del panel de los tenants. Si a un tenant le tocan varios, ve
            el de más prioridad.
          </p>
        </div>
        <Button disabled={!canEdit} onClick={() => setEditing('new')}>
          <Plus className="mr-1.5 size-4" /> Nuevo banner
        </Button>
      </div>

      {banners.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (banners.data ?? []).length === 0 ? (
        <p className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          No hay banners.
        </p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {(banners.data ?? []).map((b) => (
            <li key={b.id} className="space-y-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={b.live ? 'default' : 'outline'}>
                  {b.live ? 'Se ve ahora' : b.enabled ? 'Fuera de fechas' : 'Apagado'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Prioridad {b.priority}
                  {b.startsAt ? ` · desde ${formatDateTime(b.startsAt)}` : ''}
                  {b.endsAt ? ` · hasta ${formatDateTime(b.endsAt)}` : ''}
                  {b.plans.length ? ` · planes: ${b.plans.join(', ')}` : ''}
                  {b.statuses.length
                    ? ` · ${b.statuses.map((s) => STATUSES.find((x) => x.value === s)?.label ?? s).join(', ')}`
                    : ''}
                </span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Editar"
                    title="Editar"
                    disabled={!canEdit}
                    onClick={() => setEditing(b)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Borrar"
                    title="Borrar"
                    disabled={!canEdit}
                    onClick={async () => {
                      if (await confirm({ title: '¿Borrar este banner?' })) del.mutate(b.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="overflow-hidden rounded-md border">
                <PlatformBannerPreview banner={b} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <BannerDialog
          banner={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function BannerDialog({
  banner,
  onClose,
}: {
  banner: AdminPlatformBannerDto | null;
  onClose: () => void;
}) {
  const save = useSaveBanner();
  const plans = useAdminSubscriptionPlans();
  const [form, setForm] = useState<UpsertPlatformBannerInput>(
    banner
      ? {
          message: banner.message,
          level: banner.level,
          enabled: banner.enabled,
          startsAt: banner.startsAt,
          endsAt: banner.endsAt,
          dismissible: banner.dismissible,
          linkUrl: banner.linkUrl,
          linkLabel: banner.linkLabel,
          plans: banner.plans,
          statuses: banner.statuses as UpsertPlatformBannerInput['statuses'],
          priority: banner.priority,
        }
      : EMPTY,
  );
  const toggle = <T extends string>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  async function onSave() {
    try {
      await save.mutateAsync({ ...(banner ? { id: banner.id } : {}), input: form });
      toast.success('Banner guardado.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{banner ? 'Editar banner' : 'Nuevo banner'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bn-msg">Mensaje</Label>
            <Textarea
              id="bn-msg"
              rows={2}
              maxLength={500}
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Nivel</Label>
              <Select
                value={form.level}
                onValueChange={(v) =>
                  setForm({ ...form, level: v as UpsertPlatformBannerInput['level'] })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bn-prio">Prioridad (0-100)</Label>
              <Input
                id="bn-prio"
                type="number"
                min={0}
                max={100}
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: Number(e.target.value) || 0 })}
              />
            </div>
            <label className="flex items-center gap-2 pt-6 text-sm">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Activado
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bn-link">Enlace (opcional)</Label>
              <Input
                id="bn-link"
                placeholder="/settings/saas-billing o https://…"
                value={form.linkUrl ?? ''}
                onChange={(e) => setForm({ ...form, linkUrl: e.target.value.trim() || null })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bn-link-label">Texto del enlace</Label>
              <Input
                id="bn-link-label"
                maxLength={40}
                placeholder="Ver más"
                value={form.linkLabel ?? ''}
                onChange={(e) => setForm({ ...form, linkLabel: e.target.value || null })}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Empieza a verse (opcional)</Label>
              <DateTimeSelect
                value={form.startsAt}
                onChange={(startsAt) => setForm({ ...form, startsAt })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Deja de verse (opcional)</Label>
              <DateTimeSelect
                value={form.endsAt}
                onChange={(endsAt) => setForm({ ...form, endsAt })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Solo para estos planes (vacío = todos)</Label>
            <div className="flex flex-wrap gap-1.5">
              {(plans.data ?? []).map((p) => (
                <button
                  key={p.slug}
                  type="button"
                  onClick={() => setForm({ ...form, plans: toggle(form.plans, p.slug) })}
                  className={`rounded-full border px-2.5 py-1 text-xs ${form.plans.includes(p.slug) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Solo para tenants (vacío = todos)</Label>
            <div className="flex flex-wrap gap-1.5">
              {STATUSES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setForm({ ...form, statuses: toggle(form.statuses, s.value) })}
                  className={`rounded-full border px-2.5 py-1 text-xs ${form.statuses.includes(s.value) ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.dismissible}
              disabled={form.level === 'critical'}
              onChange={(e) => setForm({ ...form, dismissible: e.target.checked })}
            />
            Cada usuario puede cerrarlo
            {form.level === 'critical' && (
              <span className="text-xs text-muted-foreground">(los críticos no se cierran)</span>
            )}
          </label>
          {form.message.trim() && (
            <div className="overflow-hidden rounded-md border">
              <PlatformBannerPreview
                banner={{
                  id: 'preview',
                  message: form.message,
                  level: form.level,
                  enabled: true,
                  linkUrl: form.linkUrl,
                  linkLabel: form.linkLabel,
                  endsAt: form.endsAt,
                  dismissible: form.dismissible,
                  updatedAt: '',
                }}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={form.message.trim().length < 3 || save.isPending}
            onClick={() => void onSave()}
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
