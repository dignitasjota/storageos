'use client';

import {
  SEO_KEYWORD_PRIORITY_LABELS,
  SEO_MASTER_MAX_BYTES,
  SEO_MASTER_SHEET_LABELS,
  SEO_MASTER_SHEET_NAMES,
  seoMasterOriginLabel,
  type SeoMasterImportDto,
  type SeoMasterIssueDto,
  type SeoMasterPreviewDto,
  type SeoMasterSheetResultDto,
} from '@storageos/shared';
import { Eye, FileSpreadsheet, Loader2, Trash2, TriangleAlert, Upload } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from './seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCount, formatDate, formatDateTime } from '@/lib/format';
import {
  useKeywordGroups,
  useMasterImportDetail,
  useMasterImportMutations,
  useMasterImports,
  useMasterPreview,
} from '@/lib/seo-advanced/master-hooks';
import { type SistrixScope } from '@/lib/seo-advanced/sistrix-hooks';

/** Una línea por hoja: «Palabras del catálogo: 185 nuevas, 2 rellenadas». */
function sheetLine(s: SeoMasterSheetResultDto): string | null {
  const parts = [
    s.created ? `${formatCount(s.created)} nuevas` : '',
    s.updated ? `${formatCount(s.updated)} rellenadas` : '',
    s.unchanged ? `${formatCount(s.unchanged)} ya estaban` : '',
    s.skipped ? `${formatCount(s.skipped)} omitidas` : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `${SEO_MASTER_SHEET_LABELS[s.sheet]}: ${parts.join(', ')}`;
}

/**
 * Importar un Excel maestro de SEO: el catálogo de palabras con lo que se
 * propone de cada una, las métricas de SISTRIX, la competencia, los grupos,
 * el plan de acción y las pestañas de Search Console. Nunca pisa lo decidido a
 * mano ni el histórico; borrar la importación deshace lo que añadió.
 */
export function SeoMasterImportsCard({
  scope,
  canEdit,
}: {
  scope: SistrixScope;
  canEdit: boolean;
}) {
  const imports = useMasterImports(scope);
  const { remove } = useMasterImportMutations(scope);
  const confirm = useConfirm();
  const [uploading, setUploading] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);

  const del = async (imp: SeoMasterImportDto) => {
    const yes = await confirm({
      title: `¿Borrar la importación de ${imp.fileName}?`,
      description:
        'Se quitan sus métricas, posiciones y pestañas de Search Console, y lo que creó (palabras, competidores, grupos y tareas) si nadie lo ha cambiado después. Lo que se haya tocado a mano se queda.',
      confirmLabel: 'Borrar importación',
      destructive: true,
    });
    if (!yes) return;
    try {
      const r = await remove.mutateAsync(imp.id);
      toast.success(
        `Importación borrada: ${formatCount(r.removed)} datos quitados${
          r.kept ? `, ${formatCount(r.kept)} se quedan porque se cambiaron a mano` : ''
        }${r.reverted ? `, ${formatCount(r.reverted)} campos vaciados otra vez` : ''}.`,
      );
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            Importar maestro
            <Badge variant="secondary" className="font-normal">
              Excel
            </Badge>
          </CardTitle>
          <CardDescription>
            El Excel maestro de SEO (palabras con su grupo, intención, prioridad y URL objetivo,
            métricas de SISTRIX y de Search Console, competencia y plan de acción). Cada hoja va a
            su sitio; lo que ya decidiste a mano no se toca y las métricas se guardan con su fecha,
            sin borrar las anteriores.
          </CardDescription>
        </div>
        {canEdit && (
          <Button size="sm" className="shrink-0" onClick={() => setUploading(true)}>
            <Upload className="mr-1 size-4" aria-hidden /> Importar maestro
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {imports.isError ? (
          <SectionError onRetry={() => void imports.refetch()} />
        ) : imports.isLoading || !imports.data ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : imports.data.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Aún no has importado ningún maestro.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {imports.data.map((imp) => (
              <li
                key={imp.id}
                className="flex flex-col gap-2 p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <FileSpreadsheet
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="break-all">{imp.fileName}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {imp.domain}
                    {imp.extractedAt ? ` · datos del ${formatDate(imp.extractedAt)}` : ''}
                    {imp.gscFrom && imp.gscTo
                      ? ` · Search Console del ${formatDate(imp.gscFrom)} al ${formatDate(imp.gscTo)}`
                      : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {imp.sheets
                      .filter((s) =>
                        ['keywords', 'rankings', 'competitors', 'plan'].includes(s.sheet),
                      )
                      .map(sheetLine)
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {seoMasterOriginLabel(imp.createdAt)} · {formatDateTime(imp.createdAt)}
                    {imp.createdBy ? ` · ${imp.createdBy}` : ''}
                    {imp.issuesTotal > 0
                      ? ` · ${formatCount(imp.issuesTotal)} filas con aviso`
                      : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => setViewing(imp.id)}>
                    <Eye className="mr-1 size-4" aria-hidden /> Ver
                  </Button>
                  {canEdit && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Borrar importación"
                      title="Borrar importación"
                      onClick={() => void del(imp)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {uploading && <ImportDialog scope={scope} onClose={() => setUploading(false)} />}
      <DetailDialog scope={scope} importId={viewing} onClose={() => setViewing(null)} />
    </Card>
  );
}

function ImportDialog({ scope, onClose }: { scope: SistrixScope; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<SeoMasterPreviewDto | null>(null);
  const check = useMasterPreview(scope);
  const { create } = useMasterImportMutations(scope);

  const run = async (next: File | null) => {
    setPreview(null);
    setFile(next);
    if (!next) return;
    if (next.size > SEO_MASTER_MAX_BYTES) {
      toast.error('El fichero pasa de 20 MB.');
      return;
    }
    try {
      setPreview(await check.mutateAsync(next));
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  const confirmImport = async () => {
    if (!file) return;
    try {
      await create.mutateAsync(file);
      toast.success('Maestro importado');
      onClose();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importar un maestro de SEO</DialogTitle>
          <DialogDescription>
            El dominio de la hoja Resumen tiene que ser uno de los del proyecto. Antes de importar
            verás qué se crea, qué se rellena y qué se omite en cada hoja.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="seo-master-file">Fichero (.xlsx, hasta 20 MB)</Label>
            <input
              id="seo-master-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="block w-full text-base file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm sm:text-sm"
              onChange={(e) => void run(e.target.files?.[0] ?? null)}
            />
          </div>
          {check.isPending && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden /> Leyendo el maestro…
            </p>
          )}
          {preview && <PreviewView p={preview} />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => void confirmImport()} disabled={!preview || create.isPending}>
            {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
            Importar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewView({ p }: { p: SeoMasterPreviewDto }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border p-3">
        <p>
          <span className="font-medium">Dominio:</span> {p.domain}
          {p.extractedAt ? ` · datos del ${formatDate(p.extractedAt)}` : ''}
        </p>
        {p.gscFrom && p.gscTo && (
          <p className="text-muted-foreground">
            Search Console del {formatDate(p.gscFrom)} al {formatDate(p.gscTo)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Los datos importados se verán como «{seoMasterOriginLabel(new Date().toISOString())}».
        </p>
      </div>
      <SheetResults sheets={p.sheets} />
      {p.issuesTotal > 0 && <IssueList issues={p.issues} total={p.issuesTotal} />}
    </div>
  );
}

function SheetResults({ sheets }: { sheets: SeoMasterSheetResultDto[] }) {
  return (
    <ul className="space-y-2">
      {sheets.map((s) => (
        <li key={s.sheet} className="space-y-1 rounded-lg border p-3">
          <p className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="font-medium">{SEO_MASTER_SHEET_LABELS[s.sheet]}</span>
            <span className="text-xs text-muted-foreground">
              Hoja {SEO_MASTER_SHEET_NAMES[s.sheet]} · {formatCount(s.rows)} filas
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {s.created > 0 && <Badge variant="secondary">{formatCount(s.created)} nuevas</Badge>}
            {s.updated > 0 && (
              <Badge variant="secondary">{formatCount(s.updated)} rellenadas (lo vacío)</Badge>
            )}
            {s.unchanged > 0 && (
              <Badge variant="outline">{formatCount(s.unchanged)} ya estaban</Badge>
            )}
            {s.skipped > 0 && <Badge variant="outline">{formatCount(s.skipped)} omitidas</Badge>}
          </div>
          {s.reasons.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-900 dark:text-amber-200">
              {s.reasons.map((r) => (
                <li key={r.reason} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  <span>
                    {formatCount(r.count)} × {r.reason}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.notes.map((n) => (
            <p key={n} className="text-xs text-muted-foreground">
              {n}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function IssueList({ issues, total }: { issues: SeoMasterIssueDto[]; total: number }) {
  return (
    <details className="rounded-lg border p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        {formatCount(total)} {total === 1 ? 'fila con aviso' : 'filas con aviso'} (ver cuáles)
      </summary>
      <ul className="mt-2 space-y-1">
        {issues.map((i) => (
          <li key={`${i.sheet}-${i.line}-${i.reason}`} className="break-words">
            <span className="font-medium">
              {SEO_MASTER_SHEET_NAMES[i.sheet]}, fila {i.line}
            </span>
            {i.value ? ` · ${i.value}` : ''} — {i.reason}
            {i.level === 'warning' ? ' (entra igual)' : ''}
          </li>
        ))}
      </ul>
      {total > issues.length && (
        <p className="mt-2 text-muted-foreground">
          Se ven las {formatCount(issues.length)} primeras.
        </p>
      )}
    </details>
  );
}

function DetailDialog({
  scope,
  importId,
  onClose,
}: {
  scope: SistrixScope;
  importId: string | null;
  onClose: () => void;
}) {
  const detail = useMasterImportDetail(scope, importId);
  const groups = useKeywordGroups(scope, importId !== null);
  const d = detail.data;
  return (
    <Dialog open={importId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 break-all pr-6">
            {d?.fileName ?? 'Maestro'}
          </DialogTitle>
          <DialogDescription>
            {d
              ? `${d.domain} · ${seoMasterOriginLabel(d.createdAt)}${d.createdBy ? ` por ${d.createdBy}` : ''}`
              : ''}
          </DialogDescription>
        </DialogHeader>
        {detail.isError ? (
          <SectionError onRetry={() => void detail.refetch()} />
        ) : !d ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs defaultValue="sheets">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="sheets">Qué hizo</TabsTrigger>
              <TabsTrigger value="summary">Resumen</TabsTrigger>
              <TabsTrigger value="rules">Reglas</TabsTrigger>
              <TabsTrigger value="groups">Grupos</TabsTrigger>
              {d.issuesTotal > 0 && <TabsTrigger value="issues">Avisos</TabsTrigger>}
            </TabsList>
            <TabsContent value="sheets" className="pt-2">
              <SheetResults sheets={d.sheets} />
            </TabsContent>
            <TabsContent value="summary" className="pt-2">
              <dl className="divide-y rounded-lg border text-sm">
                {d.summary.map((r) => (
                  <div key={r.indicator} className="grid gap-1 p-2 sm:grid-cols-3">
                    <dt className="font-medium">{r.indicator}</dt>
                    <dd className="break-words">{r.value || '—'}</dd>
                    <dd className="break-words text-xs text-muted-foreground">{r.note}</dd>
                  </div>
                ))}
              </dl>
            </TabsContent>
            <TabsContent value="rules" className="pt-2">
              <p className="mb-2 text-xs text-muted-foreground">
                Las reglas de la hoja Fuentes_importacion, tal como vienen en el maestro.
              </p>
              <dl className="divide-y rounded-lg border text-sm">
                {d.rules.map((r) => (
                  <div key={`${r.field}-${r.rule}`} className="space-y-0.5 p-2">
                    <dt className="font-medium">{r.field}</dt>
                    <dd className="break-words">{r.rule}</dd>
                    {r.source && (
                      <dd className="break-words text-xs text-muted-foreground">{r.source}</dd>
                    )}
                  </div>
                ))}
              </dl>
            </TabsContent>
            <TabsContent value="groups" className="pt-2">
              {groups.isError ? (
                <SectionError onRetry={() => void groups.refetch()} />
              ) : !groups.data ? (
                <div className="flex justify-center py-6">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                </div>
              ) : groups.data.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  El proyecto aún no tiene grupos.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border text-sm">
                  {groups.data.map((g) => (
                    <li key={g.id} className="space-y-0.5 p-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{g.name}</span>
                        {g.priority !== null && (
                          <Badge variant="outline" className="font-normal">
                            Prioridad {SEO_KEYWORD_PRIORITY_LABELS[g.priority]?.toLowerCase()}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatCount(g.keywords)} palabras
                        </span>
                      </p>
                      {g.targetUrl && (
                        <p className="break-all text-xs text-muted-foreground">{g.targetUrl}</p>
                      )}
                      {g.notes && <p className="text-xs">{g.notes}</p>}
                      {g.masterImportedAt && (
                        <p className="text-xs text-muted-foreground">
                          {seoMasterOriginLabel(g.masterImportedAt)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </TabsContent>
            {d.issuesTotal > 0 && (
              <TabsContent value="issues" className="pt-2">
                <IssueList issues={d.issues} total={d.issuesTotal} />
              </TabsContent>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
