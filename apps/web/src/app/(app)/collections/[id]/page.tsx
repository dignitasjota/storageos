'use client';

import {
  CASE_FILE_KIND_LABELS,
  DISPOSAL_TYPE_LABELS,
  DISPOSAL_TYPES,
  type DisposalType,
} from '@storageos/shared';
import { ArrowLeft, FileText, FileUp, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { CASE_EVENT_LABELS, CASE_STATUS_CLASSES, CASE_STATUS_LABELS, eur } from '../status';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useCaseAction,
  useCollectionsCase,
  useGenerateRequirementPdf,
  useUploadCaseFile,
} from '@/lib/collections/hooks';

const FILE_KINDS = [
  { value: 'overlock_photo', label: 'Foto del candado' },
  { value: 'burofax_receipt', label: 'Acuse del burofax' },
  { value: 'inventory', label: 'Inventario' },
  { value: 'disposal_act', label: 'Acta de disposición' },
  { value: 'other', label: 'Otro' },
] as const;

export default function CollectionsDetailPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useCollectionsCase(id);
  const action = useCaseAction(id);
  const upload = useUploadCaseFile(id);
  const requirementPdf = useGenerateRequirementPdf(id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileKind, setFileKind] = useState<(typeof FILE_KINDS)[number]['value']>('overlock_photo');

  // Inputs de acciones con parámetros.
  const [noticeDays, setNoticeDays] = useState(15);
  const [disposalType, setDisposalType] = useState<DisposalType>('auction_notarial');
  const [proceeds, setProceeds] = useState('0');
  const [applyDeposit, setApplyDeposit] = useState(true);
  const [note, setNote] = useState('');

  const c = detail.data;

  async function run(body: Parameters<typeof action.mutateAsync>[0], ok: string) {
    try {
      await action.mutateAsync(body);
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function onUpload(file: File) {
    try {
      await upload.mutateAsync({ file, kind: fileKind });
      toast.success('Evidencia subida.');
    } catch {
      toast.error('No se pudo subir.');
    }
  }

  async function onGenerateRequirement() {
    try {
      const { url } = await requirementPdf.mutateAsync();
      window.open(url, '_blank', 'noopener');
      toast.success('Requerimiento generado. Se ha guardado en las evidencias.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo generar');
    }
  }

  if (detail.isLoading || !c) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isClosed = c.status.startsWith('closed_');

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <Link
        href="/collections"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Expedientes
      </Link>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              {c.overlockedAt && <Lock className="size-4 text-orange-500" />}
              <Link href={`/customers/${c.customerId}`} className="hover:underline">
                {c.customerName}
              </Link>
            </CardTitle>
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-medium ${CASE_STATUS_CLASSES[c.status]}`}
            >
              {CASE_STATUS_LABELS[c.status]}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
            <span>
              Deuda viva:{' '}
              <span className="font-semibold text-red-600 dark:text-red-400">
                {eur(c.debtCents)}
              </span>
            </span>
            {c.unitCode && (
              <Link href={`/units/${c.unitId}`} className="hover:underline">
                Trastero {c.unitCode}
              </Link>
            )}
            <Link href={`/contracts/${c.contractId}`} className="hover:underline">
              Ver contrato
            </Link>
          </div>
          {c.finalNoticeDeadline && (
            <div>
              Plazo del requerimiento: {new Date(c.finalNoticeDeadline).toLocaleDateString('es-ES')}{' '}
              {c.deadlineExpired && <Badge variant="destructive">vencido</Badge>}
            </div>
          )}

          <Can permission="collections:manage">
            <div className="border-t pt-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void onGenerateRequirement()}
                disabled={requirementPdf.isPending}
              >
                {requirementPdf.isPending ? (
                  <Loader2 className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <FileText className="mr-1.5 size-4" />
                )}
                Generar requerimiento (PDF)
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                Carta de requerimiento fehaciente para enviar por burofax. Se guarda en las
                evidencias del expediente.
              </p>
            </div>
          </Can>

          <Can permission="collections:manage">
            {!isClosed && (
              <div className="flex flex-wrap gap-2 border-t pt-3">
                {c.status === 'open' && (
                  <Button
                    size="sm"
                    onClick={() => run({ action: 'overlock', input: {} }, 'Candado registrado')}
                  >
                    <Lock className="mr-1.5 size-4" /> Registrar candado
                  </Button>
                )}
                {c.status === 'overlocked' && (
                  <div className="flex items-end gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Plazo (días)</Label>
                      <Input
                        type="number"
                        className="w-24"
                        value={noticeDays}
                        onChange={(e) => setNoticeDays(e.target.valueAsNumber || 0)}
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() =>
                        run({ action: 'notice', input: { noticeDays } }, 'Requerimiento registrado')
                      }
                    >
                      Registrar requerimiento
                    </Button>
                  </div>
                )}
                {c.status === 'final_notice' && (
                  <Button
                    size="sm"
                    variant={c.deadlineExpired ? 'default' : 'outline'}
                    onClick={() =>
                      run({ action: 'resolution-pending' }, 'Marcado como plazo vencido')
                    }
                  >
                    Marcar plazo vencido
                  </Button>
                )}
                {c.status === 'resolution_pending' && (
                  <div className="flex items-end gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Tipo</Label>
                      <Select
                        value={disposalType}
                        onValueChange={(v) => setDisposalType(v as DisposalType)}
                      >
                        <SelectTrigger className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DISPOSAL_TYPES.map((t) => (
                            <SelectItem key={t} value={t}>
                              {DISPOSAL_TYPE_LABELS[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      size="sm"
                      onClick={() =>
                        run({ action: 'disposal', input: { disposalType } }, 'Disposición iniciada')
                      }
                    >
                      Iniciar disposición
                    </Button>
                  </div>
                )}
                {c.status === 'disposal' && (
                  <div className="space-y-2">
                    <div className="flex items-end gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Importe obtenido (€)</Label>
                        <Input
                          type="number"
                          className="w-28"
                          value={proceeds}
                          onChange={(e) => setProceeds(e.target.value)}
                        />
                      </div>
                      <Button
                        size="sm"
                        onClick={() =>
                          run(
                            {
                              action: 'complete-disposal',
                              input: {
                                proceedsCents: Math.round((Number(proceeds) || 0) * 100),
                                applyDeposit,
                              },
                            },
                            'Disposición completada',
                          )
                        }
                      >
                        Completar disposición
                      </Button>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={applyDeposit}
                        onChange={(e) => setApplyDeposit(e.target.checked)}
                      />
                      Aplicar la fianza retenida + lo obtenido a las facturas pendientes (más
                      antigua primero)
                    </label>
                  </div>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => {
                    const reason = window.prompt('Motivo de la cancelación:');
                    if (reason) {
                      void run({ action: 'cancel', input: { reason } }, 'Expediente cancelado');
                    }
                  }}
                >
                  Cancelar expediente
                </Button>
              </div>
            )}
          </Can>
        </CardContent>
      </Card>

      {/* Evidencias */}
      <Can permission="collections:manage">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Evidencias</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!isClosed && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Tipo</Label>
                  <Select value={fileKind} onValueChange={(v) => setFileKind(v as typeof fileKind)}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FILE_KINDS.map((k) => (
                        <SelectItem key={k.value} value={k.value}>
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onUpload(f);
                    e.target.value = '';
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={upload.isPending}
                  onClick={() => fileInput.current?.click()}
                >
                  {upload.isPending ? (
                    <Loader2 className="mr-1.5 size-4 animate-spin" />
                  ) : (
                    <FileUp className="mr-1.5 size-4" />
                  )}
                  Subir archivo
                </Button>
              </div>
            )}
            {c.files.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin evidencias.</p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {c.files.map((f) => (
                  <a
                    key={f.id}
                    href={f.url}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border p-2 text-xs hover:bg-accent"
                  >
                    <div className="truncate font-medium">
                      {CASE_FILE_KIND_LABELS[f.kind as keyof typeof CASE_FILE_KIND_LABELS] ??
                        f.kind}
                    </div>
                    <div className="text-muted-foreground">
                      {new Date(f.createdAt).toLocaleDateString('es-ES')}
                    </div>
                  </a>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </Can>

      {/* Nota + timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historial</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Can permission="collections:manage">
            {!isClosed && (
              <div className="flex gap-2">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Añadir una nota al expediente…"
                  rows={2}
                />
                <Button
                  size="sm"
                  disabled={!note.trim()}
                  onClick={async () => {
                    await run({ action: 'note', input: { note: note.trim() } }, 'Nota añadida');
                    setNote('');
                  }}
                >
                  Añadir
                </Button>
              </div>
            )}
          </Can>
          <ol className="space-y-3">
            {c.events.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                <div>
                  <div className="font-medium">{CASE_EVENT_LABELS[e.eventType] ?? e.eventType}</div>
                  {typeof e.payload.note === 'string' && (
                    <div className="text-muted-foreground">{e.payload.note}</div>
                  )}
                  {typeof e.payload.reason === 'string' && (
                    <div className="text-muted-foreground">Motivo: {e.payload.reason}</div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {new Date(e.occurredAt).toLocaleString('es-ES', {
                      day: '2-digit',
                      month: '2-digit',
                      year: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {e.createdByName ? ` · ${e.createdByName}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
