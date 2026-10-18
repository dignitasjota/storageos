'use client';

import { type WhatsappAiMode } from '@storageos/shared';
import { Loader2, MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import {
  useAdminTenantWhatsappAi,
  useUpdateAdminTenantWhatsappAi,
} from '@/lib/admin/whatsapp-ai-hooks';
import { ApiError } from '@/lib/auth/api';

/** IA del asistente de WhatsApp del tenant: modo, límite y uso del mes. */
export function WhatsappAiCard({ tenantId }: { tenantId: string }) {
  const canEdit = useIsSuperadmin();
  const data = useAdminTenantWhatsappAi(tenantId);
  const update = useUpdateAdminTenantWhatsappAi(tenantId);
  const [mode, setMode] = useState<WhatsappAiMode>('platform');
  const [limit, setLimit] = useState('');

  useEffect(() => {
    if (!data.data) return;
    setMode(data.data.aiMode);
    setLimit(data.data.aiMonthlyLimit != null ? String(data.data.aiMonthlyLimit) : '');
  }, [data.data]);

  // Solo se muestra si el tenant ha conectado su número.
  if (!data.data?.configured) return null;
  const d = data.data;

  async function save() {
    try {
      await update.mutateAsync({
        aiMode: mode,
        aiMonthlyLimit: limit.trim() === '' ? null : Math.max(0, Number.parseInt(limit, 10) || 0),
      });
      toast.success('IA de WhatsApp del tenant guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4" />
          WhatsApp
          {d.assistantEnabled ? (
            <Badge variant="outline">Asistente activo</Badge>
          ) : (
            <Badge variant="secondary">Asistente apagado</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {d.displayPhone ?? 'Número sin comprobar'} · este mes: {d.usage.platformRepliesThisMonth}{' '}
          de {d.usage.limit} respuestas con la IA de TrasterOS
          {d.usage.ownRepliesThisMonth > 0 ? ` y ${d.usage.ownRepliesThisMonth} con la suya` : ''}.
          {d.ownKeyConfigured ? ' Tiene su propia clave.' : ' No tiene clave propia.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>IA del asistente</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as WhatsappAiMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="platform">IA de TrasterOS (con límite)</SelectItem>
                <SelectItem value="own">Su propia clave (siempre)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wa-tenant-limit">Respuestas al mes con la IA de TrasterOS</Label>
            <Input
              id="wa-tenant-limit"
              type="number"
              min={0}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="El general"
              className="text-base sm:text-sm"
            />
          </div>
        </div>
        <Button onClick={save} disabled={update.isPending || !canEdit}>
          {update.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}
