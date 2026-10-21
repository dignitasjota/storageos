'use client';

import {
  AREA_PAGE_CITY_MIN_WORDS,
  AREA_PAGE_MIN_WORDS,
  citySlug,
  wordCount,
  type AreaPageDto,
  type AreaPageFaq,
} from '@storageos/shared';
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
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
import { Textarea } from '@/components/ui/textarea';
import { useDraftAreaPage, useSaveAreaPage } from '@/lib/area-pages/hooks';
import { ApiError } from '@/lib/auth/api';
import { useFacilities } from '@/lib/facilities/hooks';

export type AreaPageTarget =
  | { kind: 'city'; name: string; slug: string; page: AreaPageDto | null }
  | { kind: 'nearby'; page: AreaPageDto | null };

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={value.length > max ? 'text-red-600' : 'text-muted-foreground'}>
      {value.length}/{max}
    </span>
  );
}

/** Texto propio de la página de una ciudad o una página de zona cercana. */
export function AreaPageDialog({
  target,
  onClose,
}: {
  target: AreaPageTarget | null;
  onClose: () => void;
}) {
  const save = useSaveAreaPage();
  const draft = useDraftAreaPage();
  const ask = useConfirm();
  const facilities = useFacilities();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [facilityIds, setFacilityIds] = useState<string[]>([]);
  const [nearestNote, setNearestNote] = useState('');
  const [intro, setIntro] = useState('');
  const [areas, setAreas] = useState('');
  const [faqs, setFaqs] = useState<AreaPageFaq[]>([]);
  const [seoTitle, setSeoTitle] = useState('');
  const [seoDescription, setSeoDescription] = useState('');
  const [published, setPublished] = useState(true);

  useEffect(() => {
    if (!target) return;
    const p = target.page;
    setName(p?.name ?? (target.kind === 'city' ? target.name : ''));
    setSlug(p?.slug ?? (target.kind === 'city' ? target.slug : ''));
    setFacilityIds(p?.facilityIds ?? []);
    setNearestNote(p?.nearestNote ?? '');
    setIntro(p?.intro ?? '');
    setAreas((p?.nearbyAreas ?? []).join(', '));
    setFaqs(p?.faqs ?? []);
    setSeoTitle(p?.seoTitle ?? '');
    setSeoDescription(p?.seoDescription ?? '');
    setPublished(p?.isPublished ?? true);
  }, [target]);

  if (!target) return null;
  const city = target.kind === 'city';
  const words = wordCount(intro);
  const minWords = city ? AREA_PAGE_CITY_MIN_WORDS : AREA_PAGE_MIN_WORDS;
  const autoSlug = citySlug(name);

  async function writeWithAi() {
    const hasText = intro.trim() || faqs.length > 0 || seoTitle.trim() || seoDescription.trim();
    if (
      hasText &&
      !(await ask({
        title: '¿Sustituir el texto?',
        description:
          'El borrador reemplaza el texto, las zonas cercanas, las preguntas y los textos para Google que tienes ahora. No se guarda hasta que pulses «Guardar».',
        confirmLabel: 'Redactar',
      }))
    ) {
      return;
    }
    try {
      const d = await draft.mutateAsync({
        name: name.trim(),
        facilityIds: city ? [] : facilityIds,
      });
      setIntro(d.intro);
      if (!city && d.nearestNote) setNearestNote(d.nearestNote);
      setAreas(d.nearbyAreas.join(', '));
      setFaqs(d.faqs);
      setSeoTitle(d.seoTitle ?? '');
      setSeoDescription(d.seoDescription ?? '');
      toast.success('Borrador listo. Revísalo antes de guardar.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo redactar el texto');
    }
  }

  async function submit() {
    if (!target) return;
    const input = {
      name: name.trim(),
      ...(city ? { slug: target.kind === 'city' ? target.slug : undefined } : {}),
      ...(!city && (slug.trim() || autoSlug) ? { slug: slug.trim() || autoSlug } : {}),
      facilityIds: city ? [] : facilityIds,
      nearestNote: city ? null : nearestNote.trim() || null,
      intro: intro.trim() || null,
      nearbyAreas: areas
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length >= 2),
      faqs: faqs.filter((f) => f.question.trim() && f.answer.trim()),
      seoTitle: seoTitle.trim() || null,
      seoDescription: seoDescription.trim() || null,
      isPublished: published,
    };
    try {
      await save.mutateAsync(target.page ? { id: target.page.id, input } : { input });
      toast.success('Página guardada');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {city ? `Trasteros en ${name}` : target.page ? `Zona: ${name}` : 'Nueva zona cercana'}
          </DialogTitle>
          <DialogDescription>
            {city
              ? 'Texto propio de la página de esta ciudad. Es lo que la diferencia de las demás: escribe lo que diría alguien del negocio.'
              : 'Una página para un pueblo cercano sin local. Di la verdad: cuál es tu local más cercano y a qué distancia.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!city && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ap-name">Pueblo o zona</Label>
                <Input
                  id="ap-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Paterna"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ap-slug">Dirección</Label>
                <Input
                  id="ap-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder={autoSlug || 'paterna'}
                />
                <p className="text-xs text-muted-foreground">
                  /trasteros-en-{slug.trim() || autoSlug || '…'}
                </p>
              </div>
            </div>
          )}

          {!city && (
            <div className="space-y-1.5">
              <Label>Locales que se muestran</Label>
              <div className="flex flex-wrap gap-3">
                {(facilities.data ?? []).map((f) => (
                  <label key={f.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={facilityIds.includes(f.id)}
                      onCheckedChange={(v) =>
                        setFacilityIds((ids) =>
                          v ? [...ids, f.id] : ids.filter((id) => id !== f.id),
                        )
                      }
                    />
                    {f.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {!city && (
            <div className="space-y-1.5">
              <Label htmlFor="ap-near">Local más cercano</Label>
              <Input
                id="ap-near"
                value={nearestNote}
                onChange={(e) => setNearestNote(e.target.value)}
                placeholder="Nuestro local más cercano está en Mislata, a 8 km (10 minutos en coche)."
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
            <p className="text-sm text-muted-foreground">
              Redactamos el texto, las zonas cercanas, las preguntas y los textos para Google con
              los datos de {city ? 'tu local' : 'los locales elegidos'}. Revisa nombres y distancias
              antes de guardar.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={writeWithAi}
              disabled={
                draft.isPending || name.trim().length < 2 || (!city && facilityIds.length === 0)
              }
            >
              {draft.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-4 w-4" />
              )}
              Redactar con IA
            </Button>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="ap-intro">Texto de la página</Label>
              <span
                className={`text-xs ${words >= minWords ? 'text-emerald-600' : 'text-amber-600'}`}
              >
                {words} palabras {words < minWords ? `(recomendado ${minWords} o más)` : ''}
              </span>
            </div>
            <Textarea
              id="ap-intro"
              rows={7}
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              placeholder={
                city
                  ? 'Dónde estáis, cómo se llega (metro, autobús, aparcamiento), a quién dais servicio, qué os diferencia…'
                  : 'Cómo se llega desde este pueblo, cuánto se tarda, por qué te compensa…'
              }
            />
            {!city && words < AREA_PAGE_MIN_WORDS && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Hasta llegar a {AREA_PAGE_MIN_WORDS} palabras la página se ve, pero no se ofrece a
                Google: una página que solo cambia el nombre del pueblo perjudica a toda la web.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Separa los párrafos con una línea en blanco.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ap-areas">Zonas cercanas a las que das servicio</Label>
            <Input
              id="ap-areas"
              value={areas}
              onChange={(e) => setAreas(e.target.value)}
              placeholder="Xirivella, Quart de Poblet, Paiporta"
            />
            <p className="text-xs text-muted-foreground">Separadas por comas (hasta 15).</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Preguntas de esta zona</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={faqs.length >= 8}
                onClick={() => setFaqs((f) => [...f, { question: '', answer: '' }])}
              >
                <Plus className="mr-1 h-4 w-4" />
                Añadir
              </Button>
            </div>
            {faqs.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Por ejemplo: «¿Se puede entrar con furgoneta?», «¿Hay aparcamiento?», «¿Abrís los
                domingos?». Las generales (precio, reserva online) se añaden solas.
              </p>
            )}
            {faqs.map((f, i) => (
              <div key={i} className="space-y-2 rounded-md border p-3">
                <div className="flex gap-2">
                  <Input
                    value={f.question}
                    placeholder="Pregunta"
                    onChange={(e) =>
                      setFaqs((all) =>
                        all.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Quitar pregunta"
                    onClick={() => setFaqs((all) => all.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <Textarea
                  rows={2}
                  value={f.answer}
                  placeholder="Respuesta"
                  onChange={(e) =>
                    setFaqs((all) =>
                      all.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)),
                    )
                  }
                />
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <Label htmlFor="ap-title">Título para Google</Label>
              <Counter value={seoTitle} max={70} />
            </div>
            <Input
              id="ap-title"
              value={seoTitle}
              onChange={(e) => setSeoTitle(e.target.value)}
              placeholder={`Trasteros ${city ? 'en' : 'cerca de'} ${name || '…'} desde 39 €/mes`}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm">
              <Label htmlFor="ap-desc">Descripción para Google</Label>
              <Counter value={seoDescription} max={200} />
            </div>
            <Textarea
              id="ap-desc"
              rows={2}
              value={seoDescription}
              onChange={(e) => setSeoDescription(e.target.value)}
              placeholder="Vacío = se genera con tus precios y locales."
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={published} onCheckedChange={(v) => setPublished(v === true)} />
            {city ? 'Mostrar este texto en la web' : 'Publicar esta página'}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={submit}
            disabled={
              save.isPending ||
              name.trim().length < 2 ||
              (!city && facilityIds.length === 0) ||
              seoTitle.length > 70 ||
              seoDescription.length > 200
            }
          >
            {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
