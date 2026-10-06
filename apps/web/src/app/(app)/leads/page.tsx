'use client';

import {
  LEAD_LOST_REASON_LABELS,
  LeadLostReasonEnum,
  type LeadDto,
  type LeadLostReason,
  type LeadStatusValue,
  leadSourceLabel,
} from '@storageos/shared';
import { Loader2, Pencil, Plus, UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import { LeadConversation } from './lead-conversation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  useConvertLead,
  useCreateLead,
  useLeads,
  useLeadSources,
  useSetLeadMarketing,
  useTransitionLead,
  useUpdateLead,
} from '@/lib/communications/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';

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
  const convert = useConvertLead();
  const router = useRouter();
  const canWrite = useHasPermission('leads:write');
  const [dragging, setDragging] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<LeadDto | null>(null);
  // Pasar a «Perdidos» pide el motivo (dato para precios e informes).
  const [losing, setLosing] = useState<string | null>(null);

  async function onConvert(lead: LeadDto) {
    if (
      !window.confirm(
        `¿Convertir a «${lead.displayName}» en cliente? Se creará una ficha de inquilino con sus datos y el lead pasará a «Ganados».`,
      )
    ) {
      return;
    }
    try {
      const result = await convert.mutateAsync({ id: lead.id, input: {} });
      toast.success('Lead convertido en cliente.');
      if (result.convertedCustomerId) router.push(`/customers/${result.convertedCustomerId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo convertir el lead');
    }
  }

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

      {newOpen && <LeadFormDialog onClose={() => setNewOpen(false)} />}
      {editing && <LeadFormDialog lead={editing} onClose={() => setEditing(null)} />}
      {losing && <LostReasonDialog leadId={losing} onClose={() => setLosing(null)} />}

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
                if (col.status === 'lost') {
                  setLosing(dragging);
                } else {
                  transition.mutate({ id: dragging, input: { status: col.status } });
                }
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
                    canWrite={canWrite}
                    onDragStart={() => setDragging(lead.id)}
                    onEdit={() => setEditing(lead)}
                    onConvert={() => onConvert(lead)}
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
  canWrite,
  onDragStart,
  onEdit,
  onConvert,
}: {
  lead: LeadDto;
  canWrite: boolean;
  onDragStart: () => void;
  onEdit: () => void;
  onConvert: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      className="rounded-md border bg-card p-3 text-sm shadow-sm hover:shadow-md md:cursor-grab"
    >
      <div className="font-medium">{lead.displayName}</div>
      {lead.email && <div className="truncate text-xs text-muted-foreground">{lead.email}</div>}
      {/* Contacto + origen en una sola línea para ocupar menos. El local asignado
          no se muestra aquí (se ve/edita en «Editar»). */}
      {(lead.phone || lead.source) && (
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {lead.phone && <span>{lead.phone}</span>}
          {lead.source && (
            <span className="text-[10px] uppercase tracking-wide">
              {leadSourceLabel(lead.source)}
            </span>
          )}
        </div>
      )}
      {lead.budgetMonthly !== null && (
        <div className="mt-1 text-xs">
          {lead.budgetMonthly.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}
          /mes
        </div>
      )}
      {lead.status === 'lost' && lead.lostReasonCode && (
        <div className="mt-1 text-xs text-muted-foreground">
          Motivo: {LEAD_LOST_REASON_LABELS[lead.lostReasonCode]}
        </div>
      )}
      {lead.convertedCustomerId && (
        <div className="mt-1 text-[10px] font-medium uppercase tracking-wide text-green-600 dark:text-green-400">
          Convertido en cliente
        </div>
      )}
      {/* La fase se cambia arrastrando (escritorio) o desde «Editar» (también en
          móvil), así que no hace falta el desplegable en la tarjeta. */}
      {canWrite && (
        <div className="mt-2 flex gap-1">
          <Button variant="outline" size="sm" className="h-7 flex-1 text-xs" onClick={onEdit}>
            <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
          </Button>
          {!lead.convertedCustomerId && (
            <Button
              variant="secondary"
              size="sm"
              className="h-7 flex-1 text-xs"
              onClick={onConvert}
            >
              <UserPlus className="mr-1 h-3.5 w-3.5" /> A cliente
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Alta manual de lead (Idealista, llamada, visita…) — origen propio al vuelo
// ============================================================================

const CUSTOM_SOURCE = '__custom__';

function LeadFormDialog({ lead, onClose }: { lead?: LeadDto; onClose: () => void }) {
  const isEdit = Boolean(lead);
  const create = useCreateLead();
  const update = useUpdateLead(lead?.id ?? '');
  const transition = useTransitionLead();
  const setMarketing = useSetLeadMarketing();
  const sources = useLeadSources();
  const facilities = useFacilities();

  const [status, setStatus] = useState<LeadStatusValue>(lead?.status ?? 'new');
  const [source, setSource] = useState(lead?.source ?? 'portal_inmobiliario');
  const [customSource, setCustomSource] = useState('');
  const [firstName, setFirstName] = useState(lead?.firstName ?? '');
  const [lastName, setLastName] = useState(lead?.lastName ?? '');
  const [companyName, setCompanyName] = useState(lead?.companyName ?? '');
  const [email, setEmail] = useState(lead?.email ?? '');
  const [phone, setPhone] = useState(lead?.phone ?? '');
  const [message, setMessage] = useState(lead?.message ?? '');
  const [facilityId, setFacilityId] = useState<string>(lead?.preferredFacilityId ?? '');
  const [unitTypeId, setUnitTypeId] = useState<string>(lead?.preferredUnitTypeId ?? '');
  const [lostReasonCode, setLostReasonCode] = useState<LeadLostReason | ''>(
    lead?.lostReasonCode ?? '',
  );
  const [lostReason, setLostReason] = useState(lead?.lostReason ?? '');
  const unitTypes = useUnitTypes();
  const [budget, setBudget] = useState(
    lead?.budgetMonthly != null ? String(lead.budgetMonthly) : '',
  );
  // Recibe comunicaciones comerciales: consentimiento dado y sin baja posterior.
  const initialMarketing = Boolean(lead?.marketingConsentAt && !lead.marketingOptOutAt);
  const [marketing, setMarketingConsent] = useState(initialMarketing);

  const resolvedSource = source === CUSTOM_SOURCE ? customSource.trim() : source;
  const hasName = Boolean(firstName.trim() || lastName.trim() || companyName.trim());
  const pending =
    create.isPending || update.isPending || transition.isPending || setMarketing.isPending;
  const needsLostReason = isEdit && status === 'lost' && lead?.status !== 'lost';
  const canSubmit =
    Boolean(resolvedSource) && hasName && !pending && (!needsLostReason || !!lostReasonCode);

  async function submit() {
    if (!canSubmit) return;
    const input = {
      source: resolvedSource,
      metadata: {},
      ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
      ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
      ...(companyName.trim() ? { companyName: companyName.trim() } : {}),
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(message.trim() ? { message: message.trim() } : {}),
      ...(facilityId ? { preferredFacilityId: facilityId } : {}),
      ...(unitTypeId ? { preferredUnitTypeId: unitTypeId } : {}),
      ...(budget && Number(budget) > 0 ? { budgetMonthly: Number(budget) } : {}),
    };
    try {
      if (isEdit && lead) {
        await update.mutateAsync(input);
        // La fase se cambia por su propio endpoint (transition), no por el update.
        if (status !== lead.status) {
          await transition.mutateAsync({
            id: lead.id,
            input: {
              status,
              ...(status === 'lost' && lostReasonCode ? { lostReasonCode } : {}),
              ...(status === 'lost' && lostReason.trim() ? { reason: lostReason.trim() } : {}),
            },
          });
        }
        if (marketing !== initialMarketing) {
          await setMarketing.mutateAsync({ id: lead.id, consent: marketing });
        }
        toast.success('Lead actualizado.');
      } else {
        await create.mutateAsync({ ...input, marketingConsent: marketing });
        toast.success('Lead creado. Está en «Nuevos» para hacerle seguimiento.');
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar el lead');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar lead' : 'Nuevo lead'}</DialogTitle>
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

          {isEdit && (
            <div className="space-y-1.5">
              <Label>Fase</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as LeadStatusValue)}>
                <SelectTrigger>
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
          )}
          {needsLostReason && (
            <LostReasonFields
              code={lostReasonCode}
              detail={lostReason}
              onCode={setLostReasonCode}
              onDetail={setLostReason}
            />
          )}

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
              <Label>Tamaño que busca (opcional)</Label>
              <Select value={unitTypeId} onValueChange={setUnitTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {(unitTypes.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
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
          <div className="flex items-start gap-2">
            <Checkbox
              id="lead-marketing"
              checked={marketing}
              onCheckedChange={(v) => setMarketingConsent(v === true)}
              className="mt-0.5"
            />
            <Label htmlFor="lead-marketing" className="text-sm font-normal leading-snug">
              Ha aceptado recibir ofertas y novedades
              <span className="block text-xs text-muted-foreground">
                Sin esto no recibirá campañas: aún no es cliente y la ley exige su permiso.
              </span>
            </Label>
          </div>
          {!hasName && (
            <p className="text-xs text-muted-foreground">
              Indica al menos un nombre, apellidos o empresa.
            </p>
          )}
        </div>
        {isEdit && lead && <LeadConversation lead={lead} />}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {pending ? 'Guardando…' : isEdit ? 'Guardar' : 'Crear lead'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LostReasonFields({
  code,
  detail,
  onCode,
  onDetail,
}: {
  code: LeadLostReason | '';
  detail: string;
  onCode: (c: LeadLostReason) => void;
  onDetail: (d: string) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="space-y-1.5">
        <Label>¿Por qué se ha perdido?</Label>
        <Select value={code} onValueChange={(v) => onCode(v as LeadLostReason)}>
          <SelectTrigger>
            <SelectValue placeholder="Elige el motivo" />
          </SelectTrigger>
          <SelectContent>
            {LeadLostReasonEnum.options.map((r) => (
              <SelectItem key={r} value={r}>
                {LEAD_LOST_REASON_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Si muchos se pierden porque les parece caro, la sugerencia de precio de ese tamaño lo
          tiene en cuenta.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label>Detalle (opcional)</Label>
        <Input
          value={detail}
          onChange={(e) => onDetail(e.target.value)}
          className="text-base sm:text-sm"
        />
      </div>
    </div>
  );
}

/** Motivo al arrastrar un contacto a «Perdidos». */
function LostReasonDialog({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const transition = useTransitionLead();
  const [code, setCode] = useState<LeadLostReason | ''>('');
  const [detail, setDetail] = useState('');

  async function confirmLost() {
    if (!code) return;
    try {
      await transition.mutateAsync({
        id: leadId,
        input: {
          status: 'lost',
          lostReasonCode: code,
          ...(detail.trim() ? { reason: detail.trim() } : {}),
        },
      });
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo mover el lead');
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Marcar como perdido</DialogTitle>
        </DialogHeader>
        <LostReasonFields code={code} detail={detail} onCode={setCode} onDetail={setDetail} />
        <DialogFooter>
          <Button onClick={() => void confirmLost()} disabled={!code || transition.isPending}>
            Marcar como perdido
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
