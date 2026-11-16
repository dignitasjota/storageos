'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Mail, MessageCircle, Phone } from 'lucide-react';

import type { TenantSalesRepDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/auth/api';

function waDigits(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length === 9 ? `34${d}` : d;
}

/** «Tu comercial»: la persona de TrasterOS que lleva esta cuenta (si la hay). */
export function SalesRepCard() {
  const q = useQuery({
    queryKey: ['settings', 'sales-rep'],
    queryFn: () => apiFetch<{ rep: TenantSalesRepDto | null }>('/settings/sales-rep'),
    staleTime: 300_000,
  });
  const rep = q.data?.rep;
  if (!rep) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Tu comercial: {rep.fullName}</CardTitle>
        <CardDescription>
          Para dudas sobre tu plan, extras o una demo de algo que no conozcas.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <a href={`mailto:${rep.email}`}>
            <Mail className="mr-1.5 size-4" />
            {rep.email}
          </a>
        </Button>
        {rep.phone && (
          <Button asChild size="sm" variant="outline">
            <a href={`tel:${rep.phone}`}>
              <Phone className="mr-1.5 size-4" />
              {rep.phone}
            </a>
          </Button>
        )}
        {rep.whatsapp && (
          <Button asChild size="sm" variant="outline">
            <a href={`https://wa.me/${waDigits(rep.whatsapp)}`} target="_blank" rel="noreferrer">
              <MessageCircle className="mr-1.5 size-4" />
              WhatsApp
            </a>
          </Button>
        )}
        {rep.bookingUrl && (
          <Button asChild size="sm" variant="outline">
            <a href={rep.bookingUrl} target="_blank" rel="noreferrer">
              <CalendarClock className="mr-1.5 size-4" />
              Reservar una llamada
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
