'use client';

import {
  campaignTemplateVariables,
  templateTextProblems,
  type CampaignChannel,
  type CampaignDto,
  type CampaignPreviewDto,
  type CampaignSegmentInput,
  type WhatsappTemplateDto,
} from '@storageos/shared';
import { AlertTriangle, ChevronDown, ChevronUp, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  EmailPreviewButton,
  SaveTemplateButton,
  TemplatePicker,
  TestSendButton,
} from './campaign-extras';
import { MarkupTextarea } from './markup-textarea';
import { SavedSegmentPicker } from './saved-segments';

import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
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
import { ApiError } from '@/lib/auth/api';
import { useHasFeature } from '@/lib/auth/hooks';
import {
  useCreateCampaign,
  usePreviewCampaign,
  useSendCampaign,
  useUpdateCampaign,
} from '@/lib/campaigns/hooks';
import { useFacilities, useUnitTypes } from '@/lib/facilities/hooks';
import { formatDateTime } from '@/lib/format';
import { useWhatsappSettings, useWhatsappTemplates } from '@/lib/whatsapp/hooks';

type ContractStatus = 'active' | 'none' | 'any' | 'former';

/**
 * Crear una campaña o cambiar un borrador. El formulario vive dentro del
 * diálogo: al cerrarlo se vacía.
 */
export function CampaignFormDialog({
  open,
  onOpenChange,
  campaign,
  initialCustomerIds = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Borrador a cambiar; sin él, campaña nueva. */
  campaign?: CampaignDto;
  initialCustomerIds?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{campaign ? 'Cambiar la campaña' : 'Nueva campaña'}</DialogTitle>
        </DialogHeader>
        {open && (
          <CampaignForm
            campaign={campaign}
            initialCustomerIds={initialCustomerIds}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Día y hora en la hora del navegador de una fecha ISO. */
function splitLocal(iso: string | null | undefined): { date: string; hour: string } {
  if (!iso) return { date: '', hour: '10' };
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hour: String(d.getHours()),
  };
}

const str = (n: number | undefined) => (n === undefined ? '' : String(n));

/** Un número entero dentro de un rango, o undefined si está vacío o no vale. */
function intIn(value: string, min: number, max: number): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

interface SegmentState {
  audience: 'customers' | 'leads';
  contractStatus: ContractStatus;
  overdueOnly: boolean;
  tag: string;
  leadStatus: string;
  facilityId: string;
  customerIds: string[];
  minMonths: string;
  maxMonths: string;
  unitTypeId: string;
  withoutInsurance: boolean;
  endingWithinDays: string;
  locale: string;
  excludeDebtors: boolean;
  createdWithinDays: string;
  excludeRecentDays: string;
}

function stateFromSegment(seg: CampaignSegmentInput | undefined, ids: string[]): SegmentState {
  const c = seg?.audience === 'customers' ? seg : undefined;
  const l = seg?.audience === 'leads' ? seg : undefined;
  return {
    audience: seg?.audience ?? 'customers',
    contractStatus: c?.contractStatus ?? 'any',
    overdueOnly: c?.overdueOnly ?? false,
    tag: c?.tag ?? '',
    leadStatus: l?.leadStatus ?? 'any',
    facilityId: seg?.facilityId ?? 'all',
    customerIds: c?.customerIds ?? ids,
    minMonths: str(c?.minMonths),
    maxMonths: str(c?.maxMonths),
    unitTypeId: c?.unitTypeId ?? 'all',
    withoutInsurance: c?.withoutInsurance ?? false,
    endingWithinDays: str(c?.endingWithinDays),
    locale: c?.locale ?? 'any',
    excludeDebtors: c?.excludeDebtors ?? false,
    createdWithinDays: str(l?.createdWithinDays),
    excludeRecentDays: str(seg?.excludeRecentDays),
  };
}

function segmentFromState(s: SegmentState): CampaignSegmentInput {
  const recent = intIn(s.excludeRecentDays, 1, 90);
  const facility = s.facilityId !== 'all' ? { facilityId: s.facilityId } : {};
  if (s.audience === 'leads') {
    const created = intIn(s.createdWithinDays, 1, 730);
    return {
      audience: 'leads',
      ...(s.leadStatus !== 'any' ? { leadStatus: s.leadStatus as 'new' } : {}),
      ...facility,
      ...(created ? { createdWithinDays: created } : {}),
      ...(recent ? { excludeRecentDays: recent } : {}),
    };
  }
  const minMonths = intIn(s.minMonths, 0, 600);
  const maxMonths = intIn(s.maxMonths, 0, 600);
  const ending = intIn(s.endingWithinDays, 1, 365);
  return {
    audience: 'customers',
    contractStatus: s.contractStatus,
    overdueOnly: s.overdueOnly,
    ...(s.tag.trim() ? { tag: s.tag.trim() } : {}),
    ...facility,
    ...(s.customerIds.length ? { customerIds: s.customerIds } : {}),
    ...(minMonths !== undefined ? { minMonths } : {}),
    ...(maxMonths !== undefined ? { maxMonths } : {}),
    ...(s.unitTypeId !== 'all' ? { unitTypeId: s.unitTypeId } : {}),
    ...(s.withoutInsurance ? { withoutInsurance: true } : {}),
    ...(ending ? { endingWithinDays: ending } : {}),
    ...(s.locale === 'es' || s.locale === 'en' ? { locale: s.locale } : {}),
    ...(s.excludeDebtors ? { excludeDebtors: true } : {}),
    ...(recent ? { excludeRecentDays: recent } : {}),
  };
}

/** ¿Hay algún filtro de «Más filtros» puesto? */
function hasExtraFilters(s: SegmentState): boolean {
  return (
    !!s.minMonths ||
    !!s.maxMonths ||
    s.unitTypeId !== 'all' ||
    s.withoutInsurance ||
    !!s.endingWithinDays ||
    s.locale !== 'any' ||
    s.excludeDebtors ||
    !!s.createdWithinDays ||
    !!s.excludeRecentDays
  );
}

function CampaignForm({
  campaign,
  initialCustomerIds,
  onDone,
}: {
  campaign?: CampaignDto;
  initialCustomerIds: string[];
  onDone: () => void;
}) {
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const send = useSendCampaign();
  const preview = usePreviewCampaign();
  const facilities = useFacilities();
  const unitTypes = useUnitTypes();
  const facilityList = facilities.data ?? [];
  const hasWhatsapp = useHasFeature('whatsapp_business');
  const whatsappSettings = useWhatsappSettings(hasWhatsapp);
  const whatsappReady = hasWhatsapp && !!whatsappSettings.data?.enabled;

  const initialSchedule = splitLocal(campaign?.scheduledFor);
  const [name, setName] = useState(campaign?.name ?? '');
  const [channel, setChannel] = useState<CampaignChannel>(campaign?.channel ?? 'email');
  const [subject, setSubject] = useState(campaign?.subject ?? '');
  const [body, setBody] = useState(campaign?.bodyText ?? '');
  const [withEnglish, setWithEnglish] = useState(!!campaign?.subjectEn);
  const [subjectEn, setSubjectEn] = useState(campaign?.subjectEn ?? '');
  const [bodyEn, setBodyEn] = useState(campaign?.bodyTextEn ?? '');
  const [couponCode, setCouponCode] = useState(campaign?.couponCode ?? '');
  const [waTemplate, setWaTemplate] = useState(
    campaign?.whatsappTemplate
      ? `${campaign.whatsappTemplate.name}|${campaign.whatsappTemplate.language}`
      : '',
  );
  const [waParams, setWaParams] = useState<string[]>(campaign?.whatsappTemplate?.params ?? []);
  const [seg, setSeg] = useState<SegmentState>(() =>
    stateFromSegment(campaign?.segment, initialCustomerIds),
  );
  const [moreFilters, setMoreFilters] = useState(() => hasExtraFilters(seg));
  const [schedule, setSchedule] = useState(!!campaign?.scheduledFor);
  const [scheduleDate, setScheduleDate] = useState(initialSchedule.date);
  const [scheduleHour, setScheduleHour] = useState(initialSchedule.hour);
  const [counts, setCounts] = useState<CampaignPreviewDto | null>(null);

  const isWhatsapp = channel === 'whatsapp';
  const templates = useWhatsappTemplates(isWhatsapp && whatsappReady);
  const templateList = templates.data?.templates ?? [];
  const chosenTemplate: WhatsappTemplateDto | undefined = templateList.find(
    (t) => `${t.name}|${t.language}` === waTemplate,
  );

  const coupon = couponCode.trim();
  const variables = campaignTemplateVariables(seg.audience, !!coupon);
  const problems = useMemo(() => {
    const out: string[] = [];
    const check = (label: string, text: string) =>
      templateTextProblems(text, variables).forEach((p) => out.push(`${label}: ${p}`));
    if (isWhatsapp) {
      waParams.forEach((p, i) => check(`Variable {{${i + 1}}}`, p));
    } else {
      check('Asunto', subject);
      check('Mensaje', body);
      if (withEnglish) {
        check('Asunto en inglés', subjectEn);
        check('Mensaje en inglés', bodyEn);
      }
    }
    return out;
  }, [isWhatsapp, waParams, subject, body, withEnglish, subjectEn, bodyEn, variables]);
  const busy = create.isPending || update.isPending || send.isPending;

  function patch(p: Partial<SegmentState>) {
    setSeg((s) => ({ ...s, ...p }));
    setCounts(null);
  }

  function pickTemplate(key: string) {
    setWaTemplate(key);
    const t = templateList.find((x) => `${x.name}|${x.language}` === key);
    if (!t) return;
    const first = seg.audience === 'leads' ? '{{lead.firstName}}' : '{{customer.firstName}}';
    setWaParams(Array.from({ length: t.paramCount }, (_, i) => (i === 0 ? first : '')));
  }

  async function calcAudience() {
    try {
      setCounts(await preview.mutateAsync({ segment: segmentFromState(seg), channel }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo calcular');
    }
  }

  function scheduledFor(): string | null | false {
    if (!schedule) return null;
    if (!scheduleDate) {
      toast.error('Elige el día del envío.');
      return false;
    }
    const at = new Date(`${scheduleDate}T${scheduleHour.padStart(2, '0')}:00:00`);
    if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) {
      toast.error('La fecha del envío tiene que ser futura.');
      return false;
    }
    return at.toISOString();
  }

  /** Lo que se guarda según el canal. */
  function texts() {
    if (isWhatsapp) {
      if (!chosenTemplate) return null;
      return {
        subject: `WhatsApp: ${chosenTemplate.name}`,
        bodyText: chosenTemplate.body.slice(0, 20_000) || chosenTemplate.name,
        subjectEn: '',
        bodyTextEn: '',
        whatsappTemplate: {
          name: chosenTemplate.name,
          language: chosenTemplate.language,
          params: waParams.map((p) => p.trim()),
        },
      };
    }
    return {
      subject,
      bodyText: body,
      subjectEn: withEnglish ? subjectEn : '',
      bodyTextEn: withEnglish ? bodyEn : '',
      whatsappTemplate: null,
    };
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Ponle un nombre a la campaña.');
      return;
    }
    const t = texts();
    if (isWhatsapp) {
      if (!t) {
        toast.error('Elige la plantilla de WhatsApp.');
        return;
      }
      if (waParams.some((p) => !p.trim())) {
        toast.error('Rellena todas las variables de la plantilla.');
        return;
      }
    } else if (!subject.trim() || !body.trim()) {
      toast.error('Completa el asunto y el mensaje.');
      return;
    } else if (withEnglish && (!subjectEn.trim() || !bodyEn.trim())) {
      toast.error('Completa el asunto y el mensaje en inglés, o quita la versión en inglés.');
      return;
    }
    if (problems.length > 0) {
      toast.error('Revisa las variables del mensaje.');
      return;
    }
    const when = scheduledFor();
    if (when === false || !t) return;
    const segment = segmentFromState(seg);
    try {
      if (campaign) {
        await update.mutateAsync({
          id: campaign.id,
          input: {
            name,
            subject: t.subject,
            bodyText: t.bodyText,
            subjectEn: t.subjectEn,
            bodyTextEn: t.bodyTextEn,
            couponCode: coupon,
            ...(isWhatsapp ? { whatsappTemplate: t.whatsappTemplate } : {}),
            segment,
            scheduledFor: when,
          },
        });
        toast.success('Borrador guardado.');
        onDone();
        return;
      }
      const created = await create.mutateAsync({
        name,
        channel,
        subject: t.subject,
        bodyText: t.bodyText,
        ...(t.subjectEn ? { subjectEn: t.subjectEn, bodyTextEn: t.bodyTextEn } : {}),
        ...(coupon ? { couponCode: coupon } : {}),
        ...(t.whatsappTemplate ? { whatsappTemplate: t.whatsappTemplate } : {}),
        segment,
        ...(when ? { scheduledFor: when } : {}),
      });
      if (when) {
        // Programar es un solo paso: queda lista para salir en su fecha.
        await send.mutateAsync(created.id);
        toast.success(
          `Campaña programada para el ${formatDateTime(when)}. Quién la recibe se decide al salir; puedes cancelarla hasta entonces.`,
        );
      } else {
        toast.success('Campaña guardada en borrador. Pulsa «Enviar» cuando quieras.');
      }
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  const unitTypeList = unitTypes.data ?? [];

  return (
    <>
      <div className="space-y-3">
        {seg.customerIds.length > 0 && (
          <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
            Para los {seg.customerIds.length} inquilinos elegidos en la lista, sin quienes se dieron
            de baja de las comunicaciones comerciales.{' '}
            <button type="button" className="underline" onClick={() => patch({ customerIds: [] })}>
              Quitar
            </button>
          </p>
        )}
        <div className="space-y-1">
          <Label htmlFor="campaign-name">Nombre</Label>
          <Input
            id="campaign-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Promo verano"
            className="text-base sm:text-sm"
          />
        </div>

        {!campaign && (
          <div className="space-y-1">
            <Label>Canal</Label>
            <Select
              value={channel}
              onValueChange={(v) => {
                setChannel(v as CampaignChannel);
                setCounts(null);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Correo</SelectItem>
                <SelectItem value="whatsapp" disabled={!whatsappReady}>
                  WhatsApp{whatsappReady ? '' : ' (conecta el WhatsApp del negocio)'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        <SavedSegmentPicker
          current={() => segmentFromState(seg)}
          onPick={(s) => {
            const next = stateFromSegment(s, []);
            setSeg(next);
            setMoreFilters(hasExtraFilters(next));
            setCounts(null);
          }}
        />

        <div className="space-y-1">
          <Label>A quién va</Label>
          <Select
            value={seg.audience}
            onValueChange={(v) => patch({ audience: v as 'customers' | 'leads' })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="customers">Inquilinos</SelectItem>
              <SelectItem value="leads">Contactos (aún no son clientes)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {seg.audience === 'customers' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-sm">Contrato</Label>
              <Select
                value={seg.contractStatus}
                onValueChange={(v) => patch({ contractStatus: v as ContractStatus })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Todos</SelectItem>
                  <SelectItem value="active">Con contrato activo</SelectItem>
                  <SelectItem value="none">Sin contrato activo</SelectItem>
                  <SelectItem value="former">Ex-clientes (se fueron sin deber nada)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-sm" htmlFor="campaign-tag">
                Etiqueta (opcional)
              </Label>
              <Input
                id="campaign-tag"
                value={seg.tag}
                onChange={(e) => patch({ tag: e.target.value })}
                placeholder="vip"
                className="text-base sm:text-sm"
              />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={seg.overdueOnly}
                onChange={(e) => patch({ overdueOnly: e.target.checked })}
              />
              Solo con facturas vencidas
            </label>
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-sm">Estado del contacto</Label>
            <Select value={seg.leadStatus} onValueChange={(v) => patch({ leadStatus: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Cualquiera</SelectItem>
                <SelectItem value="new">Nuevo</SelectItem>
                <SelectItem value="contacted">Contactado</SelectItem>
                <SelectItem value="qualified">Cualificado</SelectItem>
                <SelectItem value="lost">Perdido</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {facilityList.length > 1 && (
          <div className="space-y-1">
            <Label className="text-sm">Local</Label>
            <Select value={seg.facilityId} onValueChange={(v) => patch({ facilityId: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los locales</SelectItem>
                {facilityList.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          onClick={() => setMoreFilters((v) => !v)}
        >
          {moreFilters ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          Más filtros
        </button>
        {moreFilters && (
          <div className="grid grid-cols-2 gap-3 rounded-md border p-3">
            {seg.audience === 'customers' ? (
              <>
                <div className="space-y-1">
                  <Label className="text-sm" htmlFor="seg-min">
                    Con nosotros desde hace (meses, mín.)
                  </Label>
                  <Input
                    id="seg-min"
                    inputMode="numeric"
                    value={seg.minMonths}
                    onChange={(e) => patch({ minMonths: e.target.value.replace(/\D/g, '') })}
                    className="text-base sm:text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm" htmlFor="seg-max">
                    … y como mucho (meses)
                  </Label>
                  <Input
                    id="seg-max"
                    inputMode="numeric"
                    value={seg.maxMonths}
                    onChange={(e) => patch({ maxMonths: e.target.value.replace(/\D/g, '') })}
                    className="text-base sm:text-sm"
                  />
                </div>
                {unitTypeList.length > 0 && (
                  <div className="col-span-2 space-y-1 sm:col-span-1">
                    <Label className="text-sm">Tamaño que tiene alquilado</Label>
                    <Select value={seg.unitTypeId} onValueChange={(v) => patch({ unitTypeId: v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Cualquiera</SelectItem>
                        {unitTypeList.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label className="text-sm" htmlFor="seg-ending">
                    Su contrato termina en (días)
                  </Label>
                  <Input
                    id="seg-ending"
                    inputMode="numeric"
                    value={seg.endingWithinDays}
                    onChange={(e) => patch({ endingWithinDays: e.target.value.replace(/\D/g, '') })}
                    className="text-base sm:text-sm"
                  />
                </div>
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label className="text-sm">Idioma</Label>
                  <Select value={seg.locale} onValueChange={(v) => patch({ locale: v })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Cualquiera</SelectItem>
                      <SelectItem value="es">Español</SelectItem>
                      <SelectItem value="en">Inglés</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="col-span-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={seg.withoutInsurance}
                    onChange={(e) => patch({ withoutInsurance: e.target.checked })}
                  />
                  Solo los que no tienen seguro
                </label>
                <label className="col-span-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={seg.excludeDebtors}
                    onChange={(e) => patch({ excludeDebtors: e.target.checked })}
                  />
                  Sin los que deben dinero
                </label>
              </>
            ) : (
              <div className="col-span-2 space-y-1">
                <Label className="text-sm" htmlFor="seg-created">
                  Llegaron en los últimos (días)
                </Label>
                <Input
                  id="seg-created"
                  inputMode="numeric"
                  value={seg.createdWithinDays}
                  onChange={(e) => patch({ createdWithinDays: e.target.value.replace(/\D/g, '') })}
                  className="text-base sm:text-sm"
                />
              </div>
            )}
            <div className="col-span-2 space-y-1">
              <Label className="text-sm" htmlFor="seg-recent">
                No escribir a quien recibió otra campaña en los últimos (días)
              </Label>
              <Input
                id="seg-recent"
                inputMode="numeric"
                value={seg.excludeRecentDays}
                onChange={(e) => patch({ excludeRecentDays: e.target.value.replace(/\D/g, '') })}
                placeholder="7"
                className="text-base sm:text-sm"
              />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void calcAudience()}
            disabled={preview.isPending}
          >
            <Users className="mr-1 h-4 w-4" />
            {preview.isPending ? 'Calculando…' : 'Calcular a cuántos llega'}
          </Button>
          {counts && (
            <span
              className={`text-sm ${counts.audienceCount === 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
            >
              {counts.audienceCount === 0
                ? 'Nadie la recibiría con estos filtros'
                : `${counts.audienceCount} ${counts.audienceCount === 1 ? 'destinatario' : 'destinatarios'}`}
            </span>
          )}
        </div>
        {counts && counts.audienceCount > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {counts.recentlyContacted > 0 && (
              <li>
                {counts.recentlyContacted} recibieron otra campaña en los últimos 7 días. Puedes
                dejarlos fuera en «Más filtros».
              </li>
            )}
            {!isWhatsapp && counts.english > 0 && (
              <li>
                {counts.english} tienen el idioma en inglés
                {withEnglish
                  ? ' y recibirán la versión en inglés.'
                  : '. Añade una versión en inglés.'}
              </li>
            )}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {isWhatsapp
            ? 'Solo a quien tiene móvil y no se dio de baja de las ofertas ni de WhatsApp; a los contactos, solo si aceptaron recibir ofertas.'
            : 'Cada dirección la recibe una vez. No cuentan quienes se dieron de baja, las direcciones que rebotan ni los contactos que no aceptaron recibir ofertas. Cada correo lleva un enlace para darse de baja.'}
        </p>

        <div className="space-y-1">
          <Label htmlFor="campaign-coupon">Cupón (opcional)</Label>
          <Input
            id="campaign-coupon"
            value={couponCode}
            onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
            placeholder="VERANO10"
            className="text-base sm:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Con un cupón, escribe {'{{coupon.code}}'} donde quieras que salga y verás en
            «Resultados» cuántos lo usaron.
          </p>
        </div>

        {isWhatsapp ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Plantilla aprobada de WhatsApp</Label>
              {templates.isLoading ? (
                <p className="text-sm text-muted-foreground">Cargando las plantillas…</p>
              ) : templates.data?.error ? (
                <p className="text-sm text-amber-700 dark:text-amber-400">{templates.data.error}</p>
              ) : templates.data && !templates.data.wabaConfigured ? (
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  Falta el ID de la cuenta de WhatsApp Business en Configuración → WhatsApp.
                </p>
              ) : (
                <Select value={waTemplate} onValueChange={pickTemplate}>
                  <SelectTrigger>
                    <SelectValue placeholder="Elige una plantilla" />
                  </SelectTrigger>
                  <SelectContent>
                    {templateList.map((t) => (
                      <SelectItem key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                        {t.name} ({t.language})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-xs text-muted-foreground">
                WhatsApp solo deja escribir primero con una plantilla que Meta haya aprobado.
              </p>
            </div>
            {chosenTemplate && (
              <>
                <p className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {chosenTemplate.body}
                </p>
                {waParams.map((p, i) => (
                  <div key={i} className="space-y-1">
                    <Label className="text-sm" htmlFor={`wa-param-${i}`}>
                      Variable {`{{${i + 1}}}`}
                    </Label>
                    <Input
                      id={`wa-param-${i}`}
                      value={p}
                      onChange={(e) =>
                        setWaParams((list) => list.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      className="text-base sm:text-sm"
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            <TemplatePicker
              onPick={(t) => {
                setSubject(t.subject);
                setBody(t.bodyText);
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="campaign-subject">Asunto</Label>
              <Input
                id="campaign-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={`Hola {{${variables[0]}}}`}
                className="text-base sm:text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="campaign-body">Mensaje</Label>
              <MarkupTextarea
                id="campaign-body"
                value={body}
                onChange={setBody}
                placeholder="Escribe el mensaje."
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={withEnglish}
                onChange={(e) => setWithEnglish(e.target.checked)}
              />
              Añadir una versión en inglés para los inquilinos en inglés
            </label>
            {withEnglish && (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1">
                  <Label htmlFor="campaign-subject-en">Asunto en inglés</Label>
                  <Input
                    id="campaign-subject-en"
                    value={subjectEn}
                    onChange={(e) => setSubjectEn(e.target.value)}
                    placeholder={`Hi {{${variables[0]}}}`}
                    className="text-base sm:text-sm"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="campaign-body-en">Mensaje en inglés</Label>
                  <MarkupTextarea
                    id="campaign-body-en"
                    value={bodyEn}
                    onChange={setBodyEn}
                    rows={5}
                  />
                </div>
              </div>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Variables: {variables.map((v) => `{{${v}}}`).join(' · ')}.
          {!isWhatsapp &&
            ' Los enlaces que pongas se cuentan: verás quién los pulsa en «Resultados».'}
        </p>
        {problems.length > 0 && (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <ul className="space-y-1">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        {!isWhatsapp && (
          <div className="flex flex-wrap gap-2">
            <EmailPreviewButton
              subject={subject}
              bodyText={body}
              audience={seg.audience}
              couponCode={coupon}
              disabled={problems.length > 0}
            />
            <TestSendButton
              subject={subject}
              bodyText={body}
              audience={seg.audience}
              couponCode={coupon}
              disabled={problems.length > 0}
            />
            {withEnglish && (
              <TestSendButton
                subject={subjectEn}
                bodyText={bodyEn}
                audience={seg.audience}
                couponCode={coupon}
                english
                disabled={problems.length > 0}
              />
            )}
            <SaveTemplateButton subject={subject} bodyText={body} disabled={problems.length > 0} />
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schedule}
            onChange={(e) => setSchedule(e.target.checked)}
          />
          Programar el envío para otro momento
        </label>
        {schedule && (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
              <div className="space-y-1">
                <Label className="text-sm">Día</Label>
                <DateSelect
                  value={scheduleDate || undefined}
                  onChange={(v) => setScheduleDate(v ?? '')}
                  future
                  years={2}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm">Hora</Label>
                <Select value={scheduleHour} onValueChange={setScheduleHour}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 24 }, (_, h) => (
                      <SelectItem key={h} value={String(h)}>
                        {String(h).padStart(2, '0')}:00
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Quién la recibe se decide al salir: los que se den de alta antes entran y los que se
              den de baja, no.
            </p>
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onDone}>
          Cancelar
        </Button>
        <Button onClick={() => void submit()} disabled={busy || problems.length > 0}>
          {busy
            ? 'Guardando…'
            : campaign
              ? 'Guardar'
              : schedule
                ? 'Programar el envío'
                : 'Guardar borrador'}
        </Button>
      </DialogFooter>
    </>
  );
}
