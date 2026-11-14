'use client';

import {
  RENT_INCREASE_NOTICE_VARIABLES,
  type RentIncreaseNoticeTemplate,
  type RentIncreaseNoticePreviewDto,
} from '@storageos/shared';
import { Eye } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { NoticePreview } from './notice-preview';

import { useConfirm } from '@/components/confirm-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  usePreviewRentIncreaseNotice,
  useRentIncreaseNoticeTemplate,
  useUpdateRentIncreaseNoticeTemplate,
} from '@/lib/rent-increases/hooks';

type Locale = 'es' | 'en';
type Texts = Record<Locale, { subject: string; body: string }>;

/**
 * Texto del correo con el que se avisa de una subida. Admite variables; la
 * frase de que puede darse de baja antes sin preaviso se añade siempre.
 */
export function NoticeTemplateCard() {
  const ask = useConfirm();
  const { data } = useRentIncreaseNoticeTemplate();
  const update = useUpdateRentIncreaseNoticeTemplate();
  const previewNotice = usePreviewRentIncreaseNotice();
  const [open, setOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>('es');
  const [texts, setTexts] = useState<Texts | null>(null);
  const [preview, setPreview] = useState<RentIncreaseNoticePreviewDto | null>(null);

  useEffect(() => {
    if (!data) return;
    setTexts({
      es: data.template?.es ?? data.defaults.es,
      en: data.template?.en ?? data.defaults.en,
    });
  }, [data]);

  if (!data || !texts) return null;
  const custom = !!data.template;
  const current = texts[locale];

  function set(field: 'subject' | 'body', value: string) {
    setTexts((t) => (t ? { ...t, [locale]: { ...t[locale], [field]: value } } : t));
    setPreview(null);
  }

  function buildTemplate(): RentIncreaseNoticeTemplate {
    const en =
      texts!.en.subject !== data!.defaults.en.subject || texts!.en.body !== data!.defaults.en.body
        ? texts!.en
        : undefined;
    return { es: texts!.es, ...(en ? { en } : {}) };
  }

  async function showPreview() {
    try {
      setPreview(await previewNotice.mutateAsync({ locale, template: buildTemplate() }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo preparar el aviso.');
    }
  }

  async function save() {
    try {
      await update.mutateAsync(buildTemplate());
      toast.success('Texto del aviso guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function restore() {
    if (
      !(await ask({
        title: '¿Volver al texto de serie?',
        description: 'Los próximos avisos saldrán con el texto que trae TrasterOS.',
        confirmLabel: 'Volver al de serie',
      }))
    )
      return;
    try {
      await update.mutateAsync(null);
      setPreview(null);
      toast.success('Se usará el texto de serie.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Texto del aviso</CardTitle>
            <p className="text-xs text-muted-foreground">
              {custom ? 'Con vuestro texto.' : 'Con el texto de serie.'} Los importes salen con IVA
              y en el idioma de cada inquilino.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Ocultar' : 'Editar'}
          </Button>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-3">
          <Tabs value={locale} onValueChange={(v) => setLocale(v as Locale)}>
            <TabsList>
              <TabsTrigger value="es">Español</TabsTrigger>
              <TabsTrigger value="en">Inglés</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="space-y-1">
            <Label htmlFor="notice-subject">Asunto</Label>
            <Input
              id="notice-subject"
              value={current.subject}
              onChange={(e) => set('subject', e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="notice-body">Texto</Label>
            <Textarea
              id="notice-body"
              rows={7}
              value={current.body}
              onChange={(e) => set('body', e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Variables:{' '}
              {RENT_INCREASE_NOTICE_VARIABLES.map((v) => (
                <code key={v} className="mr-1 rounded bg-muted px-1">
                  {`{${v}}`}
                </code>
              ))}
              . Deja una línea en blanco entre párrafos. Al final se añade siempre que puede darse
              de baja antes de la fecha sin preaviso ni penalización.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} disabled={update.isPending}>
              Guardar
            </Button>
            <Button
              variant="outline"
              onClick={() => void showPreview()}
              disabled={previewNotice.isPending}
            >
              <Eye className="mr-1 h-4 w-4" /> Vista previa
            </Button>
            {custom && (
              <Button variant="ghost" onClick={() => void restore()} disabled={update.isPending}>
                Volver al de serie
              </Button>
            )}
          </div>
          {(preview || previewNotice.isPending) && (
            <NoticePreview preview={preview} loading={previewNotice.isPending} />
          )}
        </CardContent>
      )}
    </Card>
  );
}
