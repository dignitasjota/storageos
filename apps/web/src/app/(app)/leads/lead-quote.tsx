'use client';

import { FileText, MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import type { FirstPaymentMonths, LeadDto, LeadQuoteDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
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
import { useCompanyWide, useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useLeadQuotePreview, useSendLeadQuote } from '@/lib/communications/hooks';
import { useCreatePersonalCoupon } from '@/lib/coupons/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { useInsurancePlans } from '@/lib/insurance/hooks';
import { useLeadQuotes } from '@/lib/leads/hooks';

const eur = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const NONE = 'none';

/**
 * Presupuesto al contacto: local, tamaño, meses del primer pago, cupón y
 * seguro → lo que pagaría con IVA y un correo con el enlace a la reserva ya
 * rellenada. Si reserva, la reserva queda atribuida al contacto.
 */
export function LeadQuote({ lead }: { lead: LeadDto }) {
  const canSend = useHasPermission('communications:send');
  const hasInsurance = useHasFeature('insurance');
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const plans = useInsurancePlans(true);
  const preview = useLeadQuotePreview(lead.id);
  const send = useSendLeadQuote(lead.id);
  const [open, setOpen] = useState(false);
  const [facilityId, setFacilityId] = useState(lead.preferredFacilityId ?? '');
  const [unitTypeId, setUnitTypeId] = useState(lead.preferredUnitTypeId ?? '');
  const [months, setMonths] = useState<FirstPaymentMonths>(1);
  const [coupon, setCoupon] = useState('');
  // Cupón de un solo uso para este contacto (quien gestiona los cupones).
  const companyWide = useCompanyWide();
  const canCoupon = useHasPermission('promotions:manage') && companyWide;
  const personal = useCreatePersonalCoupon();
  const [personalOpen, setPersonalOpen] = useState(false);
  const [personalPct, setPersonalPct] = useState('10');
  const [personalDays, setPersonalDays] = useState('7');

  async function createPersonal() {
    const name =
      [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() ||
      lead.companyName ||
      lead.email ||
      'Contacto';
    try {
      const created = await personal.mutateAsync({
        personalFor: name,
        discountType: 'percentage',
        discountValue: Math.min(100, Math.max(1, Number(personalPct) || 10)),
        validDays: Math.min(90, Math.max(1, Number(personalDays) || 7)),
        minMonths: 1,
      });
      setCoupon(created.code);
      setPersonalOpen(false);
      toast.success(`Cupón ${created.code} creado y puesto en el presupuesto.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el cupón');
    }
  }
  const [planId, setPlanId] = useState(NONE);
  const [result, setResult] = useState<LeadQuoteDto | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [followupDays, setFollowupDays] = useState('3');
  const history = useLeadQuotes(lead.id);
  const waPhone = (lead.phone ?? '').replace(/\D/g, '');

  // Un local desactivado no admite reservas: el enlace del presupuesto no iría a ningún lado.
  const activeFacilities = (facilities.data ?? []).filter((f) => f.isActive);
  const onlyFacility = activeFacilities.length === 1 ? activeFacilities[0]?.id : undefined;

  useEffect(() => {
    if (!facilityId && onlyFacility) setFacilityId(onlyFacility);
  }, [onlyFacility, facilityId]);

  const input = {
    facilityId,
    unitTypeId,
    months,
    ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
    ...(planId !== NONE ? { insurancePlanId: planId } : {}),
  };

  async function calculate() {
    try {
      const r = await preview.mutateAsync(input);
      setResult(r);
      setSubject(r.subject);
      setBody(r.body);
    } catch (err) {
      setResult(null);
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular.');
    }
  }

  async function submit(channel: 'email' | 'whatsapp') {
    try {
      const r = await send.mutateAsync({
        ...input,
        subject,
        body,
        channel,
        followupInDays: Number(followupDays),
      });
      if (channel === 'whatsapp' && r.whatsappText) {
        // Se abre WhatsApp con el texto; el presupuesto queda registrado.
        const to = waPhone.length === 9 ? `34${waPhone}` : waPhone;
        window.open(
          `https://wa.me/${to}?text=${encodeURIComponent(r.whatsappText)}`,
          '_blank',
          'noopener',
        );
        toast.success('Presupuesto registrado: termina de enviarlo en WhatsApp.');
      } else {
        toast.success(`Presupuesto enviado a ${r.sentTo}.`);
      }
      setOpen(false);
      setResult(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    }
  }

  const sent = history.data ?? [];
  const historyBlock =
    sent.length > 0 ? (
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Presupuestos enviados</p>
        <ul className="space-y-1">
          {sent.slice(0, 5).map((q) => (
            <li key={q.id} className="flex flex-wrap items-center gap-x-2 text-xs">
              <span className="tabular-nums text-muted-foreground">
                {new Date(q.sentAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}
              </span>
              <span>
                {[q.unitTypeName, q.facilityName].filter(Boolean).join(' · ')} ·{' '}
                <span className="tabular-nums">{eur(q.totalToPay)}</span>
                {q.months > 1 ? ` (${q.months} meses)` : ''}
                {q.channel === 'whatsapp' ? ' · WhatsApp' : ''}
              </span>
              {q.bookedAt ? (
                <span className="font-medium text-green-700 dark:text-green-400">Reservó</span>
              ) : q.reminderSentAt ? (
                <span className="text-muted-foreground">Recordado</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (!canSend) return null;
  if (!open) {
    return (
      <div className="border-t pt-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
          <FileText className="mr-1 size-4" /> Preparar presupuesto
        </Button>
        {!lead.email && !waPhone && (
          <span className="ml-2 text-xs text-muted-foreground">
            Sin email ni teléfono: podrás calcularlo pero no enviarlo.
          </span>
        )}
        {historyBlock && <div className="mt-3">{historyBlock}</div>}
      </div>
    );
  }

  const q = result?.quote;
  return (
    <div className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Presupuesto</p>
      <div className="grid grid-cols-2 gap-2">
        <Select value={facilityId} onValueChange={(v) => setFacilityId(v)}>
          <SelectTrigger aria-label="Local">
            <SelectValue placeholder="Local" />
          </SelectTrigger>
          <SelectContent>
            {activeFacilities.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={unitTypeId} onValueChange={(v) => setUnitTypeId(v)}>
          <SelectTrigger aria-label="Tamaño">
            <SelectValue placeholder="Tamaño" />
          </SelectTrigger>
          <SelectContent>
            {(unitTypes.data ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(months)}
          onValueChange={(v) => setMonths(Number(v) as FirstPaymentMonths)}
        >
          <SelectTrigger aria-label="Meses del primer pago">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 3, 6, 12].map((m) => (
              <SelectItem key={m} value={String(m)}>
                {m === 1 ? 'Pago mensual' : `Primer pago de ${m} meses`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="space-y-1">
          <Input
            placeholder="Cupón (opcional)"
            value={coupon}
            onChange={(e) => setCoupon(e.target.value.toUpperCase())}
            aria-label="Cupón"
          />
          {canCoupon && !coupon && !personalOpen && (
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => setPersonalOpen(true)}
            >
              Crear un cupón solo para este contacto
            </button>
          )}
        </div>
        {personalOpen && (
          <div className="col-span-2 flex flex-wrap items-end gap-2 rounded-md border p-2">
            <div className="space-y-1">
              <Label htmlFor="quote-coupon-pct" className="text-xs">
                Descuento del primer pago (%)
              </Label>
              <Input
                id="quote-coupon-pct"
                type="number"
                min={1}
                max={100}
                className="h-8 w-24"
                value={personalPct}
                onChange={(e) => setPersonalPct(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="quote-coupon-days" className="text-xs">
                Días que vale
              </Label>
              <Input
                id="quote-coupon-days"
                type="number"
                min={1}
                max={90}
                className="h-8 w-24"
                value={personalDays}
                onChange={(e) => setPersonalDays(e.target.value)}
              />
            </div>
            <Button size="sm" onClick={createPersonal} disabled={personal.isPending}>
              {personal.isPending ? 'Creando...' : 'Crear cupón'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPersonalOpen(false)}>
              Cancelar
            </Button>
          </div>
        )}
        {hasInsurance && (plans.data?.length ?? 0) > 0 && (
          <Select value={planId} onValueChange={setPlanId}>
            <SelectTrigger aria-label="Seguro" className="col-span-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Sin protección de contenido</SelectItem>
              {(plans.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!facilityId || !unitTypeId || preview.isPending}
          onClick={() => void calculate()}
        >
          Calcular
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cerrar
        </Button>
      </div>

      {q && result && (
        <>
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <p className="font-medium">
              {result.unitTypeName}
              {result.areaM2 ? ` (${result.areaM2} m²)` : ''} · {result.facilityName}
            </p>
            <p>
              Alquiler {q.months > 1 ? `de ${q.months} meses` : 'del primer mes'}:{' '}
              <span className="tabular-nums">{eur(q.rentTotalWithVat)}</span> (IVA incl.)
              {q.freeMonths > 0 && ` · ${q.freeMonths} gratis`}
            </p>
            {q.insuranceWithVat > 0 && (
              <p>
                {result.insuranceName}:{' '}
                <span className="tabular-nums">{eur(q.insuranceWithVat)}</span>
              </p>
            )}
            {q.deposit > 0 && (
              <p>
                Fianza: <span className="tabular-nums">{eur(q.deposit)}</span>
              </p>
            )}
            <p className="font-medium">
              Total al reservar: <span className="tabular-nums">{eur(q.totalToPay)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Después {eur(result.monthlyWithVat)}/mes (IVA incl.).
              {q.prorated && ' El primer mes se prorratea si entra a mitad de mes.'}
            </p>
            {q.coupon && !q.coupon.valid && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Cupón no aplicado: {q.coupon.message}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="quote-subject">Asunto</Label>
            <Input
              id="quote-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="quote-body">Mensaje</Label>
            <Textarea
              id="quote-body"
              rows={9}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="quote-followup" className="text-xs font-normal">
              Recordarme llamarle
            </Label>
            <Select value={followupDays} onValueChange={setFollowupDays}>
              <SelectTrigger id="quote-followup" className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">No</SelectItem>
                <SelectItem value="1">Mañana</SelectItem>
                <SelectItem value="3">En 3 días</SelectItem>
                <SelectItem value="7">En una semana</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!lead.email || send.isPending}
              onClick={() => void submit('email')}
            >
              Enviar por correo
            </Button>
            {waPhone.length >= 9 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={send.isPending}
                onClick={() => void submit('whatsapp')}
              >
                <MessageCircle className="mr-1 size-4" /> Mandar por WhatsApp
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(result.bookUrl);
                toast.success('Enlace de reserva copiado.');
              }}
            >
              Copiar enlace de reserva
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
