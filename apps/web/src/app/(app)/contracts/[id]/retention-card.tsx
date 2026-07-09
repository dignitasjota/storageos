'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import type { RetentionOfferStatus } from '@storageos/shared';

import { Badge } from '@/components/ui/badge';
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
import { ApiError } from '@/lib/auth/api';
import { useContractRetentionOffers, useCreateRetentionOffer } from '@/lib/retention/hooks';

const STATUS: Record<RetentionOfferStatus, string> = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  declined: 'Rechazada',
  expired: 'Caducada',
};

/** Oferta de retención sobre un contrato en baja (solo visible si `ending`). */
export function RetentionCard({ contractId }: { contractId: string }) {
  const offers = useContractRetentionOffers(contractId);
  const create = useCreateRetentionOffer(contractId);
  const [type, setType] = useState<'percentage' | 'fixed'>('percentage');
  const [value, setValue] = useState(10);
  const [months, setMonths] = useState(3);
  const [message, setMessage] = useState('');

  async function onCreate() {
    if (!(value > 0)) {
      toast.error('Indica un descuento válido.');
      return;
    }
    try {
      await create.mutateAsync({
        discountType: type,
        discountValue: value,
        months,
        message: message.trim() || undefined,
      });
      toast.success('Oferta enviada al inquilino.');
      setMessage('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear la oferta.');
    }
  }

  const rows = offers.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Retención</CardTitle>
        <p className="text-xs text-muted-foreground">
          Ofrece un descuento para intentar que el inquilino no se dé de baja. Si lo acepta desde su
          portal, se revierte la baja y se aplica el descuento a su cuota.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select value={type} onValueChange={(v) => setType(v as 'percentage' | 'fixed')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">Porcentaje</SelectItem>
                <SelectItem value="fixed">Importe (€)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{type === 'percentage' ? 'Descuento (%)' : 'Descuento (€/mes)'}</Label>
            <Input
              type="number"
              min={1}
              value={value}
              onChange={(e) => setValue(Number(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1">
            <Label>Meses</Label>
            <Input
              type="number"
              min={1}
              max={24}
              value={months}
              onChange={(e) => setMonths(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>Mensaje (opcional)</Label>
          <Textarea
            rows={2}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Nos encantaría que te quedaras…"
          />
        </div>
        <Button onClick={onCreate} disabled={create.isPending}>
          {create.isPending ? 'Enviando…' : 'Ofrecer descuento'}
        </Button>

        {rows.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            {rows.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {o.discountType === 'percentage' ? `${o.discountValue}%` : `${o.discountValue} €`}{' '}
                  · {o.months} mes(es)
                </span>
                <Badge
                  variant={
                    o.status === 'accepted'
                      ? 'default'
                      : o.status === 'pending'
                        ? 'secondary'
                        : 'outline'
                  }
                >
                  {STATUS[o.status]}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
