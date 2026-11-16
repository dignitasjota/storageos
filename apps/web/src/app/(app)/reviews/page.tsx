'use client';

import {
  REVIEW_EXIT_REASON_LABELS,
  type ReviewDto,
  type ReviewExitReason,
} from '@storageos/shared';
import { Loader2, Plus, Star } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/auth/api';
import { useHasPermission } from '@/lib/auth/hooks';
import { useCommunicationChannels } from '@/lib/communications/hooks';
import { useCustomers } from '@/lib/customers/hooks';
import { useFacilities } from '@/lib/facilities/hooks';
import { formatDate } from '@/lib/format';
import {
  useRequestReview,
  usePublishReview,
  useRequestGoogleReview,
  useResendReview,
  useReviewInsights,
  useReviews,
  useReviewStats,
  useReviewsSettings,
  useUpdateReviewsSettings,
} from '@/lib/reviews/hooks';

const STATUS_LABELS: Record<
  ReviewDto['status'],
  { label: string; variant: 'default' | 'secondary' | 'outline' }
> = {
  pending: { label: 'Pendiente', variant: 'secondary' },
  submitted: { label: 'Recibida', variant: 'default' },
  expired: { label: 'Caducada', variant: 'outline' },
};

/** Mismo azul que las gráficas de Analítica. */
const NPS_LINE = '#2a78d6';

function shortMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
}

export default function ReviewsPage() {
  // Periodo y local de las cifras (el historial de abajo es siempre completo).
  const [months, setMonths] = useState<'all' | '3' | '6' | '12'>('all');
  const [facilityId, setFacilityId] = useState('all');
  const facilities = useFacilities();
  const period = {
    months: months === 'all' ? undefined : Number(months),
    facilityId: facilityId === 'all' ? undefined : facilityId,
  };
  const stats = useReviewStats(period);
  const insights = useReviewInsights({
    months: period.months ?? 12,
    facilityId: period.facilityId,
  });
  const [status, setStatus] = useState<'all' | ReviewDto['status']>('all');
  const reviews = useReviews(status === 'all' ? undefined : status);
  const items = reviews.data?.pages.flatMap((p) => p.items) ?? [];
  const canWrite = useHasPermission('reviews:write');
  const canPublish = canWrite;
  const canManageSettings = useHasPermission('settings:manage');

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Valoraciones</h1>
          <p className="text-sm text-muted-foreground">
            Mide la satisfacción de tus inquilinos con NPS y recoge reseñas.
          </p>
        </div>
        {canWrite && <RequestReviewDialog />}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select value={months} onValueChange={(v) => setMonths(v as typeof months)}>
          <SelectTrigger className="h-9 w-48" aria-label="Periodo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Desde el principio</SelectItem>
            <SelectItem value="3">Últimos 3 meses</SelectItem>
            <SelectItem value="6">Últimos 6 meses</SelectItem>
            <SelectItem value="12">Últimos 12 meses</SelectItem>
          </SelectContent>
        </Select>
        {(facilities.data ?? []).length > 1 && (
          <Select value={facilityId} onValueChange={setFacilityId}>
            <SelectTrigger className="h-9 w-52" aria-label="Local">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los locales</SelectItem>
              {(facilities.data ?? []).map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {stats.isError && <SectionError onRetry={() => void stats.refetch()} />}
      <div className={`grid grid-cols-2 gap-3 sm:grid-cols-4 ${stats.isError ? 'hidden' : ''}`}>
        <StatCard
          title="NPS"
          value={stats.data?.npsScore ?? null}
          hint={stats.data ? `${stats.data.submitted} respuestas` : ''}
          loading={stats.isLoading}
        />
        <StatCard
          title="Valoración media"
          value={stats.data?.avgRating ?? null}
          suffix="★"
          loading={stats.isLoading}
        />
        <StatCard
          title="Tasa de respuesta"
          value={stats.data?.responseRate ?? null}
          suffix="%"
          loading={stats.isLoading}
        />
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Reparto NPS</CardTitle>
          </CardHeader>
          <CardContent className="text-xs">
            {stats.isLoading || !stats.data ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <div className="flex flex-col gap-0.5">
                <span className="text-green-600">Promotores: {stats.data.promoters}</span>
                <span className="text-muted-foreground">Pasivos: {stats.data.passives}</span>
                <span className="text-red-600">Detractores: {stats.data.detractors}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {insights.data && <NpsTrendCard data={insights.data} />}

      {canManageSettings && <AutoRequestSettings />}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Historial</h2>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
            <SelectTrigger className="h-9 w-44" aria-label="Estado">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas</SelectItem>
              <SelectItem value="submitted">Recibidas</SelectItem>
              <SelectItem value="pending">Pendientes</SelectItem>
              <SelectItem value="expired">Caducadas</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {reviews.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : reviews.isError ? (
          <SectionError onRetry={() => void reviews.refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {status === 'all'
              ? 'Aún no has solicitado ninguna valoración.'
              : 'No hay valoraciones en ese estado.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Inquilino</th>
                  <th className="px-3 py-2">Contrato</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">NPS</th>
                  <th className="px-3 py-2">Estrellas</th>
                  <th className="px-3 py-2">Comentario</th>
                  <th className="px-3 py-2">Fecha</th>
                  <th className="px-3 py-2">En la web</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <ReviewRow key={r.id} review={r} canPublish={canPublish} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reviews.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              disabled={reviews.isFetchingNextPage}
              onClick={() => void reviews.fetchNextPage()}
            >
              {reviews.isFetchingNextPage ? 'Cargando...' : 'Cargar más'}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/** NPS de cada mes (por el mes de la respuesta) y por local. */
function NpsTrendCard({
  data,
}: {
  data: NonNullable<ReturnType<typeof useReviewInsights>['data']>;
}) {
  const withAnswers = data.trend.filter((m) => m.responses > 0);
  if (withAnswers.length === 0) return null;
  const chartData = data.trend.map((m) => ({
    mes: shortMonth(m.month),
    NPS: m.nps,
    respuestas: m.responses,
  }));
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">NPS mes a mes</CardTitle>
        <CardDescription>
          Según el mes en que respondieron. Por encima de 0 hay más promotores que detractores.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {withAnswers.length > 1 && (
          <div className="h-56">
            <ResponsiveContainer
              width="100%"
              height="100%"
              initialDimension={{ width: 300, height: 224 }}
            >
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                <YAxis
                  domain={[-100, 100]}
                  ticks={[-100, -50, 0, 50, 100]}
                  tick={{ fontSize: 11 }}
                />
                <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.35} />
                <Tooltip
                  formatter={(v, _name, item) => [
                    `${Number(v)} (${(item.payload as { respuestas: number }).respuestas} respuestas)`,
                    'NPS',
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="NPS"
                  stroke={NPS_LINE}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3">Mes</th>
                  <th className="py-1.5 pr-3">Respuestas</th>
                  <th className="py-1.5 pr-3">NPS</th>
                  <th className="py-1.5">Estrellas</th>
                </tr>
              </thead>
              <tbody>
                {[...withAnswers].reverse().map((m) => (
                  <tr key={m.month} className="border-b last:border-b-0">
                    <td className="py-1.5 pr-3">{shortMonth(m.month)}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.responses}</td>
                    <td className="py-1.5 pr-3 tabular-nums">{m.nps ?? '—'}</td>
                    <td className="py-1.5 tabular-nums">{m.avgRating ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.byFacility.length > 1 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3">Local</th>
                    <th className="py-1.5 pr-3">Respuestas</th>
                    <th className="py-1.5 pr-3">NPS</th>
                    <th className="py-1.5">Estrellas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byFacility.map((f) => (
                    <tr key={f.facilityId} className="border-b last:border-b-0">
                      <td className="py-1.5 pr-3">{f.facilityName}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{f.responses}</td>
                      <td className="py-1.5 pr-3 tabular-nums">{f.nps ?? '—'}</td>
                      <td className="py-1.5 tabular-nums">{f.avgRating ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatCard({
  title,
  value,
  suffix,
  hint,
  loading,
}: {
  title: string;
  value: number | null;
  suffix?: string;
  hint?: string;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-normal text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <div className="text-2xl font-semibold">
              {value === null ? '—' : value}
              {value !== null && suffix ? (
                <span className="ml-0.5 text-base text-muted-foreground">{suffix}</span>
              ) : null}
            </div>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewRow({ review, canPublish }: { review: ReviewDto; canPublish: boolean }) {
  const s = STATUS_LABELS[review.status];
  const publish = usePublishReview();
  const google = useRequestGoogleReview();
  const resend = useResendReview();
  const publishable = review.status === 'submitted' && !!review.comment?.trim();
  // Sin el permiso de su autor no se publica (las ya publicadas se pueden retirar).
  const noConsent = publishable && !review.publishConsent && !review.publishedOnWeb;
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2 font-medium">
        <Link href={`/customers/${review.customerId}`} className="hover:underline">
          {review.customerName}
        </Link>
        {review.exit && (
          <div className="text-xs font-normal text-muted-foreground">
            Encuesta de salida
            {review.exitReason
              ? ` · ${REVIEW_EXIT_REASON_LABELS[review.exitReason as ReviewExitReason] ?? review.exitReason}`
              : ''}
          </div>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{review.contractNumber ?? '—'}</td>
      <td className="px-3 py-2">
        <Badge variant={s.variant}>{s.label}</Badge>
        {review.status === 'pending' && review.remindedAt && (
          <div className="mt-1 text-xs text-muted-foreground">
            Recordada el {formatDate(review.remindedAt)}
          </div>
        )}
        {review.status !== 'submitted' && canPublish && (
          <div className="mt-1 flex flex-wrap gap-x-2 text-xs">
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
              disabled={resend.isPending}
              onClick={async () => {
                try {
                  await resend.mutateAsync(review.id);
                  toast.success('Se la hemos vuelto a enviar.');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
                }
              }}
            >
              Reenviar
            </button>
            {review.reviewUrl && (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  void navigator.clipboard?.writeText(review.reviewUrl ?? '');
                  toast.success('Enlace copiado.');
                }}
              >
                Copiar enlace
              </button>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        {review.npsScore === null ? (
          '—'
        ) : (
          <span
            className={
              review.npsScore >= 9
                ? 'text-green-600'
                : review.npsScore <= 6
                  ? 'text-red-600'
                  : 'text-muted-foreground'
            }
          >
            {review.npsScore}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        {review.rating ? (
          <span className="inline-flex items-center gap-0.5">
            {review.rating}
            <Star className="size-3 fill-yellow-400 text-yellow-400" />
          </span>
        ) : (
          '—'
        )}
      </td>
      <td
        className="max-w-[280px] truncate px-3 py-2 text-muted-foreground"
        title={review.comment ?? ''}
      >
        {review.comment ?? '—'}
        {review.status === 'submitted' && review.npsScore !== null && review.npsScore <= 6 && (
          <div className="mt-0.5 text-xs">
            <Link
              href={`/customers/${review.customerId}?tab=chat`}
              className="text-primary underline-offset-2 hover:underline"
            >
              Responder
            </Link>
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground">{formatDate(review.createdAt)}</td>
      <td className="px-3 py-2">
        {noConsent ? (
          <span className="text-xs text-muted-foreground">Sin permiso para publicarla</span>
        ) : publishable ? (
          <label className="inline-flex items-center gap-2 text-xs">
            <Checkbox
              checked={review.publishedOnWeb}
              disabled={!canPublish || publish.isPending}
              onCheckedChange={async (v) => {
                try {
                  await publish.mutateAsync({ id: review.id, published: v === true });
                  toast.success(v === true ? 'Publicada en tu web.' : 'Retirada de tu web.');
                } catch (err) {
                  toast.error(err instanceof ApiError ? err.body.message : 'No se pudo cambiar');
                }
              }}
              aria-label="Mostrar en la web"
            />
            {review.publishedOnWeb ? 'Publicada' : 'No'}
          </label>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {review.publishedOnWeb && (
          <div className="mt-1 text-xs">
            {review.googleRequestedAt ? (
              <span className="text-muted-foreground">
                Reseña en Google pedida el {formatDate(review.googleRequestedAt)}
              </span>
            ) : canPublish ? (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
                disabled={google.isPending}
                onClick={async () => {
                  try {
                    await google.mutateAsync(review.id);
                    toast.success('Le hemos pedido que la deje también en Google.');
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar');
                  }
                }}
              >
                Pedir reseña en Google
              </button>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}

function RequestReviewDialog() {
  const [open, setOpen] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [channel, setChannel] = useState<'email' | 'whatsapp'>('email');
  const [search, setSearch] = useState('');
  const customers = useCustomers(search);
  const request = useRequestReview();
  const whatsappOn = useCommunicationChannels().data?.whatsapp ?? true;

  async function submit() {
    if (!customerId) {
      toast.error('Selecciona un inquilino.');
      return;
    }
    try {
      const res = await request.mutateAsync({ customerId, channel });
      toast.success(
        res.enqueued
          ? 'Solicitud de valoración enviada.'
          : 'Solicitud creada, pero no se pudo enviar: copia el enlace del historial.',
      );
      setOpen(false);
      setCustomerId('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-1 h-4 w-4" /> Solicitar valoración
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Solicitar valoración</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Inquilino</Label>
            <Input
              placeholder="Buscar inquilino..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={customerId} onValueChange={setCustomerId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecciona un inquilino" />
              </SelectTrigger>
              <SelectContent>
                {(customers.data ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.displayName}
                    {c.email ? ` · ${c.email}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Canal</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as 'email' | 'whatsapp')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="whatsapp" disabled={!whatsappOn}>
                  WhatsApp{whatsappOn ? '' : ' (no configurado)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={request.isPending}>
            {request.isPending ? 'Enviando...' : 'Enviar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AutoRequestSettings() {
  const settings = useReviewsSettings();
  const update = useUpdateReviewsSettings();
  const [delay, setDelay] = useState<number | null>(null);
  const [googleUrl, setGoogleUrl] = useState<string | null>(null);

  const enabled = settings.data?.reviewsAutoRequest ?? false;
  const delayValue = delay ?? settings.data?.reviewRequestDelayDays ?? 14;
  const googleUrlValue = googleUrl ?? settings.data?.googleReviewUrl ?? '';

  async function saveGoogleUrl() {
    if (googleUrl === null || googleUrl === (settings.data?.googleReviewUrl ?? '')) return;
    try {
      await update.mutateAsync({ googleReviewUrl: googleUrl });
      toast.success('Enlace de Google guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'URL no válida.');
    }
  }

  async function toggle(next: {
    reviewsReminderEnabled?: boolean;
    reviewsYearlyEnabled?: boolean;
  }) {
    try {
      await update.mutateAsync(next);
      toast.success('Ajustes guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function save(next: { reviewsAutoRequest: boolean; reviewRequestDelayDays: number }) {
    try {
      await update.mutateAsync(next);
      toast.success('Ajustes guardados.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Solicitudes automáticas</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2">
          <Checkbox
            id="auto-request"
            checked={enabled}
            disabled={settings.isLoading || update.isPending}
            onCheckedChange={(v) =>
              save({ reviewsAutoRequest: v === true, reviewRequestDelayDays: delayValue })
            }
          />
          <div className="space-y-0.5">
            <Label htmlFor="auto-request">Pedir valoración automáticamente tras firmar</Label>
            <p className="text-xs text-muted-foreground">
              Se envía un email al inquilino transcurridos los días indicados desde la firma del
              contrato.
            </p>
          </div>
        </div>
        {enabled && (
          <div className="flex items-center gap-2">
            <Label htmlFor="delay" className="text-sm">
              Días tras la firma:
            </Label>
            <Input
              id="delay"
              type="number"
              min={1}
              max={180}
              className="w-24"
              value={delayValue}
              onChange={(e) => setDelay(Number(e.target.value))}
              onBlur={() =>
                delay !== null &&
                delay !== settings.data?.reviewRequestDelayDays &&
                save({ reviewsAutoRequest: true, reviewRequestDelayDays: delayValue })
              }
            />
          </div>
        )}
        <div className="space-y-3 border-t pt-3">
          <div className="flex items-start gap-2">
            <Checkbox
              id="reviews-reminder"
              checked={settings.data?.reviewsReminderEnabled ?? false}
              disabled={settings.isLoading || update.isPending}
              onCheckedChange={(v) => toggle({ reviewsReminderEnabled: v === true })}
            />
            <div className="space-y-0.5">
              <Label htmlFor="reviews-reminder">Recordar a quien no responde</Label>
              <p className="text-xs text-muted-foreground">
                Un solo recordatorio, a los 7 días de pedírsela.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="reviews-yearly"
              checked={settings.data?.reviewsYearlyEnabled ?? false}
              disabled={settings.isLoading || update.isPending}
              onCheckedChange={(v) => toggle({ reviewsYearlyEnabled: v === true })}
            />
            <div className="space-y-0.5">
              <Label htmlFor="reviews-yearly">Volver a preguntar cada año</Label>
              <p className="text-xs text-muted-foreground">
                A los inquilinos que llevan más de un año y a los que no se les ha pedido ninguna
                valoración en los últimos 12 meses.
              </p>
            </div>
          </div>
        </div>
        <div className="space-y-1 border-t pt-3">
          <Label htmlFor="google-url" className="text-sm">
            Enlace de reseña en Google (opcional)
          </Label>
          <Input
            id="google-url"
            type="url"
            placeholder="https://g.page/r/.../review"
            value={googleUrlValue}
            onChange={(e) => setGoogleUrl(e.target.value)}
            onBlur={saveGoogleUrl}
          />
          <p className="text-xs text-muted-foreground">
            Tras una valoración positiva (NPS 9-10), se invita al inquilino a dejar una reseña en
            Google con este enlace — mejora tu ranking local.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
