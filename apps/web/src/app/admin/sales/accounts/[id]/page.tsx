'use client';

import { PLATFORM_LEAD_STAGE_LABELS } from '@storageos/shared';
import {
  ArrowLeft,
  FileText,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { DataCard, OutcomeCard, ProfileCard, SummaryCard } from './call-panel';
import { ClientPanel } from './client-panel';
import { CreateTenantDialog, EmailDialog, QuoteDialog, WhatsappDialog } from './dialogs';
import { ActivityCard, CadenceCard, FollowupsCard, OffersCard, StageCard } from './pipeline-panel';

import {
  CopyButton,
  Empty,
  errorText,
  phoneDigits,
  SalesPage,
  TemperatureBadge,
  TenantStatusBadge,
} from '@/components/admin/sales/common';
import { Button } from '@/components/ui/button';
import { useSalesAccount, useSalesMe, useSalesRegistrationLink } from '@/lib/admin/sales-hooks';
import { ApiError } from '@/lib/auth/api';

export default function SalesAccountPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const account = useSalesAccount(id);
  const me = useSalesMe();
  const regLink = useSalesRegistrationLink(id);
  const [dialog, setDialog] = useState<null | 'email' | 'whatsapp' | 'quote' | 'tenant'>(null);

  if (account.isLoading) {
    return (
      <SalesPage>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Cargando…
        </div>
      </SalesPage>
    );
  }
  if (account.isError || !account.data) {
    const notFound = account.error instanceof ApiError && account.error.statusCode === 404;
    return (
      <SalesPage>
        <Empty>
          {notFound ? 'Esta cuenta no es de tu cartera.' : 'No se ha podido cargar la cuenta.'}{' '}
          <Link href="/admin/sales/leads" className="text-primary hover:underline">
            Volver a tus prospectos
          </Link>
        </Empty>
      </SalesPage>
    );
  }

  const a = account.data;
  const lead = a.lead;
  const phone = a.client?.owner?.phone ?? lead.phone;
  const email = a.client?.owner?.email ?? lead.email;
  const wa = phoneDigits(phone);

  async function sendRegistration() {
    try {
      await regLink.mutateAsync(undefined);
      toast.success('Le hemos enviado el enlace para crear su cuenta con tu código.');
    } catch (err) {
      toast.error(errorText(err));
    }
  }

  return (
    <SalesPage>
      <div className="space-y-3">
        <Link
          href={a.client ? '/admin/sales/clients' : '/admin/sales/leads'}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {a.client ? 'Clientes' : 'Prospectos'}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{lead.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {lead.contactName && lead.companyName && <span>{lead.contactName}</span>}
              {lead.city && <span>· {lead.city}</span>}
              <span>· {PLATFORM_LEAD_STAGE_LABELS[lead.status]}</span>
              {a.client && (
                <TenantStatusBadge status={a.client.status} pastDue={a.client.pastDue} />
              )}
              <TemperatureBadge value={a.profile?.temperature} />
            </div>
            {a.profile?.pinnedNote && (
              <p className="mt-2 max-w-2xl rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                📌 {a.profile.pinnedNote}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {phone && (
              <Button asChild size="sm" variant="outline">
                <a href={`tel:${phone}`}>
                  <Phone className="mr-1.5 size-4" />
                  Llamar
                </a>
              </Button>
            )}
            {wa && (
              <Button size="sm" variant="outline" onClick={() => setDialog('whatsapp')}>
                <MessageCircle className="mr-1.5 size-4" />
                WhatsApp
              </Button>
            )}
            {email && (
              <Button size="sm" variant="outline" onClick={() => setDialog('email')}>
                <Mail className="mr-1.5 size-4" />
                Correo
              </Button>
            )}
            {(a.client || lead.email) && (
              <Button size="sm" onClick={() => setDialog('quote')}>
                <FileText className="mr-1.5 size-4" />
                Propuesta
              </Button>
            )}
          </div>
        </div>
        {(phone || email) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {phone && (
              <span className="inline-flex items-center gap-1">
                <span className="tabular-nums">{phone}</span>
                <CopyButton text={phone} label="Copiar teléfono" size="icon" variant="ghost" />
              </span>
            )}
            {email && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="break-all">{email}</span>
                <CopyButton text={email} label="Copiar email" size="icon" variant="ghost" />
              </span>
            )}
          </div>
        )}
        {a.pendingAssignment && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Se ha registrado sin tu código. La dirección decide si la cuenta es tuya; mientras, no
            ves sus datos de cliente.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
        <div className="space-y-4">
          <OutcomeCard account={a} />
          <SummaryCard account={a} />
          <ProfileCard account={a} />
          <DataCard account={a} />
        </div>
        <div className="space-y-4">
          {a.client ? (
            <ClientPanel account={a} me={me.data} />
          ) : (
            !a.pendingAssignment && (
              <div className="rounded-lg border p-4">
                <p className="text-sm font-medium">Aún no tiene cuenta</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Créasela tú (empieza con la prueba normal) o envíale el enlace para que se
                  registre con tu código.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setDialog('tenant')}>
                    <UserPlus className="mr-1.5 size-4" />
                    Crear su cuenta
                  </Button>
                  {lead.email && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={regLink.isPending}
                      onClick={() => void sendRegistration()}
                    >
                      <Link2 className="mr-1.5 size-4" />
                      Enviarle el enlace
                    </Button>
                  )}
                </div>
              </div>
            )
          )}
          <FollowupsCard account={a} />
          <OffersCard account={a} />
          <CadenceCard account={a} />
          <StageCard account={a} />
          <ActivityCard account={a} />
        </div>
      </div>

      {dialog === 'email' && (
        <EmailDialog account={a} me={me.data} onClose={() => setDialog(null)} />
      )}
      {dialog === 'whatsapp' && (
        <WhatsappDialog account={a} me={me.data} onClose={() => setDialog(null)} />
      )}
      {dialog === 'quote' && <QuoteDialog account={a} onClose={() => setDialog(null)} />}
      {dialog === 'tenant' && <CreateTenantDialog account={a} onClose={() => setDialog(null)} />}
    </SalesPage>
  );
}
