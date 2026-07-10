'use client';

import { Loader2, Plus, Star } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ReviewDto } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { useCustomers } from '@/lib/customers/hooks';
import {
  useRequestReview,
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

export default function ReviewsPage() {
  const stats = useReviewStats();
  const reviews = useReviews();
  const canWrite = useHasPermission('reviews:write');
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

      {canManageSettings && <AutoRequestSettings />}

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Historial</h2>
        {reviews.isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (reviews.data?.items ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no has solicitado ninguna valoración.</p>
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
                </tr>
              </thead>
              <tbody>
                {(reviews.data?.items ?? []).map((r) => (
                  <ReviewRow key={r.id} review={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
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

function ReviewRow({ review }: { review: ReviewDto }) {
  const s = STATUS_LABELS[review.status];
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2 font-medium">{review.customerName}</td>
      <td className="px-3 py-2 font-mono text-xs">{review.contractNumber ?? '—'}</td>
      <td className="px-3 py-2">
        <Badge variant={s.variant}>{s.label}</Badge>
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
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {new Date(review.createdAt).toLocaleDateString('es-ES')}
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

  async function submit() {
    if (!customerId) {
      toast.error('Selecciona un inquilino.');
      return;
    }
    try {
      const res = await request.mutateAsync({ customerId, channel });
      toast.success(res.enqueued ? 'Solicitud de valoración enviada.' : 'Solicitud creada.');
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
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
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
        <CardTitle className="text-base">Solicitud automática</CardTitle>
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
