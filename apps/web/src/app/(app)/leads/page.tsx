'use client';

import { type LeadDto, type LeadStatusValue } from '@storageos/shared';
import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLeads, useTransitionLead } from '@/lib/communications/hooks';

const COLUMNS: { status: LeadStatusValue; label: string }[] = [
  { status: 'new', label: 'Nuevos' },
  { status: 'contacted', label: 'Contactados' },
  { status: 'qualified', label: 'Cualificados' },
  { status: 'won', label: 'Ganados' },
  { status: 'lost', label: 'Perdidos' },
];

export default function LeadsPage() {
  const leads = useLeads();
  const transition = useTransitionLead();
  const [dragging, setDragging] = useState<string | null>(null);

  if (leads.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const byStatus = (s: LeadStatusValue) => (leads.data ?? []).filter((l) => l.status === s);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Leads</h1>
          <p className="text-sm text-muted-foreground">
            Pipeline de personas interesadas en alquilar. Arrastra entre fases (en escritorio) o usa
            el selector de cada tarjeta.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = byStatus(col.status);
          return (
            <Card
              key={col.status}
              className="min-h-[320px]"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragging) return;
                transition.mutate({
                  id: dragging,
                  input: { status: col.status },
                });
                setDragging(null);
              }}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-normal text-muted-foreground">
                  <span>{col.label}</span>
                  <Badge variant="secondary">{items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {items.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    onDragStart={() => setDragging(lead.id)}
                    onMove={(status) => transition.mutate({ id: lead.id, input: { status } })}
                  />
                ))}
                {items.length === 0 && (
                  <p className="text-xs text-muted-foreground">— Sin leads —</p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function LeadCard({
  lead,
  onDragStart,
  onMove,
}: {
  lead: LeadDto;
  onDragStart: () => void;
  onMove: (status: LeadStatusValue) => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="rounded-md border bg-card p-3 text-sm shadow-sm hover:shadow-md md:cursor-grab"
    >
      <div className="font-medium">{lead.displayName}</div>
      {lead.email && <div className="text-xs text-muted-foreground">{lead.email}</div>}
      {lead.phone && <div className="text-xs text-muted-foreground">{lead.phone}</div>}
      {lead.preferredFacilityName && (
        <div className="mt-1 text-xs">
          <Badge variant="outline">{lead.preferredFacilityName}</Badge>
        </div>
      )}
      {lead.source && (
        <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          {lead.source}
        </div>
      )}
      {lead.budgetMonthly !== null && (
        <div className="mt-1 text-xs">
          {lead.budgetMonthly.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          /mes
        </div>
      )}
      {/* Mover de fase: funciona en táctil (el drag&drop nativo no). */}
      <Select value={lead.status} onValueChange={(v) => onMove(v as LeadStatusValue)}>
        <SelectTrigger className="mt-2 h-8" aria-label="Cambiar fase">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COLUMNS.map((c) => (
            <SelectItem key={c.status} value={c.status}>
              {c.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
