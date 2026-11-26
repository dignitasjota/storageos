'use client';

import {
  SEO_DIAGNOSTIC_STATUSES,
  SEO_DIAGNOSTIC_STATUS_LABELS,
  SEO_SEVERITY_LABELS,
  type SeoCrawlIssueDto,
  type SeoDiagnosticStatus,
  type SeoSeverity,
} from '@storageos/shared';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime } from '@/lib/format';
import { type TechnicalScope, useUpdateCrawlIssue } from '@/lib/seo-advanced/technical-hooks';
import { cn } from '@/lib/utils';

export const SEVERITY_TONE: Record<SeoSeverity, string> = {
  high: 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-300',
  medium: 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300',
  low: 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-300',
};

export function SeverityBadge({ severity }: { severity: SeoSeverity }) {
  return (
    <Badge variant="outline" className={cn('font-normal', SEVERITY_TONE[severity])}>
      {SEO_SEVERITY_LABELS[severity]}
    </Badge>
  );
}

/** Una incidencia del rastreo: qué pasa, qué hacer, estado y notas. */
export function IssueRow({
  i,
  scope,
  canEdit,
  onOpenUrl,
}: {
  i: SeoCrawlIssueDto;
  scope: TechnicalScope;
  canEdit: boolean;
  onOpenUrl?: (url: string) => void;
}) {
  const update = useUpdateCrawlIssue(scope);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(i.notes ?? '');
  const save = async (status?: SeoDiagnosticStatus) => {
    try {
      await update.mutateAsync({
        id: i.id,
        input: status ? { status } : { notes: notes.trim() || null },
      });
      toast.success('Guardado');
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  return (
    <li className="space-y-1.5 p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={i.severity} />
        <span className="text-sm font-medium">{i.label}</span>
        {i.isNew && (
          <Badge
            variant="outline"
            className="border-sky-300 font-normal text-sky-800 dark:border-sky-800 dark:text-sky-300"
          >
            Nueva
          </Badge>
        )}
        {i.returnedAt && i.active && (
          <Badge variant="outline" className="font-normal">
            Ha vuelto
          </Badge>
        )}
        {!i.active && (
          <Badge variant="outline" className="font-normal text-emerald-700 dark:text-emerald-300">
            Ya no sale
          </Badge>
        )}
      </div>
      {onOpenUrl ? (
        <button
          type="button"
          onClick={() => onOpenUrl(i.url)}
          className="block max-w-full break-all text-left text-sm hover:underline focus-visible:underline focus-visible:outline-none"
        >
          {i.url}
        </button>
      ) : (
        <p className="break-all text-sm">{i.url}</p>
      )}
      <p className="text-sm text-muted-foreground">{i.detail}</p>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-primary hover:underline"
      >
        {open ? 'Ocultar' : 'Qué pasa y qué hacer'}
      </button>
      {open && (
        <div className="space-y-2 rounded-md bg-muted/50 p-2 text-sm">
          <p>
            <span className="font-medium">Qué pasa:</span> {i.what}
          </p>
          <p>
            <span className="font-medium">Qué hacer:</span> {i.how}
          </p>
          {canEdit && (
            <div className="space-y-1.5">
              <Label htmlFor={`notes-${i.id}`} className="text-xs">
                Notas
              </Label>
              <Textarea
                id={`notes-${i.id}`}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save()}
                disabled={update.isPending}
              >
                Guardar notas
              </Button>
            </div>
          )}
          {!canEdit && i.notes && <p className="text-xs text-muted-foreground">Notas: {i.notes}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Select value={i.status} onValueChange={(v) => void save(v as SeoDiagnosticStatus)}>
            <SelectTrigger className="h-8 w-[160px]" aria-label="Estado de la incidencia">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEO_DIAGNOSTIC_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {SEO_DIAGNOSTIC_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="outline" className="font-normal">
            {SEO_DIAGNOSTIC_STATUS_LABELS[i.status]}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Vista desde {formatDateTime(i.firstSeenAt)}
          {i.resolvedAt && !i.active && ` · resuelta ${formatDateTime(i.resolvedAt)}`}
        </span>
      </div>
    </li>
  );
}
