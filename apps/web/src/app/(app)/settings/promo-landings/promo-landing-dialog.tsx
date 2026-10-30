'use client';

import {
  PROMO_SLUG_RE,
  defaultPromoLandingContent,
  type PromoLandingContent,
  type PromoLandingDto,
} from '@storageos/shared';
import { Eye, ImagePlus, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { cleanPromoContent, PromoContentEditor } from './promo-content-editor';

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
import { useCoupons } from '@/lib/coupons/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { compressImage } from '@/lib/images/compress';
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
  content: PromoLandingContent;
  seoTitle: string;
  seoDescription: string;
  indexable: boolean;
}

function toForm(p?: PromoLandingDto): Form {
  return {
    name: p?.name ?? '',
    slug: p?.slug ?? '',
    isActive: p?.isActive ?? false,
    startsAt: toDateInput(p?.startsAt ?? null),
    endsAt: toDateInput(p?.endsAt ?? null),
    headline: p?.headline ?? '',
    subheadline: p?.subheadline ?? '',
    couponId: p?.couponId ?? '',
    facilityIds: p?.facilityIds ?? [],
    unitTypeIds: p?.unitTypeIds ?? [],
    showCountdown: p?.showCountdown ?? false,
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
  const create = useCreatePromoLanding();
  const update = useUpdatePromoLanding();
  const invalidate = useInvalidatePromoLandings();
  const coupons = useCoupons();
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const whatsapp = useWhatsappSettings();
  const whatsappAvailable = !!(whatsapp.data?.enabled && whatsapp.data.webButtonEnabled);
  const [current, setCurrent] = useState<PromoLandingDto | undefined>(landing);
  const [form, setForm] = useState<Form>(toForm(landing));
  const [slugTouched, setSlugTouched] = useState(!!landing);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent(landing);
    setForm(toForm(landing));
    setSlugTouched(!!landing);
  }, [open, landing]);

  const setContent = (fn: (c: PromoLandingContent) => PromoLandingContent) =>
    setForm((f) => ({ ...f, content: fn(f.content) }));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (k: 'facilityIds' | 'unitTypeIds', id: string) =>
    setForm((f) => ({
      ...f,
      [k]: f[k].includes(id) ? f[k].filter((x) => x !== id) : [...f[k], id],
    }));

  const slugOk = PROMO_SLUG_RE.test(form.slug);
  const canSave = form.name.trim() && form.headline.trim() && slugOk;

  async function save() {
    const input = {
      name: form.name.trim(),
      slug: form.slug,
      isActive: form.isActive,
      startsAt: fromDateInput(form.startsAt, false),
      endsAt: fromDateInput(form.endsAt, true),
      headline: form.headline.trim(),
      subheadline: form.subheadline.trim() || null,
      couponId: form.couponId || null,
      facilityIds: form.facilityIds,
      unitTypeIds: form.unitTypeIds,
      showCountdown: form.showCountdown,
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
        toast.success('Landing creada. Ya puedes subir la foto.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onPreview() {
    if (!current) return;
    try {
      const { url } = await previewPromoLanding(current.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onImage(file: File | undefined) {
    if (!file || !current) return;
    setUploading(true);
    try {
      const saved = await uploadPromoLandingImage(current.id, await compressImage(file));
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
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                  value={form.slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    set('slug', e.target.value.toLowerCase());
                  }}
                />
              </div>
              {form.slug && !slugOk && (
                <p className="mt-1 text-xs text-destructive">
                  Solo minúsculas, números y guiones (sin espacios).
                </p>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <Checkbox
                checked={form.isActive}
                onCheckedChange={(v) => set('isActive', v === true)}
              />
              Activa (visible en la web)
            </label>
            <div>
              <Label htmlFor="pl-from">Desde (opcional)</Label>
              <Input
                id="pl-from"
                type="date"
                value={form.startsAt}
                onChange={(e) => set('startsAt', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="pl-until">Hasta (opcional)</Label>
              <Input
                id="pl-until"
                type="date"
                value={form.endsAt}
                onChange={(e) => set('endsAt', e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Apagada o fuera de fechas, su dirección lleva a la portada de tu web.
            </p>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Portada</h3>
            <div>
              <Label htmlFor="pl-headline">Titular</Label>
              <Input
                id="pl-headline"
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
            <Button variant="ghost" onClick={() => void onPreview()}>
              <Eye className="mr-1 h-4 w-4" />
              Vista previa
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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
