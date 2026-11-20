'use client';

import {
  PROMO_SLUG_RE,
  defaultPromoLandingContent,
  type PromoLandingContent,
  type PromoLandingDto,
} from '@storageos/shared';
import { Eye, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { cleanPromoContent, PromoContentEditor } from './promo-content-editor';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useMe } from '@/lib/auth/hooks';
import { useTenantBranding } from '@/lib/branding/hooks';
import { useCoupons } from '@/lib/coupons/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { compressImage } from '@/lib/images/compress';
import { isoToZonedDate, zonedDateToIso } from '@/lib/promo-landings/dates';
import {
  previewPromoLanding,
  removePromoLandingImage,
  uploadPromoLandingImage,
  useCreatePromoLanding,
  useInvalidatePromoLandings,
  useUpdatePromoLanding,
} from '@/lib/promo-landings/hooks';
import { useWhatsappSettings } from '@/lib/whatsapp/hooks';

const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm';

function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

interface Form {
  name: string;
  slug: string;
  isActive: boolean;
  startsAt: string;
  endsAt: string;
  headline: string;
  subheadline: string;
  couponId: string;
  facilityIds: string[];
  unitTypeIds: string[];
  showCountdown: boolean;
  shortPath: boolean;
  content: PromoLandingContent;
  seoTitle: string;
  seoDescription: string;
  indexable: boolean;
}

/** Lo que admite el servidor para la foto (también tras comprimirla). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Las fechas en la zona horaria del negocio, no en la del navegador. */
function toForm(p: PromoLandingDto | undefined, timeZone: string): Form {
  return {
    name: p?.name ?? '',
    slug: p?.slug ?? '',
    isActive: p?.isActive ?? false,
    startsAt: isoToZonedDate(p?.startsAt ?? null, timeZone),
    endsAt: isoToZonedDate(p?.endsAt ?? null, timeZone),
    headline: p?.headline ?? '',
    subheadline: p?.subheadline ?? '',
    couponId: p?.couponId ?? '',
    facilityIds: p?.facilityIds ?? [],
    unitTypeIds: p?.unitTypeIds ?? [],
    showCountdown: p?.showCountdown ?? false,
    shortPath: p?.shortPath ?? false,
    content: p?.content ?? defaultPromoLandingContent(),
    seoTitle: p?.seoTitle ?? '',
    seoDescription: p?.seoDescription ?? '',
    indexable: p?.indexable ?? false,
  };
}

export function PromoLandingDialog({
  open,
  onOpenChange,
  landing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landing?: PromoLandingDto;
}) {
  const ask = useConfirm();
  const me = useMe();
  const timeZone = me.data?.tenant.timezone ?? 'Europe/Madrid';
  const create = useCreatePromoLanding();
  const update = useUpdatePromoLanding();
  const invalidate = useInvalidatePromoLandings();
  const coupons = useCoupons();
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  // Sin el extra de WhatsApp no se piden sus ajustes (darían 403).
  const hasWhatsapp = useHasFeature('whatsapp_business');
  const whatsapp = useWhatsappSettings(hasWhatsapp);
  const branding = useTenantBranding();
  const domain =
    branding.data?.customDomain && branding.data.customDomainVerifiedAt
      ? branding.data.customDomain
      : null;
  const whatsappAvailable =
    hasWhatsapp && !!(whatsapp.data?.enabled && whatsapp.data.webButtonEnabled);
  const [current, setCurrent] = useState<PromoLandingDto | undefined>(landing);
  const [form, setForm] = useState<Form>(toForm(landing, timeZone));
  const [slugTouched, setSlugTouched] = useState(!!landing);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent(landing);
    setForm(toForm(landing, timeZone));
    setSlugTouched(!!landing);
  }, [open, landing, timeZone]);

  // ¿Hay cambios sin guardar? (para avisar al cerrar y en la vista previa)
  const baseline = useMemo(() => JSON.stringify(toForm(current, timeZone)), [current, timeZone]);
  const dirty = JSON.stringify(form) !== baseline;

  async function requestOpenChange(next: boolean) {
    if (!next && dirty && !(create.isPending || update.isPending)) {
      const ok = await ask({
        title: '¿Cerrar sin guardar?',
        description: 'Perderás los cambios que no has guardado.',
        confirmLabel: 'Cerrar sin guardar',
        destructive: true,
      });
      if (!ok) return;
    }
    onOpenChange(next);
  }

  const setContent = (fn: (c: PromoLandingContent) => PromoLandingContent) =>
    setForm((f) => ({ ...f, content: fn(f.content) }));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: 'facilityIds' | 'unitTypeIds', id: string) =>
    setForm((f) => ({
      ...f,
      [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id],
    }));

  const slugOk = PROMO_SLUG_RE.test(form.slug) && form.slug.length >= 2;
  const startsIso = zonedDateToIso(form.startsAt, timeZone, false);
  const endsIso = zonedDateToIso(form.endsAt, timeZone, true);
  const datesOk = !startsIso || !endsIso || new Date(startsIso) < new Date(endsIso);
  const canSave = form.name.trim() && form.headline.trim() && slugOk && datesOk;
  const slugChanged = !!current && form.slug !== current.slug;

  // Solo los locales y tamaños que siguen existiendo (uno borrado ya no se puede guardar).
  const keepLive = (ids: string[], live: { id: string }[] | undefined) => {
    if (!live) return ids;
    const set = new Set(live.map((x) => x.id));
    return ids.filter((id) => set.has(id));
  };

  async function save() {
    const input = {
      name: form.name.trim(),
      slug: form.slug,
      isActive: form.isActive,
      startsAt: startsIso,
      endsAt: endsIso,
      headline: form.headline.trim(),
      subheadline: form.subheadline.trim() || null,
      couponId: form.couponId || null,
      // Con alcance por local la lista no trae todos: lo filtra el servidor.
      facilityIds: me.data?.facilityScope
        ? form.facilityIds
        : keepLive(form.facilityIds, facilities.data),
      unitTypeIds: keepLive(form.unitTypeIds, unitTypes.data),
      showCountdown: form.showCountdown,
      shortPath: form.shortPath,
      content: cleanPromoContent(form.content),
      seoTitle: form.seoTitle.trim() || null,
      seoDescription: form.seoDescription.trim() || null,
      indexable: form.indexable,
    };
    try {
      if (current) {
        const saved = await update.mutateAsync({ id: current.id, input });
        setCurrent(saved);
        toast.success('Landing guardada.');
        onOpenChange(false);
      } else {
        const saved = await create.mutateAsync(input);
        setCurrent(saved);
        setForm(toForm(saved, timeZone));
        toast.success('Landing creada. Ya puedes subir la foto.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onPreview() {
    if (!current) return;
    // La ventana se abre ya (Safari bloquea las que se abren tras esperar al servidor).
    const win = window.open('', '_blank');
    if (win) win.opener = null;
    if (dirty) {
      toast.message('La vista previa enseña lo guardado: guarda para ver tus últimos cambios.');
    }
    try {
      const { url } = await previewPromoLanding(current.id);
      if (win) win.location.href = url;
      else window.location.assign(url);
    } catch (err) {
      win?.close();
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onImage(file: File | undefined) {
    if (!file || !current) return;
    setUploading(true);
    try {
      const small = await compressImage(file);
      if (small.size > MAX_IMAGE_BYTES) {
        toast.error('La foto pesa más de 5 MB incluso reducida. Usa una más pequeña.');
        return;
      }
      const saved = await uploadPromoLandingImage(current.id, small);
      setCurrent(saved);
      void invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir la foto');
    } finally {
      setUploading(false);
    }
  }

  async function onRemoveImage() {
    if (!current) return;
    try {
      setCurrent(await removePromoLandingImage(current.id));
      void invalidate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const busy = create.isPending || update.isPending;
  const landingSizes = (unitTypes.data ?? [])
    .filter((ut) => form.unitTypeIds.length === 0 || form.unitTypeIds.includes(ut.id))
    .map((ut) => ({ id: ut.id, name: ut.name }));
  const activeCoupons = (coupons.data ?? []).filter((c) => c.isActive || c.id === form.couponId);

  return (
    <Dialog open={open} onOpenChange={(o) => void requestOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{current ? 'Editar landing' : 'Nueva landing de promoción'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <section className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pl-name">Nombre interno</Label>
              <Input
                id="pl-name"
                maxLength={120}
                value={form.name}
                placeholder="Verano 2026"
                onChange={(e) => {
                  set('name', e.target.value);
                  if (!slugTouched) set('slug', slugify(e.target.value));
                }}
              />
            </div>
            <div>
              <Label htmlFor="pl-slug">Dirección</Label>
              <div className="flex items-center gap-1">
                <span className="text-sm text-muted-foreground">/promo/</span>
                <Input
                  id="pl-slug"
                  maxLength={60}
                  value={form.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    set('slug', e.target.value.toLowerCase());
                  }}
                />
              </div>
              {form.slug && !slugOk && (
                <p className="mt-1 text-xs text-destructive">
                  Solo minúsculas, números y guiones (sin espacios), de 2 a 60 caracteres.
                </p>
              )}
              {slugChanged && slugOk && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Los enlaces y códigos QR que ya hayas repartido con la dirección anterior (/promo/
                  {current?.slug}) dejarán de funcionar.
                </p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={form.shortPath}
                  disabled={!domain}
                  onCheckedChange={(v) => set('shortPath', v === true)}
                />
                <span>
                  Dirección corta
                  {domain && form.slug ? (
                    <span className="font-mono text-muted-foreground">
                      {' '}
                      ({domain}/{form.slug})
                    </span>
                  ) : null}
                  <span className="block text-xs text-muted-foreground">
                    {domain
                      ? 'Además de /promo/…, responde sin «promo». No puede coincidir con un local, una ciudad ni una página fija de la web.'
                      : 'Solo con dominio propio (Configuración → Dominio propio).'}
                  </span>
                </span>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox
                checked={form.isActive}
                onCheckedChange={(v) => set('isActive', v === true)}
              />
              Activa (visible en la web)
            </label>
            <div className="space-y-1">
              <Label>Desde (opcional)</Label>
              <div className="flex items-center gap-2">
                <DateSelect
                  around
                  value={form.startsAt || undefined}
                  onChange={(v) => set('startsAt', v ?? '')}
                />
                {form.startsAt && (
                  <Button variant="ghost" size="sm" onClick={() => set('startsAt', '')}>
                    Quitar
                  </Button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Hasta (opcional, incluido)</Label>
              <div className="flex items-center gap-2">
                <DateSelect
                  around
                  value={form.endsAt || undefined}
                  onChange={(v) => set('endsAt', v ?? '')}
                />
                {form.endsAt && (
                  <Button variant="ghost" size="sm" onClick={() => set('endsAt', '')}>
                    Quitar
                  </Button>
                )}
              </div>
            </div>
            {!datesOk && (
              <p className="text-xs text-destructive sm:col-span-2">
                La fecha de fin debe ser posterior a la de inicio.
              </p>
            )}
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Las fechas van en la hora de tu negocio ({timeZone}). Apagada o fuera de fechas, su
              dirección lleva a la portada de tu web.
            </p>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Portada</h3>
            <div>
              <Label htmlFor="pl-headline">Titular</Label>
              <Input
                id="pl-headline"
                maxLength={140}
                value={form.headline}
                placeholder="Abrimos local nuevo en Mislata"
                onChange={(e) => set('headline', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pl-sub">Texto bajo el titular</Label>
              <Textarea
                id="pl-sub"
                rows={2}
                maxLength={400}
                value={form.subheadline}
                onChange={(e) => set('subheadline', e.target.value)}
              />
            </div>
            <div>
              <Label>Foto principal</Label>
              {current ? (
                <div className="flex items-center gap-3">
                  {current.heroImageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={current.heroImageUrl}
                      alt=""
                      className="h-20 w-32 rounded-md object-cover"
                    />
                  )}
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                    {uploading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ImagePlus className="h-4 w-4" />
                    )}
                    {current.heroImageUrl ? 'Cambiar' : 'Subir'} foto
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => void onImage(e.target.files?.[0])}
                    />
                  </label>
                  {current.heroImageUrl && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onRemoveImage}
                      aria-label="Quitar foto"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Guarda la landing y podrás subir la foto. Sin foto se usa la del local.
                </p>
              )}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Promoción</h3>
            <div>
              <Label htmlFor="pl-coupon">Cupón que se aplica al reservar (opcional)</Label>
              <select
                id="pl-coupon"
                className={selectClass}
                value={form.couponId}
                onChange={(e) => set('couponId', e.target.value)}
              >
                <option value="">Sin cupón (el cliente puede escribir uno al reservar)</option>
                {activeCoupons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Locales (ninguno marcado = todos)</Label>
              <div className="mt-1 flex flex-wrap gap-3">
                {(facilities.data ?? []).map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.facilityIds.includes(f.id)}
                      onCheckedChange={() => toggleIn('facilityIds', f.id)}
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <Label>Tamaños (ninguno marcado = todos)</Label>
              <div className="mt-1 flex flex-wrap gap-3">
                {(unitTypes.data ?? []).map((ut) => (
                  <label key={ut.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={form.unitTypeIds.includes(ut.id)}
                      onCheckedChange={() => toggleIn('unitTypeIds', ut.id)}
                    />
                    {ut.name}
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Bloques de la landing</h3>
            <p className="text-xs text-muted-foreground">
              Muestra, oculta y ordena cada bloque. Los colores, la letra y la forma de los botones
              salen de la plantilla de tu web.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.showCountdown}
                onCheckedChange={(v) => set('showCountdown', v === true)}
              />
              Cuenta atrás hasta la fecha de fin (en la portada)
            </label>
            <PromoContentEditor
              key={current?.id ?? 'new'}
              content={form.content}
              setContent={setContent}
              sizes={landingSizes}
              whatsappAvailable={whatsappAvailable}
              hasCoupon={!!form.couponId}
            />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Google</h3>
            <div>
              <Label htmlFor="pl-seo-title">Título (opcional)</Label>
              <Input
                id="pl-seo-title"
                maxLength={70}
                value={form.seoTitle}
                onChange={(e) => set('seoTitle', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pl-seo-desc">Descripción (opcional)</Label>
              <Textarea
                id="pl-seo-desc"
                rows={2}
                maxLength={200}
                value={form.seoDescription}
                onChange={(e) => set('seoDescription', e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.indexable}
                onCheckedChange={(v) => set('indexable', v === true)}
              />
              Dejar que Google la muestre (por defecto no, para que no salgan promociones pasadas)
            </label>
          </section>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {current ? (
            <Button
              variant="ghost"
              onClick={() => void onPreview()}
              title="Enseña lo guardado (válida 30 minutos)"
            >
              <Eye className="mr-1 h-4 w-4" />
              Vista previa{dirty ? ' (de lo guardado)' : ''}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void requestOpenChange(false)}>
              {current && !landing ? 'Cerrar' : 'Cancelar'}
            </Button>
            <Button onClick={() => void save()} disabled={!canSave || busy}>
              {busy ? 'Guardando…' : 'Guardar'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
