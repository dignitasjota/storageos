'use client';

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { TemplateFormDialog } from './template-form-dialog';

import type { MessageTemplateDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/auth/api';
import { useDeleteMessageTemplate, useMessageTemplates } from '@/lib/communications/hooks';

export default function MessageTemplatesPage() {
  const templates = useMessageTemplates();
  const remove = useDeleteMessageTemplate();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<MessageTemplateDto | null>(null);

  async function handleDelete(t: MessageTemplateDto) {
    if (!confirm(`¿Borrar la plantilla "${t.name}"?`)) return;
    try {
      await remove.mutateAsync(t.id);
      toast.success('Plantilla borrada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  if (templates.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Plantillas de mensaje</h1>
          <p className="text-sm text-muted-foreground">
            Plantillas reutilizables para envíos automáticos y manuales. Las plantillas built-in no
            son editables.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 h-4 w-4" /> Nueva plantilla
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(templates.data ?? []).map((t) => (
          <Card key={t.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between gap-2 text-base">
                <span className="truncate">{t.name}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <Badge variant={t.kind === 'system' ? 'destructive' : 'secondary'}>
                    {t.kind}
                  </Badge>
                  <Badge variant="outline">{t.channel}</Badge>
                  {t.kind !== 'system' && (
                    <>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => setEditing(t)}
                        aria-label="Editar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive"
                        onClick={() => handleDelete(t)}
                        aria-label="Borrar"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <code className="text-xs text-muted-foreground">{t.code}</code>
              {t.subject && <p className="font-medium">{t.subject}</p>}
              <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                {t.bodyText}
              </p>
              {t.channel === 'whatsapp' && t.whatsappTemplateName && (
                <p className="text-xs">
                  <span className="text-muted-foreground">Plantilla WABA: </span>
                  <code>{t.whatsappTemplateName}</code>
                  {t.whatsappTemplateLanguage ? ` (${t.whatsappTemplateLanguage})` : ''}
                </p>
              )}
              {t.variables.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {t.variables.map((v) => (
                    <Badge key={v} variant="outline" className="font-mono text-[10px]">
                      {`{{${v}}}`}
                    </Badge>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
        {(templates.data ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground">No hay plantillas todavía.</p>
        )}
      </div>

      <TemplateFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editing && (
        <TemplateFormDialog
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          template={editing}
        />
      )}
    </div>
  );
}
