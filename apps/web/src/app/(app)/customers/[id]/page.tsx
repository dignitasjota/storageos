'use client';

import { ArrowLeft, BadgeCheck, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { CustomerChatTab } from './chat-tab';
import { CustomerCommunicationsTab } from './communications-tab';
import { CustomerContractsTab } from './contracts-tab';
import { CustomerDocumentsTab } from './documents-tab';
import { FollowupsCard } from './followups-card';
import { CustomerPaymentHistoryTab } from './payment-history-tab';
import { CustomerPaymentMethodsTab } from './payment-methods-tab';
import { PortalLinkButton } from './portal-link-button';
import { CustomerReservationsTab } from './reservations-tab';

import { Can } from '@/components/auth/can';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useCustomer, useCustomerUnreadSummary, useSetKycVerified } from '@/lib/customers/hooks';

/** Pestañas de la ficha del inquilino (orden = el de los TabsTrigger). En móvil
 *  se muestran como un desplegable en lugar de una tira de 9 pestañas. */
const CUSTOMER_TABS = [
  { value: 'contracts', label: 'Contratos' },
  { value: 'reservations', label: 'Reservas' },
  { value: 'documents', label: 'Documentos' },
  { value: 'communications', label: 'Comunicaciones' },
  { value: 'chat', label: 'Mensajes' },
  { value: 'followups', label: 'Seguimientos' },
  { value: 'history', label: 'Historial de pagos' },
  { value: 'payments', label: 'Métodos de pago' },
  { value: 'info', label: 'Datos' },
] as const;

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const customer = useCustomer(id);
  const unreadMessages = useCustomerUnreadSummary().data?.byCustomer[id ?? ''] ?? 0;
  const setKyc = useSetKycVerified();
  const [tab, setTab] = useState<string>('contracts');

  if (customer.isLoading || !customer.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  async function toggleKyc() {
    if (!customer.data) return;
    try {
      await setKyc.mutateAsync({
        id: customer.data.id,
        input: { verified: !customer.data.kycVerified },
      });
      toast.success(customer.data.kycVerified ? 'KYC revocado.' : 'KYC verificado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const c = customer.data;

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/customers">
            <ArrowLeft className="mr-1 h-4 w-4" /> Inquilinos
          </Link>
        </Button>
        {/* Datos del inquilino. Los badges van BAJO el nombre (con aire) para que
            respire, y las acciones debajo del todo (a ancho completo en móvil). */}
        <div className="mt-3">
          <h1 className="text-2xl font-semibold tracking-tight">{c.displayName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {c.customerType === 'business' ? 'Empresa' : 'Particular'}
            </Badge>
            <Badge variant={c.kycVerified ? 'default' : 'outline'}>
              {c.kycVerified ? 'KYC verificado' : 'KYC pendiente'}
            </Badge>
          </div>
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {c.email ?? '—'} · {c.phone ?? 'Sin teléfono'}
            {c.documentNumber && ` · ${c.documentType ?? 'Doc.'} ${c.documentNumber}`}
          </p>
        </div>

        {/* Acciones: a ancho completo y apiladas en móvil (grandes y cómodas),
            en fila a partir de sm. */}
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Can permission="customers:write">
            <PortalLinkButton
              customerId={c.id}
              portalAccessEnabled={c.portalAccessEnabled}
              className="w-full justify-center sm:w-auto"
            />
          </Can>
          <Button
            variant="outline"
            onClick={toggleKyc}
            disabled={setKyc.isPending}
            className="w-full justify-center sm:w-auto"
          >
            <BadgeCheck className="mr-1 h-4 w-4" />
            {c.kycVerified ? 'Revocar KYC' : 'Marcar KYC verificado'}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        {/* Móvil: desplegable (9 pestañas no caben cómodas en una tira). */}
        <div className="sm:hidden">
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOMER_TABS.map((t) => (
                <SelectItem key={t.value} value={t.value} textValue={t.label}>
                  <span className="flex items-center gap-1.5">
                    {t.label}
                    {t.value === 'chat' && unreadMessages > 0 && (
                      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
                        {unreadMessages}
                      </span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* Escritorio: pestañas normales. */}
        <TabsList className="hidden sm:inline-flex">
          <TabsTrigger value="contracts">Contratos</TabsTrigger>
          <TabsTrigger value="reservations">Reservas</TabsTrigger>
          <TabsTrigger value="documents">Documentos</TabsTrigger>
          <TabsTrigger value="communications">Comunicaciones</TabsTrigger>
          <TabsTrigger value="chat">
            Mensajes
            {unreadMessages > 0 && (
              <span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium text-white">
                {unreadMessages}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="followups">Seguimientos</TabsTrigger>
          <TabsTrigger value="history">Historial de pagos</TabsTrigger>
          <TabsTrigger value="payments">Métodos de pago</TabsTrigger>
          <TabsTrigger value="info">Datos</TabsTrigger>
        </TabsList>
        <TabsContent value="contracts" className="mt-6">
          <CustomerContractsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="reservations" className="mt-6">
          <CustomerReservationsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="documents" className="mt-6">
          <CustomerDocumentsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="communications" className="mt-6">
          <CustomerCommunicationsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="chat" className="mt-6">
          <CustomerChatTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="followups" className="mt-6">
          <FollowupsCard customerId={c.id} />
        </TabsContent>
        <TabsContent value="history" className="mt-6">
          <CustomerPaymentHistoryTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="payments" className="mt-6">
          <CustomerPaymentMethodsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="info" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Datos personales</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">Email</p>
                <p>{c.email ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Teléfono</p>
                <p>{c.phone ?? '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Dirección</p>
                <p>
                  {c.address ?? '—'}, {c.postalCode ?? ''} {c.city ?? ''} ({c.country})
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Documento</p>
                <p>
                  {c.documentType ?? '—'} {c.documentNumber ?? ''}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Contacto de emergencia</p>
                <p>
                  {c.emergencyContactName ?? '—'} {c.emergencyContactPhone ?? ''}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">Notas</p>
                <p>{c.notes ?? '—'}</p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
