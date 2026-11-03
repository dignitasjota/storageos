'use client';

import { type PlatformHomeTextsInput } from '@storageos/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAdminPlatformWebsite, useUpdatePlatformHome } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';

type Faq = { q: string; a: string };

/** Titular, subtítulo, nota y preguntas frecuentes de la portada de trasteros.pro. */
export function HomeTextsCard() {
  const canEdit = useIsSuperadmin();
  const website = useAdminPlatformWebsite();
  const update = useUpdatePlatformHome();
  const [form, setForm] = useState<{
    heroTitle: string;
    heroSubtitle: string;
    heroNote: string;
    faq: Faq[];
    customFaq: boolean;
  } | null>(null);

  useEffect(() => {
    const h = website.data?.home;
    if (!h || form) return;
    setForm({
      heroTitle: h.heroTitle ?? '',
      heroSubtitle: h.heroSubtitle ?? '',
      heroNote: h.heroNote ?? '',
      faq: h.faq ?? [],
      customFaq: !!h.faq?.length,
    });
  }, [website.data, form]);

  if (!form) return null;

  async function save() {
    if (!form) return;
    const faq = form.faq.filter((f) => f.q.trim() && f.a.trim());
    const input: PlatformHomeTextsInput = {
      heroTitle: form.heroTitle.trim() || null,
      heroSubtitle: form.heroSubtitle.trim() || null,
      heroNote: form.heroNote.trim() || null,
      faq: form.customFaq && faq.length ? faq : null,
    };
    try {
      await update.mutateAsync(input);
      toast.success('Guardado. La portada lo mostrará en un minuto como mucho.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  const setFaq = (i: number, patch: Partial<Faq>) =>
    setForm((f) =>
      f ? { ...f, faq: f.faq.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : f,
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Textos de la portada</CardTitle>
        <CardDescription>
          Lo primero que se lee en trasteros.pro. Vacío = el texto de serie.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="home-title">Titular</Label>
          <Input
            id="home-title"
            value={form.heroTitle}
            maxLength={120}
            onChange={(e) => setForm({ ...form, heroTitle: e.target.value })}
            placeholder="El de serie"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="home-subtitle">Subtítulo</Label>
          <Textarea
            id="home-subtitle"
            rows={2}
            value={form.heroSubtitle}
            maxLength={400}
            onChange={(e) => setForm({ ...form, heroSubtitle: e.target.value })}
            placeholder="El de serie"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="home-note">Nota bajo los botones</Label>
          <Input
            id="home-note"
            value={form.heroNote}
            maxLength={160}
            onChange={(e) => setForm({ ...form, heroNote: e.target.value })}
            placeholder="30 días de prueba, sin tarjeta"
          />
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.customFaq}
              onChange={(e) =>
                setForm({
                  ...form,
                  customFaq: e.target.checked,
                  faq: e.target.checked && form.faq.length === 0 ? [{ q: '', a: '' }] : form.faq,
                })
              }
            />
            Preguntas frecuentes propias (si no, las de serie)
          </label>
          {form.customFaq && (
            <div className="space-y-3">
              {form.faq.map((f, i) => (
                <div key={i} className="space-y-1.5 rounded-lg border p-3">
                  <div className="flex items-center gap-2">
                    <Input
                      value={f.q}
                      maxLength={200}
                      onChange={(e) => setFaq(i, { q: e.target.value })}
                      placeholder="Pregunta"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Quitar la pregunta"
                      onClick={() => setForm({ ...form, faq: form.faq.filter((_, j) => j !== i) })}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                  <Textarea
                    rows={2}
                    value={f.a}
                    maxLength={1500}
                    onChange={(e) => setFaq(i, { a: e.target.value })}
                    placeholder="Respuesta"
                  />
                </div>
              ))}
              {form.faq.length < 20 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setForm({ ...form, faq: [...form.faq, { q: '', a: '' }] })}
                >
                  <Plus className="mr-1 size-4" />
                  Añadir pregunta
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                También salen en los datos estructurados para Google (FAQPage).
              </p>
            </div>
          )}
        </div>
        <Button onClick={() => void save()} disabled={update.isPending || !canEdit}>
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
