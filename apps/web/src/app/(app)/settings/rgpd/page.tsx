'use client';

import {
  DATA_SUBJECT_REQUEST_MAX_BACKDATE_DAYS,
  DataSubjectRequestTypeEnum,
  type DataSubjectRequestDto,
} from '@storageos/shared';
import { Download, Loader2, Plus, UserX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
import { DateSelect } from '@/components/month-year-select';
import { AnonymizeCustomerDialog } from '@/components/rgpd/anonymize-customer-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import { useDataSubjectRequests } from '@/lib/billing/hooks';
import { useCustomer } from '@/lib/customers/hooks';
import { localDateString } from '@/lib/dates';
import { formatDate } from '@/lib/format';
import {
  useCreateDataSubjectRequest,
  useExportCustomerData,
  useUpdateDataSubjectRequest,
} from '@/lib/rgpd/hooks';

type RequestType = DataSubjectRequestDto['requestType'];
type RequestStatus = DataSubjectRequestDto['status'];

const RGPD_TYPE_LABELS: Record<RequestType, string> = {
  access: 'Acceso a sus datos',
  rectification: 'Rectificación',
  erasure: 'Supresión (olvido)',
  portability: 'Portabilidad',
  restriction: 'Limitación del tratamiento',
};

const STATUS_LABELS: Record<RequestStatus, string> = {
  open: 'Recibida',
  in_progress: 'En curso',
  fulfilled: 'Atendida',
  denied: 'Denegada',
};

const isOpen = (s: RequestStatus) => s === 'open' || s === 'in_progress';

/** Solicitudes de inquilinos sobre sus datos personales (plazo legal de un mes). */
export default function RgpdSettingsPage() {
  const requests = useDataSubjectRequests();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const all = requests.data ?? [];
  const openCount = all.filter((r) => isOpen(r.status)).length;
  const overdueCount = all.filter(
    (r) => isOpen(r.status) && new Date(r.dueAt).getTime() < Date.now(),
  ).length;
  const rows = filter === 'open' ? all.filter((r) => isOpen(r.status)) : all;

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Protección de datos"
        description="Las peticiones de tus inquilinos sobre sus datos personales: acceso, portabilidad, rectificación o borrado. La ley da un mes para responder."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={filter === 'open' ? 'default' : 'outline'}
            onClick={() => setFilter('open')}
          >
            Sin cerrar ({openCount})
          </Button>
          <Button
            size="sm"
            variant={filter === 'all' ? 'default' : 'outline'}
            onClick={() => setFilter('all')}
          >
            Todas ({all.length})
          </Button>
          {overdueCount > 0 && (
            <Badge variant="destructive" className="self-center">
              {overdueCount} fuera de plazo
            </Badge>
          )}
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1 size-4" /> Registrar solicitud
        </Button>
      </div>
      {requests.isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : requests.isError ? (
        <Card>
          <CardContent>
            <SectionError onRetry={() => void requests.refetch()} />
          </CardContent>
        </Card>
      ) : rows.length === 0 && all.length > 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hay solicitudes sin cerrar.
          </CardContent>
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No hay solicitudes. Cuando un inquilino te pida sus datos o que los borres, regístrala
            aquí para atenderla en plazo y que quede constancia.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <RequestRow key={r.id} request={r} />
          ))}
        </ul>
      )}
      <CreateRequestDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function RequestRow({ request: r }: { request: DataSubjectRequestDto }) {
  const ask = useConfirm();
  const update = useUpdateDataSubjectRequest();
  const exportData = useExportCustomerData();
  const [anonymizing, setAnonymizing] = useState(false);
  const overdue = isOpen(r.status) && new Date(r.dueAt).getTime() < Date.now();
  const daysLeft = Math.ceil((new Date(r.dueAt).getTime() - Date.now()) / 86_400_000);

  async function setStatus(status: RequestStatus) {
    let rejectionReason: string | undefined;
    if (status === 'fulfilled') {
      const ok = await ask({
        title: '¿Marcar la solicitud como atendida?',
        description: 'Queda cerrada con la fecha de hoy. Hazlo cuando ya le hayas respondido.',
        confirmLabel: 'Marcar atendida',
      });
      if (!ok) return;
    }
    if (status === 'denied') {
      const ok = await ask({
        title: '¿Denegar la solicitud?',
        description:
          'Queda cerrada y le enviamos un correo a ' +
          r.email +
          ' con el motivo y que puede reclamar ante la Agencia Española de Protección de Datos.',
        confirmLabel: 'Denegar y avisar',
        destructive: true,
        input: {
          label: 'Motivo (lo leerá el interesado)',
          placeholder: 'Por qué no se puede atender',
          required: true,
        },
      });
      if (!ok) return;
      rejectionReason = ok.value.trim();
      if (rejectionReason.length < 3) {
        toast.error('Explica por qué se deniega la solicitud.');
        return;
      }
    }
    try {
      await update.mutateAsync({
        id: r.id,
        input: { status, ...(rejectionReason !== undefined ? { rejectionReason } : {}) },
      });
      toast.success(
        status === 'denied' ? 'Solicitud denegada y aviso enviado.' : 'Solicitud actualizada.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo actualizar.');
    }
  }

  async function onExport() {
    if (!r.customerId) return;
    try {
      await exportData.mutateAsync(r.customerId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo exportar.');
    }
  }

  return (
    <li className="space-y-2 rounded-lg border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{RGPD_TYPE_LABELS[r.requestType]}</p>
          <p className="truncate text-muted-foreground">
            {r.customerId ? (
              <Link href={`/customers/${r.customerId}`} className="hover:underline">
                {r.customerName ? `${r.customerName} · ${r.email}` : r.email}
              </Link>
            ) : (
              r.email
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overdue && <Badge variant="destructive">Fuera de plazo</Badge>}
          {isOpen(r.status) && !overdue && daysLeft <= 7 && (
            <Badge variant="secondary">
              {daysLeft <= 1 ? 'Vence mañana' : `Quedan ${daysLeft} días`}
            </Badge>
          )}
          <Badge variant={isOpen(r.status) ? 'secondary' : 'outline'}>
            {STATUS_LABELS[r.status]}
          </Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Recibida el {formatDate(r.receivedAt ?? r.submittedAt)}
        {r.receivedAt && r.receivedAt.slice(0, 10) !== r.submittedAt.slice(0, 10)
          ? ` (registrada el ${formatDate(r.submittedAt)})`
          : ''}{' '}
        · responder antes del {formatDate(r.dueAt)}
        {r.fulfilledAt ? ` · cerrada el ${formatDate(r.fulfilledAt)}` : ''}
      </p>
      {r.status === 'denied' && r.rejectionReason && (
        <p className="whitespace-pre-wrap text-xs">
          <span className="font-medium">Motivo de la denegación:</span> {r.rejectionReason}
        </p>
      )}
      {r.notes && <p className="whitespace-pre-wrap text-xs">{r.notes}</p>}
      {isOpen(r.status) && (
        <div className="flex flex-wrap gap-2">
          {r.customerId && (r.requestType === 'access' || r.requestType === 'portability') && (
            <Button size="sm" variant="outline" onClick={() => void onExport()}>
              <Download className="mr-1 size-4" /> Descargar sus datos
            </Button>
          )}
          {r.customerId && r.requestType === 'erasure' && (
            <Button size="sm" variant="destructive" onClick={() => setAnonymizing(true)}>
              <UserX className="mr-1 size-4" /> Anonimizar
            </Button>
          )}
          {r.status === 'open' && (
            <Button size="sm" variant="outline" onClick={() => void setStatus('in_progress')}>
              Marcar en curso
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void setStatus('fulfilled')}>
            Marcar atendida
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void setStatus('denied')}>
            Denegar
          </Button>
        </div>
      )}
      {r.customerId && r.requestType === 'erasure' && (
        <AnonymizeCustomerDialog
          customerId={r.customerId}
          requestId={r.id}
          open={anonymizing}
          onOpenChange={setAnonymizing}
        />
      )}
    </li>
  );
}

function CreateRequestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateDataSubjectRequest();
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [email, setEmail] = useState('');
  const [type, setType] = useState<RequestType>('access');
  const [notes, setNotes] = useState('');
  const [receivedAt, setReceivedAt] = useState<string | undefined>(() => localDateString());
  const customer = useCustomer(customerId);
  const today = localDateString();
  const oldest = localDateString(
    new Date(Date.now() - DATA_SUBJECT_REQUEST_MAX_BACKDATE_DAYS * 86_400_000),
  );
  const receivedError =
    receivedAt && receivedAt > today
      ? 'No puede ser posterior a hoy.'
      : receivedAt && receivedAt < oldest
        ? `Como mucho, de hace ${DATA_SUBJECT_REQUEST_MAX_BACKDATE_DAYS} días.`
        : null;

  // Al elegir otro inquilino se pone su email (antes se quedaba el del primero).
  useEffect(() => {
    if (customer.data?.id === customerId && customer.data?.email) setEmail(customer.data.email);
  }, [customer.data, customerId]);

  async function submit() {
    try {
      await create.mutateAsync({
        email: email.trim(),
        requestType: type,
        ...(customerId ? { customerId } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(receivedAt ? { receivedAt } : {}),
      });
      toast.success('Solicitud registrada: tienes un mes para responder.');
      setCustomerId(undefined);
      setEmail('');
      setNotes('');
      setReceivedAt(localDateString());
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo registrar.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar solicitud</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Inquilino (si lo es)</Label>
            <CustomerSearchSelect
              value={customerId}
              onChange={setCustomerId}
              clearLabel="No es inquilino"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rgpd-email">Email de quien lo pide</Label>
            <Input
              id="rgpd-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="rgpd-type">Qué pide</Label>
            <Select value={type} onValueChange={(v) => setType(v as RequestType)}>
              <SelectTrigger id="rgpd-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DataSubjectRequestTypeEnum.options.map((t) => (
                  <SelectItem key={t} value={t}>
                    {RGPD_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Cuándo llegó</Label>
            <DateSelect value={receivedAt} onChange={setReceivedAt} years={2} />
            {receivedError ? (
              <p className="text-xs text-destructive">{receivedError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                El mes para responder cuenta desde este día.
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="rgpd-notes">Notas (opcional)</Label>
            <Textarea
              id="rgpd-notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={create.isPending || !email.includes('@') || !!receivedError}
          >
            {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
