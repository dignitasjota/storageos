'use client';

import {
  WEB_TEMPLATES,
  type UpdateWebSettingsInput,
  type WebSections,
  type WebSettingsResponse,
  type WebTemplateValue,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink,
  Globe,
  Link as LinkIcon,
  Loader2,
  Plus,
  Trash2,
  TrendingUp,
  Type,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { WebHeroCard } from './web-hero-card';
import { emptySeoForm, seoFormFrom, type SeoForm, WebSeoCard } from './web-seo-card';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { UnsavedChangesBar } from '@/components/unsaved-changes-bar';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useTenantBranding } from '@/lib/branding/hooks';
import { runSaveSteps, useUnsavedChangesGuard } from '@/lib/unsaved-changes';
import {
  useUpdateWebSettings,
  useWebPerformance,
  useWebSettings,
  webSettingsKey,
} from '@/lib/web-settings/hooks';

const DEFAULT_SECTIONS: WebSections = { testimonials: false, faq: false, contact: false };

type Item = { title: string; text: string };

/** Todo lo que se edita en la página (se guarda de una vez con la barra de abajo). */
interface WebForm {
  template: WebTemplateValue;
  headline: string;
  about: string;
  sections: WebSections;
  heroSubtitle: string;
  services: Item[];
  advantages: string[];
  steps: Item[];
  externalSiteUrl: string;
  seo: SeoForm;
}

function formFrom(d: WebSettingsResponse): WebForm {
  const c = d.content ?? {};
  return {
    template: d.template,
    headline: d.headline ?? '',
    about: d.about ?? '',
    sections: { ...DEFAULT_SECTIONS, ...(d.sections ?? {}) },
    heroSubtitle: c.heroSubtitle ?? '',
    services: (c.services ?? []).map((s) => ({ title: s.title, text: s.text ?? '' })),
    advantages: c.advantages ?? [],
    steps: (c.steps ?? []).map((s) => ({ title: s.title, text: s.text ?? '' })),
    externalSiteUrl: d.externalSiteUrl ?? '',
    seo: d.seo ? seoFormFrom(d.seo) : emptySeoForm(),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const cleanItems = (items: Item[]) =>
  items
    .map((i) => ({ title: i.title.trim(), text: i.text.trim() }))
    .filter((i) => i.title.length > 0);

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo guardar.';
}

/** Solo lo que ha cambiado respecto a lo guardado. */
function buildPatch(form: WebForm, saved: WebForm): UpdateWebSettingsInput | null {
  const patch: Record<string, unknown> = {};
  if (form.template !== saved.template) patch.template = form.template;
  if (
    form.template === 'external' &&
    (form.externalSiteUrl !== saved.externalSiteUrl || form.template !== saved.template)
  ) {
    patch.externalSiteUrl = form.externalSiteUrl.trim();
  }
  if (form.headline !== saved.headline) patch.headline = form.headline;
  if (form.about !== saved.about) patch.about = form.about;
  if (!same(form.sections, saved.sections)) patch.sections = form.sections;
  if (
    form.heroSubtitle !== saved.heroSubtitle ||
    !same(form.services, saved.services) ||
    !same(form.advantages, saved.advantages) ||
    !same(form.steps, saved.steps)
  ) {
    patch.content = {
      heroSubtitle: form.heroSubtitle.trim(),
      services: cleanItems(form.services),
      advantages: form.advantages.map((a) => a.trim()).filter((a) => a.length > 0),
      steps: cleanItems(form.steps),
    };
  }
  if (!same(form.seo, saved.seo)) {
    // Se mandan todos los campos: '' vuelve al texto generado.
    const seo = { ...form.seo };
    for (const k of Object.keys(seo) as (keyof SeoForm)[]) seo[k] = seo[k].trim();
    patch.seo = seo;
  }
  return Object.keys(patch).length > 0 ? (patch as UpdateWebSettingsInput) : null;
}

/** Plantillas multisección que usan el copy editable de secciones. */
function usesContent(template: WebTemplateValue): boolean {
  return (
    template === 'onepage' ||
    template === 'escaparate' ||
    template === 'corporate' ||
    template === 'onepagemovil' ||
    template === 'trstrom' ||
    template === 'cabe'
  );
}

/** Plantillas que además de servicios usan «Ventajas» (con icono). */
function usesAdvantages(template: WebTemplateValue): boolean {
  return (
    template === 'escaparate' ||
    template === 'corporate' ||
    template === 'onepagemovil' ||
    template === 'trstrom' ||
    template === 'cabe'
  );
}

export default function WebSettingsPage() {
  const settings = useWebSettings();
  const update = useUpdateWebSettings();
  const qc = useQueryClient();
  const branding = useTenantBranding();
  const me = useMe();
  const slug = me.data?.tenant.slug;
  const domainVerified = branding.data?.customDomainVerifiedAt != null;

  // Lo que se está escribiendo. Se rellena una sola vez: subir una foto vuelve
  // a pedir la configuración y no debe borrar lo escrito.
  const [form, setForm] = useState<WebForm | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = settings.data ? formFrom(settings.data) : null;
  const dirty = form !== null && saved !== null && !same(form, saved);
  useUnsavedChangesGuard(dirty);

  useEffect(() => {
    if (settings.data && form === null) setForm(formFrom(settings.data));
  }, [settings.data, form]);

  function set<K extends keyof WebForm>(key: K, value: WebForm[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function save() {
    if (!form || !saved) return;
    const patch = buildPatch(form, saved);
    if (!patch) return;
    setSaving(true);
    const result: { response: WebSettingsResponse | null } = { response: null };
    const failed = await runSaveSteps(
      [
        {
          label: 'Web pública',
          run: async () => {
            result.response = await update.mutateAsync(patch);
          },
        },
      ],
      errorMessage,
    );
    setSaving(false);
    if (failed.length > 0) {
      toast.error(failed.map((f) => `${f.label}: ${f.message}`).join(' · '));
      return;
    }
    if (result.response) {
      qc.setQueryData(webSettingsKey, result.response);
      setForm(formFrom(result.response));
    }
    toast.success('Cambios guardados.');
  }

  if (settings.isLoading || (settings.data && !form)) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // Sin la configuración no se enseña el formulario: guardarlo pisaría la web.
  if (settings.isError || !settings.data || !form) {
    return <SectionError onRetry={() => void settings.refetch()} />;
  }

  const template = form.template;
  const externalBlocked = template === 'external' && !domainVerified;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Web pública</h1>
          <p className="text-sm text-muted-foreground">
            Personaliza la web de tu empresa: elige una plantilla y presenta tu negocio. Los
            clientes ven la disponibilidad y reservan online.
          </p>
        </div>
        {slug && (
          <Button asChild variant="outline" size="sm">
            <a href={`/s/${slug}`} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1 h-4 w-4" /> Ver mi web
            </a>
          </Button>
        )}
      </div>

      <WebPerformanceCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-5 w-5 text-muted-foreground" /> Plantilla de diseño
          </CardTitle>
          <CardDescription>Elige cómo se ve tu web pública.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            {WEB_TEMPLATES.map((tpl) => {
              const active = template === tpl.value;
              return (
                <button
                  key={tpl.value}
                  type="button"
                  onClick={() => set('template', tpl.value)}
                  className={`rounded-lg border p-4 text-left transition ${
                    active
                      ? 'border-primary bg-primary/5 ring-2 ring-primary'
                      : 'hover:border-foreground/30'
                  }`}
                >
                  <div className="font-medium">{tpl.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{tpl.description}</div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {template === 'external' && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <LinkIcon className="h-5 w-5 text-muted-foreground" /> Web externa
            </CardTitle>
            <CardDescription>
              Indica la URL donde ya tienes tu web alojada. La serviremos bajo tu dominio propio —
              no almacenamos tu contenido, solo lo enrutamos.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!domainVerified ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
                Necesitas un dominio propio verificado para usar una web externa.{' '}
                <a href="/settings/domain" className="underline">
                  Configúralo en «Dominio propio» →
                </a>
              </p>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="external-site-url">URL de tu web</Label>
                <Input
                  id="external-site-url"
                  value={form.externalSiteUrl}
                  onChange={(e) => set('externalSiteUrl', e.target.value)}
                  placeholder="https://tu-web-ya-alojada.com"
                  className="text-base sm:text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Debe empezar por <code>https://</code>. Se sirve en{' '}
                  <strong>{branding.data?.customDomain}</strong>.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {template === 'cabe' && (
        <WebHeroCard
          heroImageUrl={settings.data.heroImageUrl ?? null}
          heroBackgroundUrl={settings.data.heroBackgroundUrl ?? null}
        />
      )}

      {template !== 'external' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Secciones</CardTitle>
            <CardDescription>Elige qué mostrar en tu web pública.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <SectionToggle
              checked={form.sections.testimonials}
              onToggle={() =>
                set('sections', { ...form.sections, testimonials: !form.sections.testimonials })
              }
              label="Testimonios"
              hint="Muestra reseñas positivas de tus clientes (valoraciones NPS ≥ 9 con comentario)."
            />
            <SectionToggle
              checked={form.sections.faq}
              onToggle={() => set('sections', { ...form.sections, faq: !form.sections.faq })}
              label="Preguntas frecuentes"
              hint="Muestra las FAQ publicadas en tu centro de ayuda."
            />
            <SectionToggle
              checked={form.sections.contact}
              onToggle={() =>
                set('sections', { ...form.sections, contact: !form.sections.contact })
              }
              label="Formulario de contacto"
              hint="Un formulario en tu web; cada envío entra como lead en tu panel."
            />
          </CardContent>
        </Card>
      )}

      {usesContent(template) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Type className="h-5 w-5 text-muted-foreground" /> Contenido de las secciones
            </CardTitle>
            <CardDescription>
              Personaliza el copy de tu plantilla{' '}
              {template === 'onepage'
                ? '«Una página»'
                : template === 'corporate'
                  ? '«Corporativa»'
                  : template === 'onepagemovil'
                    ? '«OnePageMovil»'
                    : template === 'trstrom'
                      ? '«Trstrom»'
                      : template === 'cabe'
                        ? '«Cabe»'
                        : '«Escaparate»'}
              . Deja una sección vacía para usar los textos por defecto.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-1.5">
              <Label htmlFor="hero-subtitle">Subtítulo del hero</Label>
              <Input
                id="hero-subtitle"
                value={form.heroSubtitle}
                onChange={(e) => set('heroSubtitle', e.target.value)}
                maxLength={200}
                placeholder="Ej.: Tu espacio extra, fácil y sin complicaciones."
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Se muestra bajo el título principal. Vacío = texto por defecto.
              </p>
            </div>

            <ItemsEditor
              label={
                template === 'onepagemovil'
                  ? '¿Para qué lo necesitas?'
                  : template === 'trstrom'
                    ? '¿Por qué alquilar con nosotros?'
                    : template === 'cabe'
                      ? 'Ventajas (tarjetas)'
                      : 'Servicios'
              }
              hint={
                template === 'onepagemovil'
                  ? 'Bloques desplegables (título + una línea por cada punto).'
                  : template === 'trstrom' || template === 'cabe'
                    ? 'Tarjetas de ventajas o situaciones (título + descripción).'
                    : 'Tarjetas de servicios/usos (título + descripción).'
              }
              items={form.services}
              onChange={(v) => set('services', v)}
              max={6}
              titlePlaceholder="Ej.: Particulares"
              textPlaceholder="Ej.: Mudanzas, reformas, cosas de temporada…"
            />

            {usesAdvantages(template) && (
              <LabelsEditor
                label="Ventajas"
                hint={
                  template === 'onepagemovil'
                    ? 'Las 4 ventajas bajo la portada (con icono).'
                    : template === 'trstrom'
                      ? 'Las 4 ventajas con ✓ de la portada.'
                      : template === 'cabe'
                        ? 'Las 3 insignias de la portada.'
                        : 'Etiquetas cortas de «Por qué elegirnos» (con icono).'
                }
                items={form.advantages}
                onChange={(v) => set('advantages', v)}
                max={8}
                placeholder="Ej.: Sin permanencia"
              />
            )}

            {(template === 'escaparate' ||
              template === 'onepagemovil' ||
              template === 'trstrom' ||
              template === 'cabe') && (
              <ItemsEditor
                label="Pasos para contratar"
                hint="Los pasos de «Contratar es muy fácil» (título + descripción)."
                items={form.steps}
                onChange={(v) => set('steps', v)}
                max={4}
                titlePlaceholder="Ej.: Elige tu trastero"
                textPlaceholder="Ej.: Mira tamaños y precios y quédate con el que encaje."
              />
            )}
          </CardContent>
        </Card>
      )}

      {template !== 'external' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Textos</CardTitle>
            <CardDescription>Personaliza el mensaje principal y tu presentación.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="web-headline">Título / claim (opcional)</Label>
              <Input
                id="web-headline"
                value={form.headline}
                onChange={(e) => set('headline', e.target.value)}
                maxLength={160}
                placeholder="Ej.: Guarda tus cosas con total seguridad en el centro"
                className="text-base sm:text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Vacío = «Trasteros en {'{ciudad}'}» por defecto.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="web-about">Sobre tu empresa (opcional)</Label>
              <Textarea
                id="web-about"
                value={form.about}
                onChange={(e) => set('about', e.target.value)}
                rows={5}
                maxLength={2000}
                placeholder="Cuenta quién eres, tus ventajas, horarios, cómo llegar… Se muestra bajo el título."
              />
              <p className="text-xs text-muted-foreground">Vacío = no se muestra esta sección.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {template !== 'external' && (
        <WebSeoCard
          values={form.seo}
          onChange={(key, value) => set('seo', { ...form.seo, [key]: value })}
          tenantName={me.data?.tenant.name ?? ''}
          domain={domainVerified ? (branding.data?.customDomain ?? null) : null}
        />
      )}

      <UnsavedChangesBar
        dirty={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={() => saved && setForm(saved)}
        canSave={!externalBlocked}
        hint={
          externalBlocked
            ? 'Para usar una web externa necesitas un dominio propio verificado.'
            : undefined
        }
      />
    </div>
  );
}

/** Editor de una lista de items con título + descripción (servicios/pasos). */
function ItemsEditor({
  label,
  hint,
  items,
  onChange,
  max,
  titlePlaceholder,
  textPlaceholder,
}: {
  label: string;
  hint: string;
  items: Item[];
  onChange: (items: Item[]) => void;
  max: number;
  titlePlaceholder: string;
  textPlaceholder: string;
}) {
  function setAt(i: number, patch: Partial<Item>) {
    onChange(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function remove(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  return (
    <div className="space-y-2">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="space-y-3">
        {items.map((it, i) => (
          <div key={i} className="flex items-start gap-2 rounded-md border p-3">
            <div className="flex-1 space-y-2">
              <Input
                value={it.title}
                onChange={(e) => setAt(i, { title: e.target.value })}
                maxLength={80}
                placeholder={titlePlaceholder}
                className="text-base sm:text-sm"
              />
              <Textarea
                value={it.text}
                onChange={(e) => setAt(i, { text: e.target.value })}
                rows={2}
                maxLength={240}
                placeholder={textPlaceholder}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(i)}
              aria-label="Quitar"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {items.length < max && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...items, { title: '', text: '' }])}
        >
          <Plus className="mr-1 h-4 w-4" /> Añadir
        </Button>
      )}
    </div>
  );
}

/** Editor de una lista de etiquetas cortas (ventajas). */
function LabelsEditor({
  label,
  hint,
  items,
  onChange,
  max,
  placeholder,
}: {
  label: string;
  hint: string;
  items: string[];
  onChange: (items: string[]) => void;
  max: number;
  placeholder: string;
}) {
  return (
    <div className="space-y-2">
      <div>
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={it}
              onChange={(e) => onChange(items.map((v, idx) => (idx === i ? e.target.value : v)))}
              maxLength={48}
              placeholder={placeholder}
              className="text-base sm:text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
              aria-label="Quitar"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {items.length < max && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ''])}>
          <Plus className="mr-1 h-4 w-4" /> Añadir
        </Button>
      )}
    </div>
  );
}

function SectionToggle({
  checked,
  onToggle,
  label,
  hint,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Checkbox checked={checked} onCheckedChange={onToggle} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function eur(n: number): string {
  return n.toLocaleString('es-ES', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  });
}

/** «Cuánto te genera tu web»: leads → contrato → MRR (últimos 90 días). */
function WebPerformanceCard() {
  const perf = useWebPerformance();
  const d = perf.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="h-5 w-5 text-muted-foreground" /> Rendimiento de tu web
        </CardTitle>
        <CardDescription>
          Lo que ha generado tu web en los últimos 90 días (formulario de contacto + widget).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {perf.isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : perf.isError ? (
          <SectionError onRetry={() => void perf.refetch()} />
        ) : d && d.totalLeads > 0 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Contactos" value={String(d.totalLeads)} />
              <Metric label="Se hicieron clientes" value={String(d.totalWon)} />
              <Metric label="Conversión" value={`${Math.round(d.conversionRate * 100)}%`} />
              <Metric label="Ingresos/mes generados" value={eur(d.totalMrr)} highlight />
            </div>
            <div className="divide-y rounded-md border text-sm">
              {d.bySource
                .filter((s) => s.leads > 0)
                .map((s) => (
                  <div key={s.source} className="flex items-center justify-between px-3 py-2">
                    <span>{s.label}</span>
                    <span className="text-muted-foreground">
                      {s.leads} contacto{s.leads === 1 ? '' : 's'} · {s.won} cliente
                      {s.won === 1 ? '' : 's'} · {eur(s.mrr)}/mes
                    </span>
                  </div>
                ))}
            </div>
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">
            Aún no hay contactos desde tu web. Activa el formulario de contacto y comparte tu enlace
            para empezar a captar clientes.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className={`text-xl font-semibold ${highlight ? 'text-primary' : ''}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
