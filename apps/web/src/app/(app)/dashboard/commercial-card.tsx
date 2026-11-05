'use client';

import { Handshake } from 'lucide-react';
import Link from 'next/link';

import type { DashboardCommercialDto } from '@storageos/shared';

import { SectionBody } from '@/components/dashboard/section-state';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function Row({
  label,
  value,
  href,
  alert,
}: {
  label: string;
  value: number;
  href: string;
  alert?: boolean;
}) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-2 py-2 hover:underline">
        <span>{label}</span>
        <span className={`font-medium tabular-nums ${alert && value > 0 ? 'text-amber-600' : ''}`}>
          {value}
        </span>
      </Link>
    </li>
  );
}

/** Quien está a punto de ser cliente y necesita un empujón. */
export function CommercialCard({
  data,
  loading,
  onRetry,
}: {
  data: DashboardCommercialDto | null | undefined;
  loading: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Handshake className="size-4 text-amber-500" />
          Pendiente de cerrar
        </CardTitle>
        <CardDescription>Clientes a punto de entrar.</CardDescription>
      </CardHeader>
      <CardContent>
        <SectionBody data={data} loading={loading} onRetry={onRetry} height="h-40">
          {(c) => (
            <ul className="divide-y text-sm">
              <Row label="Contactos sin atender" value={c.unattendedLeads} href="/leads" alert />
              <Row label="Contactos abiertos" value={c.openLeads} href="/leads" />
              <Row
                label="Contratos por firmar"
                value={c.pendingSignature}
                href="/contracts?status=draft"
                alert
              />
              <Row
                label="Reservas firmadas sin pagar"
                value={c.pendingPayment}
                href="/contracts"
                alert
              />
              <Row label="En lista de espera" value={c.waitlist} href="/waitlist" />
            </ul>
          )}
        </SectionBody>
      </CardContent>
    </Card>
  );
}
