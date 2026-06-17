'use client';

import { ArrowLeft, Download, Loader2, Upload } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type {
  ImportCustomersCommitDto,
  ImportCustomersPreviewDto,
  ImportDuplicatePolicy,
  ImportRowStatus,
} from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  downloadCustomerImportTemplate,
  useCommitCustomerImport,
  usePreviewCustomerImport,
} from '@/lib/imports/hooks';

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  valid: 'Válido',
  duplicate: 'Duplicado',
  error: 'Error',
};

function StatusBadge({ status }: { status: ImportRowStatus }) {
  const variant =
    status === 'valid' ? 'default' : status === 'duplicate' ? 'secondary' : 'destructive';
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

export default function ImportCustomersPage() {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportCustomersPreviewDto | null>(null);
  const [onDuplicate, setOnDuplicate] = useState<ImportDuplicatePolicy>('skip');
  const [result, setResult] = useState<ImportCustomersCommitDto | null>(null);

  const previewMutation = usePreviewCustomerImport();
  const commitMutation = useCommitCustomerImport();

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(typeof reader.result === 'string' ? reader.result : '');
      setFileName(file.name);
      setPreview(null);
      setResult(null);
    };
    reader.readAsText(file);
  }

  async function analyze() {
    try {
      const res = await previewMutation.mutateAsync(csv);
      setPreview(res);
      setResult(null);
    } catch {
      toast.error('No se pudo analizar el CSV.');
    }
  }

  async function commit() {
    try {
      const res = await commitMutation.mutateAsync({ csv, onDuplicate });
      setResult(res);
      toast.success(`Importación completada: ${res.summary.created} creados.`);
    } catch {
      toast.error('No se pudo completar la importación.');
    }
  }

  const importableCount = preview
    ? preview.summary.valid + (onDuplicate === 'create' ? preview.summary.duplicates : 0)
    : 0;

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Importar inquilinos</h1>
          <p className="text-sm text-muted-foreground">
            Sube un CSV para dar de alta clientes en bloque. Revisa la vista previa antes de
            confirmar.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/customers">
            <ArrowLeft className="mr-1 h-4 w-4" /> Volver
          </Link>
        </Button>
      </div>

      {/* Paso 1: subir archivo */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Archivo CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <label className="cursor-pointer">
                <Upload className="mr-1 h-4 w-4" /> Seleccionar archivo
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    e.target.value = '';
                  }}
                />
              </label>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void downloadCustomerImportTemplate();
              }}
            >
              <Download className="mr-1 h-4 w-4" /> Descargar plantilla
            </Button>
            {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
          </div>
          <Button onClick={analyze} disabled={!csv || previewMutation.isPending}>
            {previewMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Analizar CSV
          </Button>
        </CardContent>
      </Card>

      {/* Paso 2: vista previa */}
      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">2. Vista previa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                Total: <strong>{preview.summary.total}</strong>
              </span>
              <span className="text-green-600">
                Válidos: <strong>{preview.summary.valid}</strong>
              </span>
              <span className="text-amber-600">
                Duplicados: <strong>{preview.summary.duplicates}</strong>
              </span>
              <span className="text-destructive">
                Con error: <strong>{preview.summary.invalid}</strong>
              </span>
            </div>

            {preview.summary.duplicates > 0 && (
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span className="text-muted-foreground">Duplicados:</span>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="onDuplicate"
                    checked={onDuplicate === 'skip'}
                    onChange={() => setOnDuplicate('skip')}
                  />
                  Omitir
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="radio"
                    name="onDuplicate"
                    checked={onDuplicate === 'create'}
                    onChange={() => setOnDuplicate('create')}
                  />
                  Crear igualmente
                </label>
              </div>
            )}

            <div className="max-h-[50vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>Estado</TableHead>
                    {preview.columns.slice(0, 5).map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                    <TableHead>Errores</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => (
                    <TableRow key={row.index}>
                      <TableCell className="text-muted-foreground">{row.index}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      {preview.columns.slice(0, 5).map((c) => (
                        <TableCell key={c} className="max-w-[180px] truncate">
                          {row.raw[c] ?? ''}
                        </TableCell>
                      ))}
                      <TableCell className="text-xs text-destructive">
                        {row.errors.join('; ')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <Button onClick={commit} disabled={importableCount === 0 || commitMutation.isPending}>
              {commitMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              Importar {importableCount} inquilino{importableCount === 1 ? '' : 's'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Paso 3: resultado */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Resultado</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <span className="text-green-600">
                Creados: <strong>{result.summary.created}</strong>
              </span>
              <span className="text-amber-600">
                Omitidos: <strong>{result.summary.skipped}</strong>
              </span>
              <span className="text-destructive">
                Errores: <strong>{result.summary.errors}</strong>
              </span>
            </div>
            {result.summary.errors > 0 && (
              <div className="max-h-[40vh] overflow-auto rounded-md border p-3 text-xs">
                {result.rows
                  .filter((r) => r.status === 'error')
                  .map((r) => (
                    <p key={r.index}>
                      Fila {r.index}: {(r.errors ?? []).join('; ')}
                    </p>
                  ))}
              </div>
            )}
            <Button asChild>
              <Link href="/customers">Ver inquilinos</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
