'use client';

import { Loader2 } from 'lucide-react';

import type { AdminTenantConfigItemDto } from '@storageos/shared';

import { AdminError } from '@/components/admin/admin-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAdminTenantConfig } from '@/lib/admin/hooks';

const DOT: Record<AdminTenantConfigItemDto['tone'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  off: 'bg-muted-foreground/40',
};

/** Configuración del tenant de un vistazo (solo lectura, sin secretos). */
export function TenantConfigCard({ tenantId }: { tenantId: string }) {
  const config = useAdminTenantConfig(tenantId);

  if (config.isError) return <AdminError onRetry={() => void config.refetch()} />;
  if (config.isLoading || !config.data) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const warnings = config.data.sections.flatMap((s) => s.items).filter((i) => i.tone === 'warn');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Cómo tiene configurada su cuenta este cliente. Solo lectura: para cambiar algo, entra con
        «Impersonar» o pídeselo al cliente.
        {warnings.length > 0 ? ` Hay ${warnings.length} punto(s) a revisar (en ámbar).` : ''}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {config.data.sections.map((section) => (
          <Card key={section.key}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{section.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                {section.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  >
                    <dt className="flex items-center gap-2 text-muted-foreground">
                      <span className={`size-2 shrink-0 rounded-full ${DOT[item.tone]}`} />
                      {item.label}
                    </dt>
                    <dd
                      className={`break-words pl-4 sm:pl-0 sm:text-right ${
                        item.tone === 'warn'
                          ? 'font-medium text-amber-700 dark:text-amber-300'
                          : item.tone === 'off'
                            ? 'text-muted-foreground'
                            : ''
                      }`}
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
