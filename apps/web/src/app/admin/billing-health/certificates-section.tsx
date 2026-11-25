'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import Link from 'next/link';

import type { NoticeTarget } from './notice-dialog';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useBillingCertificates } from '@/lib/admin/billing-domains-hooks';
import { formatDate } from '@/lib/format';

/** Calendario de certificados de la AEAT que caducan en 60 días (también de propietarios). */
export function CertificatesSection({
  canNotify,
  onNotice,
}: {
  canNotify: boolean;
  onNotice: (t: NoticeTarget) => void;
}) {
  const certs = useBillingCertificates();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Certificados que caducan</CardTitle>
        <CardDescription>
          Próximos 60 días y los caducados en el último mes, el más urgente primero. No incluye a
          quien emite en Holded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {certs.isError ? (
          <AdminError onRetry={() => void certs.refetch()} />
        ) : certs.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (certs.data ?? []).length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-emerald-600" /> Ningún certificado caduca pronto.
          </p>
        ) : (
          (certs.data ?? []).map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <Link href={`/admin/tenants/${c.tenantId}`} className="font-medium hover:underline">
                  {c.tenantName}
                </Link>
                {c.ownerName && (
                  <span className="text-muted-foreground"> · propietario {c.ownerName}</span>
                )}
                <p className="text-xs text-muted-foreground">
                  {c.daysLeft <= 0 ? 'Caducó' : 'Caduca'} el {formatDate(c.validTo)}
                  {c.daysLeft > 0 && ` (en ${c.daysLeft} días)`}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    c.daysLeft <= 15
                      ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  }`}
                >
                  {c.daysLeft <= 0 ? 'Caducado' : `${c.daysLeft} d`}
                </span>
                {canNotify && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      onNotice({
                        tenantId: c.tenantId,
                        tenantName: c.tenantName,
                        kind: 'certificate_expiring',
                        credentialId: c.id,
                      })
                    }
                  >
                    Avisar
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
