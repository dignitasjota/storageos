'use client';

import { ArrowLeft, BadgeCheck, Loader2, MoreHorizontal, Pencil, Send } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { CustomerAccessTab } from './access-tab';
import { CustomerAccountCard } from './account-card';
import { AuthorizedPersonsTab } from './authorized-persons-tab';
import { CustomerChatTab } from './chat-tab';
import { CustomerCommunicationsTab } from './communications-tab';
import { CustomerContactsTab } from './contacts-tab';
import { CustomerContractsTab } from './contracts-tab';
import { DepositExemptCard } from './deposit-exempt-card';
import { CustomerDocumentsTab } from './documents-tab';
import { EditCustomerDialog } from './edit-customer-dialog';
import { EmailStatusCard } from './email-status-card';
import { FollowupsCard } from './followups-card';
import { CustomerInsightsStrip } from './insights-strip';
import { MarketingPreferenceCard } from './marketing-preference-card';
import { MergeCustomerDialog } from './merge-dialog';
import { CustomerMessageDialog } from './message-dialog';
import { CustomerPaymentHistoryTab } from './payment-history-tab';
import { CustomerPaymentMethodsTab } from './payment-methods-tab';
import { PortalLinkButton } from './portal-link-button';
import { QuickContact } from './quick-contact';
import { CustomerReservationsTab } from './reservations-tab';
import { CustomerTimelineTab } from './timeline-tab';

import { Can } from '@/components/auth/can';
import { useConfirm } from '@/components/confirm-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useCustomer, useCustomerUnreadSummary, useSetKycVerified } from '@/lib/customers/hooks';
import { useAnonymizeCustomer, useExportCustomerData } from '@/lib/rgpd/hooks';

/** Pestañas de la ficha del inquilino (orden = el de los TabsTrigger). En móvil
 *  se muestran como un desplegable en lugar de una tira de 9 pestañas. */
const CUSTOMER_TABS = [
  { value: 'contracts', label: 'Contratos' },
  { value: 'timeline', label: 'Cronología' },
  { value: 'reservations', label: 'Reservas' },
  { value: 'documents', label: 'Documentos' },
  { value: 'communications', label: 'Comunicaciones' },
  { value: 'chat', label: 'Mensajes' },
  { value: 'followups', label: 'Seguimientos' },
  { value: 'authorized', label: 'Autorizados' },
  { value: 'contacts', label: 'Contactos' },
  { value: 'access', label: 'Accesos' },
  { value: 'history', label: 'Historial de pagos' },
  { value: 'payments', label: 'Métodos de pago' },
  { value: 'info', label: 'Datos' },
] as const;

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const customer = useCustomer(id);
  const hasAccessControl = useHasFeature('access_control');
  const canReadAccess = useHasPermission('access:read');
  const canSeeAccess = hasAccessControl && canReadAccess;
  const unreadMessages = useCustomerUnreadSummary().data?.byCustomer[id ?? ''] ?? 0;
  const setKyc = useSetKycVerified();
  const ask = useConfirm();
  const canReadInvoices = useHasPermission('invoices:read');
  const canReadPayments = useHasPermission('payments:read');
  const canMerge = useHasPermission('customers:delete');
  const canRgpd = useHasPermission('rgpd:manage');
  const exportData = useExportCustomerData();
  const anonymize = useAnonymizeCustomer();
  const router = useRouter();
  const [dialog, setDialog] = useState<'edit' | 'message' | 'merge' | null>(null);
  const [tab, setTab] = useState<string>(useSearchParams().get('tab') ?? 'contracts');
  // Los avisos enlazan a una pestaña concreta (`?tab=chat`).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted) setTab(wanted);
  }, []);

  if (customer.isError) {
    return (
      <div className="space-y-3 px-4 py-12 text-center sm:px-6">
        <p className="text-sm text-muted-foreground">
          {customer.error instanceof ApiError && customer.error.statusCode === 404
            ? 'Este inquilino no existe o se ha borrado.'
            : 'No se ha podido cargar el inquilino.'}
        </p>
        <Button variant="outline" asChild>
          <Link href="/customers">Volver a Inquilinos</Link>
        </Button>
      </div>
    );
  }
  if (customer.isLoading || !customer.data) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  async function downloadData() {
    try {
      await exportData.mutateAsync(id!);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron descargar.');
    }
  }

  async function anonymizeCustomer() {
    const ok = await ask({
      title: '¿Anonimizar a este inquilino?',
      description:
        'Se borran sus datos personales, documentos y accesos. Las facturas se conservan por obligación fiscal. No se puede deshacer.',
      confirmLabel: 'Anonimizar',
      destructive: true,
    });
    if (!ok) return;
    try {
      await anonymize.mutateAsync({ customerId: id! });
      toast.success('Inquilino anonimizado.');
      router.push('/customers');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo anonimizar.');
    }
  }

  async function toggleKyc() {
    if (!customer.data) return;
    if (
      customer.data.kycVerified &&
      !(await ask({
        title: 'Revocar la verificación',
        description: 'El inquilino volverá a figurar con el KYC pendiente.',
        confirmLabel: 'Revocar',
        destructive: true,
      }))
    ) {
      return;
    }
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
            {c.depositExempt && <Badge variant="secondary">Sin fianza</Badge>}
            {c.isTest && <Badge variant="secondary">Prueba</Badge>}
            {c.tags.map((t) => (
              <Badge key={t} variant="outline">
                {t}
              </Badge>
            ))}
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
              customerEmail={c.email}
              portalAccessEnabled={c.portalAccessEnabled}
              className="w-full justify-center sm:w-auto"
            />
          </Can>
          <Can permission="customers:write">
            <Button
              variant="outline"
              className="w-full justify-center sm:w-auto"
              onClick={() => setDialog('edit')}
            >
              <Pencil className="mr-1 h-4 w-4" /> Editar datos
            </Button>
          </Can>
          <Can permission="communications:send">
            <Button
              variant="outline"
              className="w-full justify-center sm:w-auto"
              onClick={() => setDialog('message')}
            >
              <Send className="mr-1 h-4 w-4" /> Escribir
            </Button>
          </Can>
          <Can permission="contracts:write">
            <Button asChild variant="outline" className="w-full justify-center sm:w-auto">
              <Link href={`/contracts/new?customerId=${c.id}`}>Nuevo contrato</Link>
            </Button>
          </Can>
          <Can permission="customers:write">
            <Button
              variant="outline"
              onClick={toggleKyc}
              disabled={setKyc.isPending}
              className="w-full justify-center sm:w-auto"
            >
              <BadgeCheck className="mr-1 h-4 w-4" />
              {c.kycVerified ? 'Revocar KYC' : 'Marcar KYC verificado'}
            </Button>
          </Can>
          {(canMerge || canRgpd) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="w-full justify-center sm:w-auto">
                  <MoreHorizontal className="mr-1 h-4 w-4" /> Más
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canMerge && (
                  <DropdownMenuItem onSelect={() => setDialog('merge')}>
                    Fusionar con otra ficha
                  </DropdownMenuItem>
                )}
                {canRgpd && (
                  <>
                    <DropdownMenuItem onSelect={() => void downloadData()}>
                      Descargar sus datos
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onSelect={() => void anonymizeCustomer()}
                    >
                      Anonimizar
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <QuickContact customer={c} />
      </div>

      <CustomerInsightsStrip customerId={c.id} />
      {canReadInvoices && canReadPayments && (
        <CustomerAccountCard customerId={c.id} onGoTo={setTab} />
      )}
      {dialog === 'edit' && <EditCustomerDialog customer={c} onClose={() => setDialog(null)} />}
      {dialog === 'message' && (
        <CustomerMessageDialog customer={c} onClose={() => setDialog(null)} />
      )}
      {dialog === 'merge' && <MergeCustomerDialog customer={c} onClose={() => setDialog(null)} />}

      <Tabs value={tab} onValueChange={setTab}>
        {/* Móvil: desplegable (9 pestañas no caben cómodas en una tira). */}
        <div className="sm:hidden">
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOMER_TABS.filter(
                (t) =>
                  (t.value !== 'access' || canSeeAccess) &&
                  (t.value !== 'contacts' || c.customerType === 'business'),
              ).map((t) => (
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
        <TabsList className="hidden h-auto flex-wrap sm:inline-flex sm:justify-start">
          <TabsTrigger value="contracts">Contratos</TabsTrigger>
          <TabsTrigger value="timeline">Cronología</TabsTrigger>
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
          <TabsTrigger value="authorized">Autorizados</TabsTrigger>
          {c.customerType === 'business' && <TabsTrigger value="contacts">Contactos</TabsTrigger>}
          {canSeeAccess && <TabsTrigger value="access">Accesos</TabsTrigger>}
          <TabsTrigger value="history">Historial de pagos</TabsTrigger>
          <TabsTrigger value="payments">Métodos de pago</TabsTrigger>
          <TabsTrigger value="info">Datos</TabsTrigger>
        </TabsList>
        <TabsContent value="timeline" className="mt-6">
          <CustomerTimelineTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="contacts" className="mt-6">
          <CustomerContactsTab customerId={c.id} />
        </TabsContent>
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
        <TabsContent value="authorized" className="mt-6">
          <AuthorizedPersonsTab customerId={c.id} />
        </TabsContent>
        {canSeeAccess && (
          <TabsContent value="access" className="mt-6">
            <CustomerAccessTab customerId={c.id} />
          </TabsContent>
        )}
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
                  {[c.address, [c.postalCode, c.city].filter(Boolean).join(' ')]
                    .filter(Boolean)
                    .join(', ') || '—'}{' '}
                  ({c.country})
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
          <EmailStatusCard customerId={c.id} />
          <DepositExemptCard customerId={c.id} exempt={c.depositExempt} />
          <MarketingPreferenceCard customerId={c.id} optOutAt={c.marketingOptOutAt} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
