'use client';

import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useMessageTemplates } from '@/lib/communications/hooks';

export default function MessageTemplatesPage() {
  const templates = useMessageTemplates();

  if (templates.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 px-6 py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Plantillas de mensaje</h1>
        <p className="text-sm text-muted-foreground">
          Plantillas reutilizables para envíos automáticos y manuales. Las plantillas built-in no
          son editables.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(templates.data ?? []).map((t) => (
          <Card key={t.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span>{t.name}</span>
                <div className="flex gap-1">
                  <Badge variant={t.kind === 'system' ? 'destructive' : 'secondary'}>
                    {t.kind}
                  </Badge>
                  <Badge variant="outline">{t.channel}</Badge>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <code className="text-xs text-muted-foreground">{t.code}</code>
              {t.subject && <p className="font-medium">{t.subject}</p>}
              <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                {t.bodyText}
              </p>
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
    </div>
  );
}
