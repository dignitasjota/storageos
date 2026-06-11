'use client';

import { ArrowLeft, BadgeCheck, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';

import { CustomerContractsTab } from './contracts-tab';
import { CustomerDocumentsTab } from './documents-tab';
import { CustomerPaymentMethodsTab } from './payment-methods-tab';
import { CustomerReservationsTab } from './reservations-tab';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/auth/api';
import { useCustomer, useSetKycVerified } from '@/lib/customers/hooks';

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const customer = useCustomer(id);
  const setKyc = useSetKycVerified();

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
    <div className="space-y-6 px-6 py-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/customers">
            <ArrowLeft className="mr-1 h-4 w-4" /> Inquilinos
          </Link>
        </Button>
        <div className="mt-2 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">{c.displayName}</h1>
              <Badge variant="outline">
                {c.customerType === 'business' ? 'Empresa' : 'Particular'}
              </Badge>
              <Badge variant={c.kycVerified ? 'default' : 'outline'}>
                {c.kycVerified ? 'KYC verificado' : 'KYC pendiente'}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {c.email ?? '—'} · {c.phone ?? 'Sin teléfono'}
              {c.documentNumber && ` · ${c.documentType ?? 'Doc.'} ${c.documentNumber}`}
            </p>
          </div>
          <Button variant="outline" onClick={toggleKyc} disabled={setKyc.isPending}>
            <BadgeCheck className="mr-1 h-4 w-4" />
            {c.kycVerified ? 'Revocar KYC' : 'Marcar KYC verificado'}
          </Button>
        </div>
      </div>

      <Tabs defaultValue="contracts">
        <TabsList>
          <TabsTrigger value="contracts">Contratos</TabsTrigger>
          <TabsTrigger value="reservations">Reservas</TabsTrigger>
          <TabsTrigger value="documents">Documentos</TabsTrigger>
          <TabsTrigger value="payments">Pagos</TabsTrigger>
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
        <TabsContent value="payments" className="mt-6">
          <CustomerPaymentMethodsTab customerId={c.id} />
        </TabsContent>
        <TabsContent value="info" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Datos personales</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3 text-sm">
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
