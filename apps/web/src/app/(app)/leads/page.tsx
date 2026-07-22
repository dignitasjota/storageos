'use client';

import { type LeadDto, type LeadStatusValue, leadSourceLabel } from '@storageos/shared';
import { Loader2, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useHasPermission } from '@/lib/auth/hooks';
import { useCreateLead, useLeads, useLeadSources, useTransitionLead } from '@/lib/communications/hooks';
import { useFacilities } from '@/lib/facilities/hooks';

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
  const canWrite = useHasPermission('leads:write');
  const [dragging, setDragging] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

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
        {canWrite && (
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> Nuevo lead
          </Button>
        )}
      </div>

      {newOpen && <NewLeadDialog onClose={() => setNewOpen(false)} />}

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
          {leadSourceLabel(lead.source)}
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

// ============================================================================
// Alta manual de lead (Idealista, llamada, visita…) — origen propio al vuelo
// ============================================================================

const CUSTOM_SOURCE = '__custom__';

function NewLeadDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateLead();
  const sources = useLeadSources();
  const facilities = useFacilities();

  const [source, setSource] = useState('portal_inmobiliario');
  const [customSource, setCustomSource] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [facilityId, setFacilityId] = useState<string>('');
  const [budget, setBudget] = useState('');

  const resolvedSource = source === CUSTOM_SOURCE ? customSource.trim() : source;
  const hasName = Boolean(firstName.trim() || lastName.trim() || companyName.trim());
  const canSubmit = Boolean(resolvedSource) && hasName && !create.isPending;

  async function submit() {
    if (!canSubmit) return;
    try {
      await create.mutateAsync({
        source: resolvedSource,
        metadata: {},
        ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(companyName.trim() ? { companyName: companyName.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(facilityId ? { preferredFacilityId: facilityId } : {}),
        ...(budget && Number(budget) > 0 ? { budgetMonthly: Number(budget) } : {}),
      });
      toast.success('Lead creado. Está en «Nuevos» para hacerle seguimiento.');
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el lead');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nuevo lead</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Origen</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger>
                <SelectValue placeholder="¿De dónde viene?" />
              </SelectTrigger>
              <SelectContent>
                {(sources.data ?? []).map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SOURCE}>➕ Añadir origen…</SelectItem>
              </SelectContent>
            </Select>
            {source === CUSTOM_SOURCE && (
              <Input
                autoFocus
                value={customSource}
                onChange={(e) => setCustomSource(e.target.value)}
                placeholder="Nombre del origen (p. ej. Habitaclia)"
                className="text-base sm:text-sm"
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Nombre</Label>
              <Input
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Apellidos</Label>
              <Input
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Empresa (opcional)</Label>
            <Input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Teléfono</Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Local de interés (opcional)</Label>
              <Select value={facilityId} onValueChange={setFacilityId}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {(facilities.data ?? []).map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Presupuesto €/mes (opcional)</Label>
              <Input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="text-base sm:text-sm"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notas / lo que busca</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="Ej.: busca un trastero de ~5 m² para agosto"
            />
          </div>
          {!hasName && (
            <p className="text-xs text-muted-foreground">
              Indica al menos un nombre, apellidos o empresa.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {create.isPending ? 'Creando…' : 'Crear lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
