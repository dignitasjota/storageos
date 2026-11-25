'use client';

import {
  BILLING_PROBLEM_LABELS,
  BILLING_TENANT_PROBLEMS,
  type BillingNoticeKind,
  type BillingTenantProblem,
  type BillingVerifactuTenantDto,
} from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import type { NoticeTarget } from './notice-dialog';

import { AdminError } from '@/components/admin/admin-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBillingVerifactuTenants } from '@/lib/admin/billing-domains-hooks';
import { formatDate, formatDateTime } from '@/lib/format';

const MODE_LABEL = { sandbox: 'Pruebas', production: 'Real', stub: 'Simulado' } as const;
const PAGE = 25;

function noticesFor(t: BillingVerifactuTenantDto): BillingNoticeKind[] {
  const kinds: BillingNoticeKind[] = [];
  if (t.rejected > 0) kinds.push('invoice_rejected');
  if (!t.hasCertificate && t.certificateDaysLeft === null) kinds.push('certificate_missing');
  if (t.certificateDaysLeft !== null && t.certificateDaysLeft <= 60)
    kinds.push('certificate_expiring');
  if (t.holdedReview > 0) kinds.push('holded_review');
  return kinds;
}

const NOTICE_MENU: Record<BillingNoticeKind, string> = {
  invoice_rejected: 'Avisar de facturas rechazadas',
  certificate_missing: 'Avisar de que falta el certificado',
  certificate_expiring: 'Avisar de que caduca el certificado',
  holded_review: 'Avisar de envíos de Holded',
};

/** Todos los tenants con Veri*Factu: modo, último envío correcto, pendientes y certificado. */
export function TenantsSection({
  canNotify,
  onNotice,
}: {
  canNotify: boolean;
  onNotice: (t: NoticeTarget) => void;
}) {
  const [problem, setProblem] = useState<BillingTenantProblem | 'all'>('all');
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(PAGE);
  const tenants = useBillingVerifactuTenants(problem, search);
  const rows = tenants.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Tenants con Veri*Factu</CardTitle>
        <CardDescription>
          Todos los negocios con Veri*Factu activado, también los sanos.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Input
            placeholder="Buscar tenant…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setShown(PAGE);
            }}
            className="w-full text-base sm:w-64 sm:text-sm"
          />
          <Select
            value={problem}
            onValueChange={(v) => {
              setProblem(v as BillingTenantProblem | 'all');
              setShown(PAGE);
            }}
          >
            <SelectTrigger className="w-full text-base sm:w-60 sm:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {BILLING_TENANT_PROBLEMS.map((p) => (
                <SelectItem key={p} value={p}>
                  {BILLING_PROBLEM_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {tenants.isError ? (
          <AdminError onRetry={() => void tenants.refetch()} />
        ) : tenants.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin resultados.</p>
        ) : (
          <>
            {rows.slice(0, shown).map((t) => (
              <TenantLine key={t.tenantId} t={t} canNotify={canNotify} onNotice={onNotice} />
            ))}
            {rows.length > shown && (
              <Button variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Ver más ({rows.length - shown})
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TenantLine({
  t,
  canNotify,
  onNotice,
}: {
  t: BillingVerifactuTenantDto;
  canNotify: boolean;
  onNotice: (t: NoticeTarget) => void;
}) {
  const kinds = noticesFor(t);
  const chips: { label: string; red?: boolean }[] = [];
  if (t.rejected)
    chips.push({ label: `${t.rejected} rechazada${t.rejected === 1 ? '' : 's'}`, red: true });
  if (t.error) chips.push({ label: `${t.error} con error`, red: true });
  if (t.warnings)
    chips.push({ label: `${t.warnings} aceptada${t.warnings === 1 ? '' : 's'} con errores` });
  if (t.stale) chips.push({ label: `${t.stale} sin respuesta` });
  if (t.unsent) chips.push({ label: `${t.unsent} sin enviar` });
  if (t.holdedReview) chips.push({ label: `Holded: ${t.holdedReview} para revisar` });
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div>
          <Link href={`/admin/tenants/${t.tenantId}`} className="font-medium hover:underline">
            {t.tenantName}
          </Link>
          <span className="ml-2 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {MODE_LABEL[t.mode]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Último envío correcto: {t.lastAcceptedAt ? formatDateTime(t.lastAcceptedAt) : 'ninguno'} ·{' '}
          {t.pendingRecords} registro(s) pendiente(s) ·{' '}
          {t.certificateValidTo
            ? `certificado hasta ${formatDate(t.certificateValidTo)}${
                t.certificateDaysLeft !== null && t.certificateDaysLeft <= 30
                  ? ` (${t.certificateDaysLeft <= 0 ? 'caducado' : `${t.certificateDaysLeft} d`})`
                  : ''
              }`
            : 'sin certificado'}
        </p>
        <div className="flex flex-wrap gap-1">
          {chips.length === 0 && !t.hasProblem && (
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              Sano
            </span>
          )}
          {chips.map((c) => (
            <span
              key={c.label}
              className={`rounded px-2 py-0.5 text-xs ${
                c.red
                  ? 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
              }`}
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>
      {canNotify && kinds.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 shrink-0 text-xs">
              Avisar al tenant
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {kinds.map((k) => (
              <DropdownMenuItem
                key={k}
                onClick={() =>
                  onNotice({ tenantId: t.tenantId, tenantName: t.tenantName, kind: k })
                }
              >
                {NOTICE_MENU[k]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
