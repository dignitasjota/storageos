'use client';

import { Bot, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdminTenantAiUsage, useUpdateAdminTenantAiLimit } from '@/lib/admin/ai-hooks';
import { useAdminTenantFeatures } from '@/lib/admin/hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDate, formatNumber } from '@/lib/format';

/** Consultas del asistente IA del tenant este mes y su límite propio. */
export function AiUsageCard({ tenantId }: { tenantId: string }) {
  const canEdit = useIsSuperadmin();
  const features = useAdminTenantFeatures(tenantId);
  const hasAi = features.data?.effective.includes('ai_assistant') ?? false;
  const usage = useAdminTenantAiUsage(tenantId);
  const update = useUpdateAdminTenantAiLimit(tenantId);
  const [limit, setLimit] = useState('');

  useEffect(() => {
    if (!usage.data) return;
    setLimit(usage.data.customLimit ? String(usage.data.limit) : '');
  }, [usage.data]);

  const u = usage.data;
  if (!u || (!hasAi && u.used === 0)) return null;
  const pct = u.limit > 0 ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 100;

  async function save() {
    try {
      await update.mutateAsync({
        monthlyLimit: limit.trim() === '' ? null : Math.max(0, Number.parseInt(limit, 10) || 0),
      });
      toast.success('Límite del asistente guardado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4" />
          Asistente IA
        </CardTitle>
        <CardDescription>
          {formatNumber(u.used)} de {formatNumber(u.limit)} consultas este mes
          {u.extra > 0 ? ` (${formatNumber(u.extra)} de extras)` : ''}
          {u.customLimit ? ', con límite propio' : ''}. Se reinicia el {formatDate(u.resetsOn)}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Consultas usadas"
        >
          <div
            className={
              pct >= 100
                ? 'h-full bg-red-500'
                : pct >= 80
                  ? 'h-full bg-amber-500'
                  : 'h-full bg-primary'
            }
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="ai-tenant-limit">Límite propio al mes</Label>
            <Input
              id="ai-tenant-limit"
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="El general + extras"
              className="w-48 text-base sm:text-sm"
            />
          </div>
          <Button onClick={save} disabled={update.isPending || !canEdit}>
            {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Guardar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
