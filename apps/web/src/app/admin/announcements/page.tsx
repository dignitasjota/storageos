'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { AdminBroadcastAudienceValue } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAdminBroadcast } from '@/lib/admin/hooks';
import { ApiError } from '@/lib/auth/api';

const AUDIENCE_OPTIONS: { value: AdminBroadcastAudienceValue; label: string }[] = [
  { value: 'active', label: 'Tenants activos' },
  { value: 'trial', label: 'Tenants en trial' },
  { value: 'all', label: 'Activos + trial' },
];

export default function AdminAnnouncementsPage() {
  const broadcast = useAdminBroadcast();
  const [audience, setAudience] = useState<AdminBroadcastAudienceValue>('active');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (subject.trim().length < 3 || body.trim().length === 0) {
      toast.error('Indica un asunto y un mensaje.');
      return;
    }
    const audienceLabel = AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? audience;
    if (!window.confirm(`¿Enviar este anuncio a «${audienceLabel}»?`)) return;
    try {
      const res = await broadcast.mutateAsync({
        audience,
        subject: subject.trim(),
        body: body.trim(),
      });
      toast.success(
        `Anuncio enviado: ${res.recipients} email(s) a ${res.tenants} tenant(s)${res.failed ? `, ${res.failed} fallido(s)` : ''}.`,
      );
      setSubject('');
      setBody('');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body.message);
      else toast.error('No se pudo enviar el anuncio.');
    }
  }

  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Anuncios</h1>
        <p className="text-sm text-muted-foreground">
          Envía un email a todos los tenants de un público (mantenimiento, novedades…). Llega a los
          propietarios verificados de cada tenant.
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle className="text-base">Nuevo anuncio</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Público</Label>
              <Select
                value={audience}
                onValueChange={(v) => setAudience(v as AdminBroadcastAudienceValue)}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Asunto</Label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label>Mensaje</Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                maxLength={10000}
                placeholder="Escribe el anuncio…"
              />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={broadcast.isPending}>
                {broadcast.isPending ? 'Enviando…' : 'Enviar anuncio'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
