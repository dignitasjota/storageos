'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { LifecycleEmailTemplateDto } from '@storageos/shared';

import { EmailPreviewFrame } from '@/components/admin/comms/email-preview-frame';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useLifecycleTemplates, useSaveLifecycleTemplate } from '@/lib/admin/comms-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

/** Ejemplo para la vista previa (las variables propias de cada correo). */
const SAMPLE: Record<string, string> = {
  '{empresa}': 'Trasteros García',
  '{identificador}': 'trasteros-garcia',
  '{enlace_panel}': 'https://trasteros.pro/dashboard',
  '{enlace_web}': 'https://trasteros.pro/s/trasteros-garcia',
  '{enlace_pago}': 'https://trasteros.pro/settings/saas-billing',
  '{dias}': '3 días',
  '{limites}': '',
};

function sample(text: string): string {
  return Object.entries(SAMPLE).reduce((t, [k, v]) => t.split(k).join(v), text);
}

export default function AdminEmailTemplatesPage() {
  const templates = useLifecycleTemplates();
  const [selected, setSelected] = useState<string | null>(null);
  const list = templates.data ?? [];
  const current = list.find((t) => t.code === (selected ?? list[0]?.code));

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Correos automáticos</h1>
        <p className="text-sm text-muted-foreground">
          Los textos de los correos que la plataforma manda sola a los tenants. Sin cambios, sale el
          texto de serie.
        </p>
      </div>
      {templates.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
          <ul className="space-y-1">
            {list.map((t) => (
              <li key={t.code}>
                <button
                  type="button"
                  onClick={() => setSelected(t.code)}
                  className={`w-full rounded-md border px-3 py-2 text-left text-sm ${current?.code === t.code ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
                >
                  <span className="flex items-center gap-2 font-medium">
                    {t.label}
                    {t.custom && <Badge variant="secondary">Cambiado</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{t.description}</span>
                </button>
              </li>
            ))}
          </ul>
          {current && (
            <TemplateEditor
              key={`${current.code}-${current.updatedAt ?? 'default'}`}
              template={current}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TemplateEditor({ template }: { template: LifecycleEmailTemplateDto }) {
  const save = useSaveLifecycleTemplate();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const dirty = subject !== template.subject || body !== template.body;

  async function onSave() {
    try {
      await save.mutateAsync({ code: template.code, input: { subject, body } });
      toast.success('Texto guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function onReset() {
    if (!(await confirm({ title: '¿Volver al texto de serie?' }))) return;
    await save.mutateAsync({ code: template.code, input: null });
    toast.success('Vuelve a salir el texto de serie.');
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{template.label}</CardTitle>
          {template.updatedAt && (
            <p className="text-xs text-muted-foreground">
              Cambiado el {formatDateTime(template.updatedAt)}
            </p>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-subject">Asunto</Label>
            <Input
              id="tpl-subject"
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-body">Texto</Label>
            <Textarea
              id="tpl-body"
              rows={16}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Variables</p>
            <div className="flex flex-wrap gap-1">
              {template.variables.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  title={v.label}
                  onClick={() => setBody((b) => `${b}${v.key}`)}
                  className="rounded border px-2 py-0.5 font-mono text-xs hover:bg-muted"
                >
                  {v.key}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {template.custom && (
              <Button variant="outline" disabled={!canEdit} onClick={() => void onReset()}>
                <RotateCcw className="mr-1.5 size-4" /> Texto de serie
              </Button>
            )}
            <Button disabled={!dirty || !canEdit || save.isPending} onClick={() => void onSave()}>
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2">
        <Label>Vista previa</Label>
        <EmailPreviewFrame subject={sample(subject)} body={sample(body)} />
      </div>
    </div>
  );
}
