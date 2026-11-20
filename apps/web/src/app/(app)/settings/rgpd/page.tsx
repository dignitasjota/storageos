'use client';

import { DataSubjectRequestTypeEnum, type DataSubjectRequestDto } from '@storageos/shared';
import { Download, Loader2, Plus, UserX } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { SettingsHeader } from '../settings-header';

import { useConfirm } from '@/components/confirm-provider';
import { CustomerSearchSelect } from '@/components/customer-search-select';
import { SectionError } from '@/components/dashboard/section-state';
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
import { formatDate, formatEur } from '@/lib/format';
import {
  useAnonymizeCustomer,
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
  const anonymize = useAnonymizeCustomer();
  const overdue = isOpen(r.status) && new Date(r.dueAt).getTime() < Date.now();
  const daysLeft = Math.ceil((new Date(r.dueAt).getTime() - Date.now()) / 86_400_000);

  async function setStatus(status: RequestStatus) {
    let notes: string | undefined;
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
          'Queda cerrada. Debes explicar al interesado el motivo y que puede reclamar ante la Agencia Española de Protección de Datos.',
        confirmLabel: 'Denegar',
        destructive: true,
        input: { label: 'Motivo', placeholder: 'Por qué no se atiende', required: true },
      });
      if (!ok) return;
      notes = [r.notes, `Denegada: ${ok.value}`].filter(Boolean).join('\n');
    }
    try {
      await update.mutateAsync({
        id: r.id,
        input: { status, ...(notes !== undefined ? { notes } : {}) },
      });
      toast.success('Solicitud actualizada.');
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

  async function onAnonymize() {
    if (!r.customerId) return;
    const ok = await ask({
      title: '¿Anonimizar al inquilino?',
      description:
        'Se borran sus datos personales, documentos, accesos y mensajes. Las facturas se conservan (obligación fiscal). No se puede deshacer.',
      confirmLabel: 'Anonimizar',
      destructive: true,
    });
    if (!ok) return;
    try {
      try {
        await anonymize.mutateAsync({ customerId: r.customerId, requestId: r.id });
      } catch (err) {
        if (!(err instanceof ApiError) || err.body.code !== 'customer_has_debt') throw err;
        const amount = Number((err.body.details as { amount?: number } | undefined)?.amount ?? 0);
        const again = await ask({
          title: 'Tiene facturas pendientes de cobro',
          description: `Debe ${formatEur(amount)}. Si lo anonimizas, las facturas se conservan pero ya no podrás reclamárselas a su nombre.`,
          confirmLabel: 'Anonimizar igualmente',
          destructive: true,
        });
        if (!again) return;
        await anonymize.mutateAsync({
          customerId: r.customerId,
          requestId: r.id,
          confirmDebt: true,
        });
      }
      toast.success('Inquilino anonimizado y solicitud atendida.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo anonimizar.');
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
        Recibida el {formatDate(r.submittedAt)} · responder antes del {formatDate(r.dueAt)}
        {r.fulfilledAt ? ` · cerrada el ${formatDate(r.fulfilledAt)}` : ''}
      </p>
      {r.notes && <p className="whitespace-pre-wrap text-xs">{r.notes}</p>}
      {isOpen(r.status) && (
        <div className="flex flex-wrap gap-2">
          {r.customerId && (r.requestType === 'access' || r.requestType === 'portability') && (
            <Button size="sm" variant="outline" onClick={() => void onExport()}>
              <Download className="mr-1 size-4" /> Descargar sus datos
            </Button>
          )}
          {r.customerId && r.requestType === 'erasure' && (
            <Button size="sm" variant="destructive" onClick={() => void onAnonymize()}>
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
  const customer = useCustomer(customerId);

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
      });
      toast.success('Solicitud registrada: tienes un mes para responder.');
      setCustomerId(undefined);
      setEmail('');
      setNotes('');
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
          <Button onClick={() => void submit()} disabled={create.isPending || !email.includes('@')}>
            {create.isPending && <Loader2 className="mr-1 size-4 animate-spin" />}
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
