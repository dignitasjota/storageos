'use client';

import {
  CASE_FILE_KIND_LABELS,
  CUSTODY_WEEKS_BEFORE_ABANDONMENT,
  DISPOSAL_TYPE_LABELS,
  DISPOSAL_TYPES,
  MIN_NOTICE_DAYS,
  type CaseFileKind,
  type DelinquencyCaseDetailDto,
  type DisposalType,
} from '@storageos/shared';
import { ArrowLeft, FileText, FileUp, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  CASE_EVENT_LABELS,
  CASE_STATUS_CLASSES,
  CASE_STATUS_LABELS,
  CLOSE_REASON_LABELS,
  eur,
} from '../status';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
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
import { useHasPermission } from '@/lib/auth/hooks';
import {
  useCaseAction,
  useCollectionsCase,
  useCollectionsSettings,
  useGenerateRequirementPdf,
  useUploadCaseFile,
} from '@/lib/collections/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate, formatDateTime } from '@/lib/format';

/** Lo que sube el equipo (el requerimiento lo genera el sistema). */
const FILE_KINDS: CaseFileKind[] = [
  'overlock_photo',
  'burofax_receipt',
  'inventory',
  'custody_act',
  'disposal_act',
  'other',
];

/** Una fecha `YYYY-MM-DD` como instante: hoy es «ahora»; otro día, a mediodía. */
function dayToIso(day: string): string {
  return day === localDateString()
    ? new Date().toISOString()
    : new Date(`${day}T12:00:00`).toISOString();
}

type Case = DelinquencyCaseDetailDto;

export default function CollectionsDetailPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useCollectionsCase(id);

  if (detail.isError) {
    const status = detail.error instanceof ApiError ? detail.error.statusCode : 0;
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <BackLink />
        {status === 404 || status === 403 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Este expediente no existe o no lo puedes ver.
          </p>
        ) : (
          <SectionError onRetry={() => void detail.refetch()} />
        )}
      </div>
    );
  }

  if (detail.isLoading || !detail.data) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const c = detail.data;
  const isClosed = c.status.startsWith('closed_');

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <BackLink />
      <CaseHeader c={c} />
      {!isClosed && (
        <Can permission="collections:manage">
          <NextStep c={c} />
        </Can>
      )}
      <OverdueInvoices c={c} />
      <Evidence c={c} isClosed={isClosed} />
      <History c={c} isClosed={isClosed} />
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/collections"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> Impagos
    </Link>
  );
}

function CaseHeader({ c }: { c: Case }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {c.overlockedAt && !c.status.startsWith('closed_') && (
              <Lock className="size-4 text-orange-500" aria-label="Con candado" />
            )}
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
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
          <span>
            Debe:{' '}
            <span className="font-semibold text-red-600 dark:text-red-400">{eur(c.debtCents)}</span>
          </span>
          {c.unitCode && (
            <Link href={`/units/${c.unitId}`} className="hover:underline">
              Trastero {c.unitCode}
              {c.facilityName ? ` · ${c.facilityName}` : ''}
            </Link>
          )}
          <Link href={`/contracts/${c.contractId}`} className="hover:underline">
            Ver contrato
          </Link>
        </div>
        <dl className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
          <Fact label="Abierto" value={formatDate(c.openedAt)} />
          {c.overlockedAt && <Fact label="Candado" value={formatDate(c.overlockedAt)} />}
          {c.finalNoticeAt && (
            <Fact
              label="Requerimiento enviado"
              value={`${formatDate(c.finalNoticeAt)}${c.noticeTracking ? ` · nº ${c.noticeTracking}` : ''}`}
            />
          )}
          {c.noticeReceivedAt && <Fact label="Lo recibió" value={formatDate(c.noticeReceivedAt)} />}
          {c.finalNoticeDeadline && (
            <Fact
              label={`Plazo para pagar (${c.noticeDays ?? MIN_NOTICE_DAYS} días)`}
              value={
                <>
                  {formatDate(c.finalNoticeDeadline)}{' '}
                  {c.deadlineExpired && <Badge variant="destructive">vencido</Badge>}
                </>
              }
            />
          )}
          {c.contractResolvedAt && (
            <Fact label="Contrato resuelto" value={formatDate(c.contractResolvedAt)} />
          )}
          {c.goodsMovedAt && (
            <Fact
              label="Bienes en custodia"
              value={`${formatDate(c.goodsMovedAt)}${c.custodyLocation ? ` · ${c.custodyLocation}` : ''}`}
            />
          )}
          {c.disposalType && (
            <Fact
              label="Cauce legal"
              value={DISPOSAL_TYPE_LABELS[c.disposalType] ?? c.disposalType}
            />
          )}
          {c.closedAt && <Fact label="Cerrado" value={formatDate(c.closedAt)} />}
        </dl>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="inline">{label}: </dt>
      <dd className="inline text-foreground">{value}</dd>
    </div>
  );
}

/** Qué toca hacer ahora, según el estado (condición 12 del contrato). */
function NextStep({ c }: { c: Case }) {
  const ask = useConfirm();
  const action = useCaseAction(c.id);
  const requirementPdf = useGenerateRequirementPdf(c.id);
  const canReadSettings = useHasPermission('settings:read');
  const settings = useCollectionsSettings(canReadSettings);

  const [priorNotice, setPriorNotice] = useState('');
  const [noticeDays, setNoticeDays] = useState<string>('');
  const [tracking, setTracking] = useState('');
  const [sentOn, setSentOn] = useState<string | undefined>(localDateString());
  const [receivedOn, setReceivedOn] = useState<string | undefined>(localDateString());
  const [custody, setCustody] = useState('');
  const [disposalType, setDisposalType] = useState<DisposalType>('court_order');
  const [proceeds, setProceeds] = useState('0');
  const [applyDeposit, setApplyDeposit] = useState(true);

  const hasFile = (kind: string) => c.files.some((f) => f.kind === kind);
  const defaultDays = c.noticeDays ?? settings.data?.collectionsNoticeDays ?? MIN_NOTICE_DAYS;
  const days = noticeDays === '' ? defaultDays : Number(noticeDays);
  const abandonmentReady = !!c.abandonmentFrom && new Date(c.abandonmentFrom) <= new Date();
  const busy = action.isPending;

  async function run(body: Parameters<typeof action.mutateAsync>[0], ok: string) {
    try {
      await action.mutateAsync(body);
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido hacer.');
    }
  }

  async function generateRequirement() {
    try {
      const { url } = await requirementPdf.mutateAsync();
      toast.success('Requerimiento generado y guardado en las evidencias.', {
        duration: 15_000,
        action: { label: 'Abrir', onClick: () => window.open(url, '_blank', 'noopener') },
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido generar.');
    }
  }

  const requirementButton = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void generateRequirement()}
      disabled={requirementPdf.isPending}
    >
      {requirementPdf.isPending ? (
        <Loader2 className="mr-1.5 size-4 animate-spin" />
      ) : (
        <FileText className="mr-1.5 size-4" />
      )}
      Generar el requerimiento (PDF)
    </Button>
  );

  let body: ReactNode = null;
  if (c.status === 'open') {
    body = (
      <>
        <p>
          Antes de poner el candado hay que avisarle del impago.{' '}
          {c.reminded
            ? 'Ya se le envió un recordatorio de pago.'
            : 'Aún no se le ha enviado ningún recordatorio: envíaselo desde la factura o indica cómo se le avisó.'}
        </p>
        {!c.reminded && (
          <div className="space-y-1">
            <Label htmlFor="prior-notice" className="text-xs">
              Cómo se le avisó
            </Label>
            <Input
              id="prior-notice"
              value={priorNotice}
              onChange={(e) => setPriorNotice(e.target.value)}
              placeholder="Ej. llamada el 3 de noviembre"
              maxLength={500}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || (!c.reminded && !priorNotice.trim())}
            onClick={() =>
              run(
                {
                  action: 'overlock',
                  input: priorNotice.trim() ? { priorNotice: priorNotice.trim() } : {},
                },
                'Candado registrado',
              )
            }
          >
            <Lock className="mr-1.5 size-4" /> Registrar el candado
          </Button>
          {requirementButton}
        </div>
      </>
    );
  } else if (c.status === 'overlocked') {
    body = (
      <>
        <p>
          Envíale el requerimiento por burofax con acuse de recibo y certificación de texto, y
          registra el envío. El plazo para pagar es de {MIN_NOTICE_DAYS} días como mínimo desde que
          lo reciba.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="notice-days" className="text-xs">
              Días de plazo
            </Label>
            <Input
              id="notice-days"
              type="number"
              inputMode="numeric"
              min={MIN_NOTICE_DAYS}
              max={180}
              value={noticeDays === '' ? String(defaultDays) : noticeDays}
              onChange={(e) => setNoticeDays(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tracking" className="text-xs">
              Nº de envío (opcional)
            </Label>
            <Input
              id="tracking"
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
              maxLength={100}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Enviado el</Label>
            <DateSelect value={sentOn} onChange={setSentOn} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {requirementButton}
          <Button
            size="sm"
            disabled={busy || !sentOn || !(days >= MIN_NOTICE_DAYS && days <= 180)}
            onClick={() =>
              run(
                {
                  action: 'notice',
                  input: {
                    noticeDays: days,
                    sentAt: dayToIso(sentOn!),
                    ...(tracking.trim() ? { tracking: tracking.trim() } : {}),
                  },
                },
                'Envío registrado',
              )
            }
          >
            Registrar el envío
          </Button>
        </div>
        {!(days >= MIN_NOTICE_DAYS && days <= 180) && (
          <p className="text-xs text-red-600 dark:text-red-400">
            El plazo va de {MIN_NOTICE_DAYS} a 180 días.
          </p>
        )}
      </>
    );
  } else if (c.status === 'final_notice') {
    body = (
      <>
        <p>
          {c.noticeReceivedAt
            ? `Lo recibió el ${formatDate(c.noticeReceivedAt)}. `
            : 'Cuando llegue el acuse, registra el día en que lo recibió: el plazo cuenta desde entonces. '}
          {c.deadlineExpired
            ? 'El plazo ya venció sin pagar.'
            : `Si no paga antes del ${formatDate(c.finalNoticeDeadline)}, el contrato quedará resuelto.`}
        </p>
        {!c.noticeReceivedAt && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Lo recibió el</Label>
              <DateSelect value={receivedOn} onChange={setReceivedOn} />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !receivedOn}
              onClick={() =>
                run(
                  { action: 'notice-received', input: { receivedAt: dayToIso(receivedOn!) } },
                  'Entrega registrada',
                )
              }
            >
              Registrar la entrega
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || !c.deadlineExpired}
            onClick={() => run({ action: 'resolution-pending' }, 'Plazo vencido registrado')}
          >
            El plazo venció sin pagar
          </Button>
        </div>
      </>
    );
  } else if (c.status === 'resolution_pending') {
    body = (
      <>
        <p>
          No pagó en el plazo: el contrato queda resuelto. Se terminará y el trastero quedará
          bloqueado mientras sus bienes sigan dentro. Pídele que los retire.
        </p>
        <div>
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              const ok = await ask({
                title: 'Resolver el contrato',
                description:
                  'Se termina el contrato y el trastero queda bloqueado hasta que se vacíe. La deuda sigue pendiente.',
                confirmLabel: 'Resolver',
                destructive: true,
              });
              if (ok) void run({ action: 'resolve-contract', input: {} }, 'Contrato resuelto');
            }}
          >
            Resolver el contrato
          </Button>
        </div>
      </>
    );
  } else if (c.status === 'contract_resolved') {
    const inventory = hasFile('inventory');
    body = (
      <>
        <p>
          Si no retira sus bienes, trasládalos a un lugar de custodia con inventario (fotos y lista
          de lo que hay), mejor ante testigos o notario. Los gastos de traslado y custodia son a su
          cargo.
        </p>
        {!inventory && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Sube primero el inventario en «Evidencias».
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="custody" className="text-xs">
              Dónde quedan custodiados
            </Label>
            <Input
              id="custody"
              value={custody}
              onChange={(e) => setCustody(e.target.value)}
              placeholder="Ej. nave 3, polígono norte"
              maxLength={300}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !inventory || custody.trim().length < 3}
            onClick={() =>
              run(
                { action: 'move-goods', input: { custodyLocation: custody.trim() } },
                'Traslado registrado: el trastero vuelve a estar disponible',
              )
            }
          >
            Registrar el traslado
          </Button>
        </div>
      </>
    );
  } else if (c.status === 'goods_moved') {
    body = (
      <>
        <p>
          Sus bienes están en custodia{c.custodyLocation ? ` (${c.custodyLocation})` : ''}. Solo se
          puede disponer de ellos por un cauce legal: una resolución judicial, un acuerdo escrito
          con él o, pasadas {CUSTODY_WEEKS_BEFORE_ABANDONMENT} semanas de custodia, el abandono
          acreditado
          {c.abandonmentFrom ? ` (desde el ${formatDate(c.abandonmentFrom)})` : ''}.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Cauce legal</Label>
            <Select value={disposalType} onValueChange={(v) => setDisposalType(v as DisposalType)}>
              <SelectTrigger className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DISPOSAL_TYPES.map((t) => (
                  <SelectItem key={t} value={t} disabled={t === 'abandonment' && !abandonmentReady}>
                    {DISPOSAL_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            disabled={busy || (disposalType === 'abandonment' && !abandonmentReady)}
            onClick={() =>
              run({ action: 'disposal', input: { disposalType } }, 'Disposición iniciada')
            }
          >
            Iniciar la disposición
          </Button>
        </div>
      </>
    );
  } else if (c.status === 'disposal') {
    const act = hasFile('disposal_act');
    const cents = Math.round((Number(proceeds.replace(',', '.')) || 0) * 100);
    body = (
      <>
        <p>
          Sube el documento del cauce legal (sentencia, acuerdo firmado o acta del abandono) y
          registra lo obtenido. Lo que sobre tras saldar la deuda es del inquilino.
        </p>
        {!act && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Sube primero el documento en «Evidencias».
          </p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="proceeds" className="text-xs">
              Importe obtenido (€)
            </Label>
            <Input
              id="proceeds"
              inputMode="decimal"
              className="w-32"
              value={proceeds}
              onChange={(e) => setProceeds(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || !act || cents < 0}
            onClick={() =>
              run(
                {
                  action: 'complete-disposal',
                  input: { proceedsCents: cents, applyDeposit },
                },
                'Disposición completada',
              )
            }
          >
            Completar la disposición
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={applyDeposit}
            onChange={(e) => setApplyDeposit(e.target.checked)}
          />
          Aplicar la fianza y lo obtenido a las facturas pendientes (la más antigua primero)
        </label>
      </>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Siguiente paso</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {body}
        <div className="border-t pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            disabled={busy}
            onClick={async () => {
              const res = await ask({
                title: 'Cerrar sin más pasos',
                description:
                  'El expediente se cierra (por ejemplo, si habéis llegado a un acuerdo). La deuda sigue pendiente en sus facturas.',
                input: { label: 'Motivo', required: true },
                confirmLabel: 'Cerrar expediente',
                destructive: true,
              });
              if (res && res.value) {
                void run({ action: 'cancel', input: { reason: res.value } }, 'Expediente cerrado');
              }
            }}
          >
            Cerrar el expediente
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OverdueInvoices({ c }: { c: Case }) {
  if (c.invoices.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Facturas vencidas</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {c.invoices.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">
                {i.invoiceNumber}
              </Link>
              <span className="text-muted-foreground">Vencía el {formatDate(i.dueDate)}</span>
              <span className="font-semibold">{eur(i.pendingCents)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Evidence({ c, isClosed }: { c: Case; isClosed: boolean }) {
  const upload = useUploadCaseFile(c.id);
  const canManage = useHasPermission('collections:manage');
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileKind, setFileKind] = useState<CaseFileKind>(
    c.status === 'contract_resolved'
      ? 'inventory'
      : c.status === 'disposal' || c.status === 'goods_moved'
        ? 'disposal_act'
        : c.status === 'final_notice'
          ? 'burofax_receipt'
          : 'overlock_photo',
  );

  async function onUpload(file: File) {
    try {
      await upload.mutateAsync({ file, kind: fileKind });
      toast.success('Evidencia subida.');
    } catch (err) {
      if (err instanceof Error && err.message === 'unsupported_file_type') {
        toast.error('Formato no admitido: sube una foto (JPG, PNG o WebP) o un PDF.');
      } else {
        toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido subir.');
      }
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Evidencias</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isClosed && canManage && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={fileKind} onValueChange={(v) => setFileKind(v as CaseFileKind)}>
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILE_KINDS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {CASE_FILE_KIND_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
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
              Subir foto o PDF
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
                  {CASE_FILE_KIND_LABELS[f.kind as CaseFileKind] ?? f.kind}
                </div>
                <div className="text-muted-foreground">{formatDate(f.createdAt)}</div>
              </a>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Lo que dice cada evento, en palabras. */
function eventDetail(e: Case['events'][number]): string[] {
  const p = e.payload;
  const out: string[] = [];
  if (typeof p.note === 'string') out.push(p.note);
  if (typeof p.notes === 'string' && p.notes) out.push(p.notes);
  if (typeof p.priorNotice === 'string' && p.priorNotice)
    out.push(`Aviso previo: ${p.priorNotice}`);
  if (typeof p.tracking === 'string' && p.tracking) out.push(`Nº de envío: ${p.tracking}`);
  if (typeof p.deadline === 'string') out.push(`Plazo hasta el ${formatDate(p.deadline)}`);
  if (typeof p.custodyLocation === 'string') out.push(`Custodia: ${p.custodyLocation}`);
  if (typeof p.disposalType === 'string') {
    out.push(`Cauce: ${DISPOSAL_TYPE_LABELS[p.disposalType] ?? p.disposalType}`);
  }
  if (typeof p.file === 'string') {
    out.push(`Evidencia: ${CASE_FILE_KIND_LABELS[p.file as CaseFileKind] ?? p.file}`);
  }
  if (p.requirementPdf === true) out.push('Requerimiento (PDF) generado');
  if (typeof p.reason === 'string')
    out.push(`Motivo: ${CLOSE_REASON_LABELS[p.reason] ?? p.reason}`);
  const s = p.settlement as
    | {
        depositAppliedCents?: number;
        proceedsAppliedCents?: number;
        debtAfterCents?: number;
        surplusCents?: number;
        depositReturnedCents?: number;
      }
    | undefined;
  if (s) {
    out.push(
      `Fianza aplicada ${eur(s.depositAppliedCents ?? 0)} · obtenido aplicado ${eur(
        s.proceedsAppliedCents ?? 0,
      )} · sigue debiendo ${eur(s.debtAfterCents ?? 0)}`,
    );
    const back = (s.surplusCents ?? 0) + (s.depositReturnedCents ?? 0);
    if (back > 0) out.push(`A devolver al inquilino: ${eur(back)}`);
  }
  return out;
}

function History({ c, isClosed }: { c: Case; isClosed: boolean }) {
  const action = useCaseAction(c.id);
  const [note, setNote] = useState('');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Historial</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isClosed && (
          <Can permission="collections:manage">
            <div className="flex gap-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Añadir una nota al expediente…"
                rows={2}
                maxLength={2000}
              />
              <Button
                size="sm"
                disabled={!note.trim() || action.isPending}
                onClick={async () => {
                  try {
                    await action.mutateAsync({ action: 'note', input: { note: note.trim() } });
                    toast.success('Nota añadida');
                    setNote('');
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido.');
                  }
                }}
              >
                Añadir
              </Button>
            </div>
          </Can>
        )}
        <ol className="space-y-3">
          {c.events.map((e) => (
            <li key={e.id} className="flex gap-3 text-sm">
              <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
              <div className="min-w-0">
                <div className="font-medium">{CASE_EVENT_LABELS[e.eventType] ?? e.eventType}</div>
                {eventDetail(e).map((line, i) => (
                  <div key={i} className="break-words text-muted-foreground">
                    {line}
                  </div>
                ))}
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(e.occurredAt)}
                  {e.createdByName ? ` · ${e.createdByName}` : ''}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
