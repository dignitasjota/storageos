'use client';

import { WEB_TEMPLATES, type WebSections, type WebTemplateValue } from '@storageos/shared';
import { ExternalLink, Globe, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useMe } from '@/lib/auth/hooks';
import { useUpdateWebSettings, useWebSettings } from '@/lib/web-settings/hooks';

const DEFAULT_SECTIONS: WebSections = { testimonials: false, faq: false, contact: false };

export default function WebSettingsPage() {
  const settings = useWebSettings();
  const update = useUpdateWebSettings();
  const me = useMe();
  const slug = me.data?.tenant.slug;

  const [template, setTemplate] = useState<WebTemplateValue>('default');
  const [headline, setHeadline] = useState('');
  const [about, setAbout] = useState('');
  const [sections, setSections] = useState<WebSections>(DEFAULT_SECTIONS);

  useEffect(() => {
    if (!settings.data) return;
    setTemplate(settings.data.template);
    setHeadline(settings.data.headline ?? '');
    setAbout(settings.data.about ?? '');
    setSections(settings.data.sections ?? DEFAULT_SECTIONS);
  }, [settings.data]);

  async function save() {
    try {
      await update.mutateAsync({ template, headline, about, sections });
      toast.success('Web actualizada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  function toggle(key: keyof WebSections) {
    setSections((s) => ({ ...s, [key]: !s[key] }));
  }

  if (settings.isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

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
                  onClick={() => setTemplate(tpl.value)}
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Secciones</CardTitle>
          <CardDescription>Elige qué mostrar en tu web pública.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SectionToggle
            checked={sections.testimonials}
            onToggle={() => toggle('testimonials')}
            label="Testimonios"
            hint="Muestra reseñas positivas de tus clientes (valoraciones NPS ≥ 9 con comentario)."
          />
          <SectionToggle
            checked={sections.faq}
            onToggle={() => toggle('faq')}
            label="Preguntas frecuentes"
            hint="Muestra las FAQ publicadas en tu centro de ayuda."
          />
          <SectionToggle
            checked={sections.contact}
            onToggle={() => toggle('contact')}
            label="Formulario de contacto"
            hint="Un formulario en tu web; cada envío entra como lead en tu panel."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Textos</CardTitle>
          <CardDescription>Personaliza el mensaje principal y tu presentación.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Título / claim (opcional)</Label>
            <Input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              maxLength={160}
              placeholder="Ej.: Guarda tus cosas con total seguridad en el centro"
              className="text-base sm:text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Vacío = «Trasteros en {'{ciudad}'}» por defecto.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Sobre tu empresa (opcional)</Label>
            <Textarea
              value={about}
              onChange={(e) => setAbout(e.target.value)}
              rows={5}
              maxLength={2000}
              placeholder="Cuenta quién eres, tus ventajas, horarios, cómo llegar… Se muestra bajo el título."
            />
            <p className="text-xs text-muted-foreground">Vacío = no se muestra esta sección.</p>
          </div>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar cambios
          </Button>
        </CardContent>
      </Card>
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
