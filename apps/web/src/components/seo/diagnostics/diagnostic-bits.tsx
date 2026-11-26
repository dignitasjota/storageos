'use client';

import {
  SEO_DIAGNOSTIC_STATUS_LABELS,
  SEO_SEVERITY_LABELS,
  SEO_TARGET_STATUS_HELP,
  SEO_TARGET_STATUS_LABELS,
  type SeoDiagnosticStatus,
  type SeoSeverity,
  type SeoTargetStatus,
} from '@storageos/shared';
import { Check, Eye, ThumbsUp, Undo2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const SEVERITY_TONE: Record<SeoSeverity, string> = {
  high: 'border-red-300 text-red-800 dark:border-red-700 dark:text-red-300',
  medium: 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300',
  low: 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-300',
};

export function SeverityBadge({ severity }: { severity: SeoSeverity }) {
  return (
    <Badge variant="outline" className={cn('font-normal', SEVERITY_TONE[severity])}>
      Gravedad {SEO_SEVERITY_LABELS[severity].toLowerCase()}
    </Badge>
  );
}

export function DiagnosticStatusBadge({
  status,
  returned,
}: {
  status: SeoDiagnosticStatus;
  returned?: boolean;
}) {
  return (
    <>
      <Badge variant={status === 'new' ? 'default' : 'secondary'} className="font-normal">
        {SEO_DIAGNOSTIC_STATUS_LABELS[status]}
      </Badge>
      {returned && status === 'new' && (
        <Badge
          variant="outline"
          className="border-amber-300 font-normal text-amber-800 dark:border-amber-700 dark:text-amber-300"
        >
          Ha vuelto
        </Badge>
      )}
    </>
  );
}

const TARGET_TONE: Record<SeoTargetStatus, string> = {
  ok: 'border-emerald-300 text-emerald-800 dark:border-emerald-700 dark:text-emerald-300',
  other_page: 'border-red-300 text-red-800 dark:border-red-700 dark:text-red-300',
  split: 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300',
  none: 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-300',
  no_target: 'border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-300',
};

export function TargetStatusBadge({ status }: { status: SeoTargetStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn('font-normal', TARGET_TONE[status])}
      title={SEO_TARGET_STATUS_HELP[status]}
    >
      {SEO_TARGET_STATUS_LABELS[status]}
    </Badge>
  );
}

/** Ruta de una URL para enseñarla corta (el dominio ya se ve en la cabecera). */
export function shortUrl(url: string | null): string {
  if (!url) return '—';
  return url.replace(/^https?:\/\/(www\.)?[^/]+/i, '') || '/';
}

/** Estado y notas de un hallazgo (canibalización o indexación). */
export function DiagnosticManage({
  status,
  notes,
  canEdit,
  busy,
  okLabel = SEO_DIAGNOSTIC_STATUS_LABELS.ok,
  onSave,
}: {
  status: SeoDiagnosticStatus;
  notes: string | null;
  canEdit: boolean;
  busy: boolean;
  okLabel?: string;
  onSave: (input: { status?: SeoDiagnosticStatus; notes?: string | null }) => void;
}) {
  const fieldId = useId();
  const [text, setText] = useState(notes ?? '');
  useEffect(() => setText(notes ?? ''), [notes]);
  if (!canEdit) {
    return notes ? (
      <p className="whitespace-pre-wrap text-sm">
        <span className="text-muted-foreground">Notas: </span>
        {notes}
      </p>
    ) : null;
  }
  const action = (to: SeoDiagnosticStatus, label: string, Icon: typeof Check) =>
    status !== to && (
      <Button
        size="sm"
        variant="outline"
        className="h-8"
        disabled={busy}
        onClick={() => onSave({ status: to })}
      >
        <Icon className="mr-1 size-3.5" aria-hidden /> {label}
      </Button>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {action('reviewed', 'Revisada', Eye)}
        {action('fixed', 'Arreglada', Check)}
        {action('ok', okLabel, ThumbsUp)}
        {status !== 'new' && status !== 'reviewed' && action('new', 'Volver a pendiente', Undo2)}
      </div>
      <div className="space-y-1">
        <Label htmlFor={fieldId}>Notas</Label>
        <Textarea
          id={fieldId}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          placeholder="Qué se ha hecho o por qué está bien así"
        />
        {text !== (notes ?? '') && (
          <Button size="sm" disabled={busy} onClick={() => onSave({ notes: text.trim() || null })}>
            Guardar notas
          </Button>
        )}
      </div>
    </div>
  );
}
