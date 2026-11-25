'use client';

import {
  SEO_KEYWORD_IMPORT_ACTION_LABELS,
  SEO_KEYWORD_IMPORT_CHANGE_LABELS,
  type SeoKeywordImportAction,
  type SeoKeywordImportPreviewDto,
  type SeoKeywordImportRequest,
} from '@storageos/shared';
import { FileUp, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { formatCount } from '@/lib/format';
import { readImportFile } from '@/lib/import-file';
import {
  type DiagnosticScope,
  useKeywordImportCommit,
  useKeywordImportPreview,
} from '@/lib/seo-advanced/diagnostic-hooks';
import { cn } from '@/lib/utils';

const ACTIONS: SeoKeywordImportAction[] = ['create', 'update', 'unchanged', 'locked', 'error'];
const TONE: Record<SeoKeywordImportAction, string> = {
  create: 'text-emerald-700 dark:text-emerald-400',
  update: 'text-sky-700 dark:text-sky-400',
  unchanged: 'text-muted-foreground',
  locked: 'text-muted-foreground',
  error: 'text-red-700 dark:text-red-400',
};

/**
 * Importar palabras desde un CSV o un Excel: columnas palabra, grupo,
 * intención, URL objetivo, prioridad y notas. Vista previa antes de
 * confirmar; nunca pisa lo decidido: las palabras fijadas no se tocan y en
 * las demás solo se rellena lo vacío.
 */
export function KeywordImportDialog({
  scope,
  open,
  onOpenChange,
}: {
  scope: DiagnosticScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useKeywordImportPreview(scope);
  const commit = useKeywordImportCommit(scope);
  const [file, setFile] = useState<SeoKeywordImportRequest | null>(null);
  const [name, setName] = useState('');
  const [plan, setPlan] = useState<SeoKeywordImportPreviewDto | null>(null);

  const reset = () => {
    setFile(null);
    setName('');
    setPlan(null);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const input = await readImportFile(f);
      setFile(input);
      setName(f.name);
      setPlan(await preview.mutateAsync(input));
    } catch (err) {
      setPlan(null);
      toast.error(seoErrorMessage(err));
    }
  };

  const confirm = async () => {
    if (!file) return;
    try {
      const res = await commit.mutateAsync(file);
      toast.success(`${formatCount(res.created)} nuevas y ${formatCount(res.updated)} completadas`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const useful = plan ? plan.counts.create + plan.counts.update : 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar palabras</DialogTitle>
          <DialogDescription>
            Un CSV o un Excel con las columnas «palabra», «grupo», «intención», «URL objetivo»,
            «prioridad» y «notas» (solo la primera es obligatoria). Las palabras con la decisión
            fijada no se tocan y en las demás solo se rellena lo que está vacío.
          </DialogDescription>
        </DialogHeader>

        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-sm hover:bg-muted/40">
          <FileUp className="size-6 text-muted-foreground" aria-hidden />
          <span>{name || 'Elige un fichero .csv o .xlsx'}</span>
          <Input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv"
            className="sr-only"
            onChange={(e) => void pick(e.target.files?.[0])}
          />
        </label>

        {preview.isPending && (
          <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
        )}

        {plan && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-xs">
              {ACTIONS.map((a) => (
                <Badge key={a} variant="outline" className={cn('font-normal', TONE[a])}>
                  {SEO_KEYWORD_IMPORT_ACTION_LABELS[a]}: {formatCount(plan.counts[a])}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Columnas:{' '}
              {plan.columns.map((c) => `${c.name}${c.field ? '' : ' (no se usa)'}`).join(', ')}
            </p>
            {plan.overLimit && (
              <p className="rounded-md border border-red-300 p-2 text-sm text-red-800 dark:border-red-700 dark:text-red-300">
                No caben: llevas {formatCount(plan.current)} palabras, el límite es{' '}
                {formatCount(plan.limit)} y el fichero trae {formatCount(plan.counts.create)}{' '}
                nuevas.
              </p>
            )}
            <ul className="max-h-[40vh] divide-y overflow-y-auto rounded-md border text-sm">
              {plan.items.map((i) => (
                <li key={`${i.line}-${i.keyword}`} className="flex gap-3 p-2">
                  <span className="w-10 shrink-0 tabular-nums text-xs text-muted-foreground">
                    {i.line}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="break-words font-medium">{i.keyword || '—'}</span>{' '}
                    <span className={cn('text-xs', TONE[i.action])}>
                      {SEO_KEYWORD_IMPORT_ACTION_LABELS[i.action]}
                    </span>
                    {i.changes.length > 0 && (
                      <span className="block text-xs text-muted-foreground">
                        Rellena:{' '}
                        {i.changes.map((c) => SEO_KEYWORD_IMPORT_CHANGE_LABELS[c]).join(', ')}
                      </span>
                    )}
                    {i.error && (
                      <span className="block text-xs text-red-700 dark:text-red-400">
                        {i.error}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={!plan || plan.overLimit || useful === 0 || commit.isPending}
          >
            {commit.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Importar {useful > 0 ? formatCount(useful) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
