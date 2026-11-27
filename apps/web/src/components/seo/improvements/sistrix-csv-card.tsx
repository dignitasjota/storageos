'use client';

import {
  SEO_SISTRIX_CSV_KINDS,
  SEO_SISTRIX_CSV_KIND_LABELS,
  SEO_SISTRIX_CSV_MAX_BYTES,
  type SeoSistrixCsvKind,
  type SeoSistrixCsvPreviewDto,
} from '@storageos/shared';
import { FileUp, Loader2, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { seoErrorMessage } from '../seo-errors';

import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCount, formatDateTime } from '@/lib/format';
import {
  useSistrixCsv,
  useSistrixImports,
  type ImprovementScope,
} from '@/lib/seo-advanced/improvement-hooks';
import { useSistrixCompetitors } from '@/lib/seo-advanced/sistrix-hooks';

const HELP: Record<SeoSistrixCsvKind, string> = {
  domain_keywords:
    'El CSV de las palabras con las que sale un dominio (columnas Palabra y Posición, y la URL si la hay). Elige de qué dominio son.',
  serp: 'El CSV de lo que sale en Google para una búsqueda (Posición, Dominio o URL, y el título si lo hay). Escribe la búsqueda.',
  competitors:
    'El CSV de competidores de un dominio (una columna Dominio). Quedan sin seguir hasta que los actives.',
};

/**
 * Importar los CSV de SISTRIX (mejora 8): da datos de competencia sin gastar
 * créditos. Vista previa antes de guardar; lo importado queda marcado como
 * «importación manual» con su fecha y se puede borrar entero.
 */
export function SeoSistrixCsvCard({
  scope,
  canEdit,
  domains: ownDomains,
}: {
  scope: ImprovementScope;
  canEdit: boolean;
  /** Dominios del proyecto (los de los competidores se añaden solos). */
  domains: string[];
}) {
  const competitors = useSistrixCompetitors(scope);
  const domains = [...new Set([...ownDomains, ...(competitors.data ?? []).map((c) => c.domain)])];
  const confirm = useConfirm();
  const history = useSistrixImports(scope);
  const { preview, commit, remove } = useSistrixCsv(scope);
  const [kind, setKind] = useState<SeoSistrixCsvKind>('domain_keywords');
  const [domain, setDomain] = useState('');
  const [keyword, setKeyword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<SeoSistrixCsvPreviewDto | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const ready =
    !!file && (kind !== 'domain_keywords' || !!domain) && (kind !== 'serp' || !!keyword.trim());
  const payload = () => ({
    kind,
    file: file!,
    ...(kind === 'domain_keywords' ? { domain } : {}),
    ...(kind === 'serp' ? { keyword: keyword.trim() } : {}),
  });

  const reset = () => {
    setFile(null);
    setResult(null);
    if (input.current) input.current.value = '';
  };
  const choose = (f: File | null) => {
    setResult(null);
    if (f && f.size > SEO_SISTRIX_CSV_MAX_BYTES) {
      toast.error('El fichero pesa más de 5 MB.');
      if (input.current) input.current.value = '';
      return;
    }
    setFile(f);
  };
  const look = async () => {
    try {
      setResult(await preview.mutateAsync(payload()));
    } catch (err) {
      setResult(null);
      toast.error(seoErrorMessage(err));
    }
  };
  const save = async () => {
    try {
      const res = await commit.mutateAsync(payload());
      toast.success(`Importado: ${formatCount(res.rows)} filas`);
      reset();
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };
  const del = async (id: string, name: string) => {
    const yes = await confirm({
      title: `¿Borrar la importación «${name}»?`,
      description: 'Se borran las palabras y resultados que trajo. Los competidores se quedan.',
      confirmLabel: 'Borrar',
      destructive: true,
    });
    if (!yes) return;
    try {
      await remove.mutateAsync(id);
    } catch (err) {
      toast.error(seoErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileUp className="size-4" aria-hidden /> Importar CSV de SISTRIX
          <Badge variant="outline" className="font-normal">
            Sin gastar créditos
          </Badge>
        </CardTitle>
        <CardDescription>
          Si descargas datos desde la web de SISTRIX, súbelos aquí y se usan como los demás. Quedan
          marcados como «importación manual» con la fecha en que los subes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Qué fichero es</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as SeoSistrixCsvKind);
                    setResult(null);
                  }}
                >
                  <SelectTrigger aria-label="Tipo de fichero">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEO_SISTRIX_CSV_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {SEO_SISTRIX_CSV_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {kind === 'domain_keywords' && (
                <div className="space-y-1">
                  <Label>De qué dominio</Label>
                  <Select value={domain} onValueChange={setDomain}>
                    <SelectTrigger aria-label="Dominio">
                      <SelectValue placeholder="Elige un dominio" />
                    </SelectTrigger>
                    <SelectContent>
                      {domains.map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {kind === 'serp' && (
                <div className="space-y-1">
                  <Label htmlFor="csv-keyword">Búsqueda</Label>
                  <Input
                    id="csv-keyword"
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder="trasteros valencia"
                  />
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{HELP[kind]}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                ref={input}
                type="file"
                accept=".csv,text/csv"
                aria-label="Fichero CSV"
                className="max-w-xs"
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!ready || preview.isPending}
                onClick={() => void look()}
              >
                {preview.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
                Ver qué importaría
              </Button>
            </div>
            {result && (
              <div className="space-y-2 rounded-md border p-3 text-sm">
                <p>
                  Se guardarían <strong>{formatCount(result.rows)}</strong> filas
                  {result.skipped > 0
                    ? ` (${formatCount(result.skipped)} se saltan: ya estaban o no valen)`
                    : ''}
                  .
                </p>
                {result.warnings.map((w) => (
                  <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
                    {w}
                  </p>
                ))}
                <ul className="divide-y rounded border text-xs">
                  {result.sample.map((r, i) => (
                    <li key={i} className="grid grid-cols-3 gap-2 px-2 py-1">
                      <span className="break-words">{r.a}</span>
                      <span className="break-words">{r.b}</span>
                      <span className="break-all text-muted-foreground">{r.c}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  size="sm"
                  disabled={commit.isPending || result.rows === 0}
                  onClick={() => void save()}
                >
                  {commit.isPending && <Loader2 className="mr-1 size-4 animate-spin" aria-hidden />}
                  Importar
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="space-y-1.5">
          <p className="text-sm font-medium">Importaciones hechas</p>
          {(history.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Aún no has importado nada.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {history.data?.map((i) => (
                <li key={i.id} className="flex items-start justify-between gap-2 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {SEO_SISTRIX_CSV_KIND_LABELS[i.kind]}
                      {i.domain ? ` · ${i.domain}` : ''}
                      {i.keyword ? ` · «${i.keyword}»` : ''}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {i.filename} · {formatCount(i.rows)} filas · importación manual del{' '}
                      {formatDateTime(i.createdAt)}
                    </p>
                  </div>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Borrar la importación ${i.filename}`}
                      onClick={() => void del(i.id, i.filename)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
