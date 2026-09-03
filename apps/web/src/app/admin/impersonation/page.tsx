'use client';

import { ChevronDown, ChevronRight, Loader2, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  useAdminImpersonationActivity,
  useAdminImpersonationLogs,
  useRevokeImpersonation,
} from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('es-ES');
}

function SessionActivity({ id }: { id: string }) {
  const { data, isLoading } = useAdminImpersonationActivity(id);
  if (isLoading) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="inline size-4 animate-spin" /> Cargando actividad…
      </div>
    );
  }
  const items = data ?? [];
  if (items.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">
        No se registró actividad durante esta sesión.
      </div>
    );
  }
  return (
    <div className="space-y-1 px-4 py-3">
      {items.map((a) => (
        <div key={a.id} className="flex items-center gap-2 text-xs">
          <span className="w-36 shrink-0 text-muted-foreground">{fmt(a.occurredAt)}</span>
          <Badge variant="outline" className="text-[10px]">
            {a.action}
          </Badge>
          <span className="text-muted-foreground">
            {a.entityType}
            {a.userName ? ` · ${a.userName}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ImpersonationPage() {
  const { data, isLoading } = useAdminImpersonationLogs();
  const revoke = useRevokeImpersonation();
  const [open, setOpen] = useState<string | null>(null);

  function onRevoke(id: string, tenantName: string) {
    if (!window.confirm(`¿Revocar la sesión de impersonación de «${tenantName}»?`)) return;
    revoke.mutate(id, {
      onSuccess: () => toast.success('Sesión revocada.'),
      onError: (err) => toast.error(err instanceof ApiError ? err.body.message : 'Error'),
    });
  }

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Impersonaciones</h1>
        <p className="text-sm text-muted-foreground">
          Sesiones en las que un super admin entró como un tenant. Despliega para ver la actividad
          registrada durante la ventana de la sesión.
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Para <strong className="text-foreground">entrar como un tenant</strong>, abre su ficha y
          pulsa «Impersonar».
        </span>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/tenants">Ir a tenants</Link>
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sesiones</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No hay sesiones de impersonación registradas.
            </p>
          ) : (
            <div className="divide-y">
              {(data ?? []).map((s) => {
                const isOpen = open === s.id;
                const isLive = !s.revokedAt && new Date(s.expiresAt) > new Date();
                return (
                  <div key={s.id}>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen ? null : s.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left text-sm hover:bg-accent/30"
                      >
                        {isOpen ? (
                          <ChevronDown className="size-4 shrink-0" />
                        ) : (
                          <ChevronRight className="size-4 shrink-0" />
                        )}
                        <span className="w-40 shrink-0 text-muted-foreground">
                          {fmt(s.createdAt)}
                        </span>
                        <span className="font-medium">{s.superAdminName ?? s.superAdminEmail}</span>
                        <span className="text-muted-foreground">→ {s.tenantName}</span>
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {s.reason}
                        </span>
                        {s.revokedAt && (
                          <Badge variant="secondary" className="text-[10px]">
                            revocada
                          </Badge>
                        )}
                      </button>
                      {isLive && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          disabled={revoke.isPending}
                          onClick={() => onRevoke(s.id, s.tenantName)}
                        >
                          <ShieldOff className="mr-1.5 size-4" /> Revocar
                        </Button>
                      )}
                    </div>
                    {isOpen && <SessionActivity id={s.id} />}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
