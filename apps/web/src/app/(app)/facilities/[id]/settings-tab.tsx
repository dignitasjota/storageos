'use client';

import {
  COMPETITOR_FEATURE_LABELS,
  CompetitorFeatureEnum,
  coordinatesFromMapsUrl,
  DayHoursSchema,
  isAllDay,
  toEmbedVideoUrl,
  WEEKDAYS,
  type CompetitorFeature,
} from '@storageos/shared';
import { ChevronLeft, ChevronRight, ImagePlus, Loader2, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { FacilityDetailsCard } from './details-card';
import { PreOpeningCard } from './pre-opening-card';

import type {
  DayHours,
  FacilityDto,
  OpeningException,
  OpeningHours,
  Weekday,
} from '@storageos/shared';

import { useConfirm } from '@/components/confirm-provider';
import { DateSelect } from '@/components/month-year-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useHasFeature } from '@/lib/auth/hooks';
import { localDateString } from '@/lib/dates';
import {
  uploadFacilityImage,
  useApplyOwnerToContracts,
  useContractsWithoutOwner,
  useSetFacilityImages,
  useUpdateFacility,
} from '@/lib/facilities/hooks';
import { useOwners } from '@/lib/owners/hooks';

export function FacilitySettingsTab({ facility }: { facility: FacilityDto }) {
  return (
    <div className="space-y-6">
      <FacilityDetailsCard facility={facility} />
      <PreOpeningCard facility={facility} />
      <OwnerCard facility={facility} />
      <OpeningHoursCard facility={facility} />
      <DirectionsCard facility={facility} />
      <CurfewCard facility={facility} />
      <FeaturesCard facility={facility} />
      <SlugCard facility={facility} />
      <ImagesCard facility={facility} />
      <VideoCard facility={facility} />
    </div>
  );
}

function VideoCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [videoUrl, setVideoUrl] = useState(facility.videoUrl ?? '');
  const embed = videoUrl.trim() ? toEmbedVideoUrl(videoUrl.trim()) : null;

  async function save() {
    try {
      await update.mutateAsync({ id: facility.id, input: { videoUrl: videoUrl.trim() } });
      toast.success('Vídeo actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Vídeo del local</CardTitle>
        <CardDescription>
          Enlace de YouTube o Vimeo. Se muestra en la página pública del local. Déjalo vacío para
          quitarlo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="video-url">Enlace del vídeo</Label>
            <Input
              id="video-url"
              value={videoUrl}
              placeholder="https://www.youtube.com/watch?v=…"
              onChange={(e) => setVideoUrl(e.target.value)}
            />
          </div>
          <Button
            onClick={save}
            disabled={update.isPending || videoUrl.trim() === (facility.videoUrl ?? '')}
          >
            {update.isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
        {videoUrl.trim() && (
          <p className="text-xs text-muted-foreground">
            {embed
              ? '✓ Se reconoce y se podrá embeber.'
              : '⚠ No se reconoce el formato: se mostrará como enlace "Ver vídeo" en vez de reproductor.'}
          </p>
        )}
        {embed && (
          <iframe
            src={embed}
            className="aspect-video w-full max-w-md rounded-md border"
            title="Vista previa del vídeo"
          />
        )}
      </CardContent>
    </Card>
  );
}

const DAY_LABELS: Record<Weekday, string> = {
  mon: 'Lunes',
  tue: 'Martes',
  wed: 'Miércoles',
  thu: 'Jueves',
  fri: 'Viernes',
  sat: 'Sábado',
  sun: 'Domingo',
};

const DEFAULT_DAY_HOURS: DayHours = { open: '09:00', close: '20:00' };
const ALL_DAY: DayHours = { open: '00:00', close: '00:00' };
const SECOND_SHIFT = { open2: '16:00', close2: '20:00' };

/** Primer fallo de un día, para avisar antes de guardar. */
function dayHoursIssue(h: DayHours | null | undefined): string | null {
  if (!h) return null;
  const parsed = DayHoursSchema.safeParse(h);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Horario no válido');
}

/** Las horas de un día: uno o dos turnos, o las 24 horas. */
function DayHoursFields({
  hours,
  onChange,
}: {
  hours: DayHours;
  onChange: (hours: DayHours) => void;
}) {
  const allDay = isAllDay(hours);
  const split = !!hours.open2 && !!hours.close2;
  const time = (field: keyof DayHours, label: string) => (
    <Input
      type="time"
      aria-label={label}
      value={hours[field] ?? ''}
      onChange={(e) => onChange({ ...hours, [field]: e.target.value })}
      className="h-9 w-28"
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      {!allDay && (
        <>
          {time('open', 'Abre')}
          <span className="text-sm text-muted-foreground">a</span>
          {time('close', 'Cierra')}
        </>
      )}
      {!allDay && split && (
        <>
          <span className="text-sm text-muted-foreground">y de</span>
          {time('open2', 'Abre por la tarde')}
          <span className="text-sm text-muted-foreground">a</span>
          {time('close2', 'Cierra por la tarde')}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Quitar el segundo turno"
            onClick={() => onChange({ open: hours.open, close: hours.close })}
          >
            <X className="h-4 w-4" />
          </Button>
        </>
      )}
      {!allDay && !split && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({
              ...hours,
              ...SECOND_SHIFT,
              // Un primer turno que ya llega a la tarde se acorta para dejarle sitio.
              close: hours.close === '00:00' || hours.close > '14:00' ? '14:00' : hours.close,
            })
          }
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Turno de tarde
        </Button>
      )}
      <label className="flex items-center gap-1.5 text-sm">
        <Checkbox
          checked={allDay}
          onCheckedChange={(v) => onChange(v === true ? ALL_DAY : DEFAULT_DAY_HOURS)}
        />
        24 horas
      </label>
    </div>
  );
}

function OpeningHoursCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [hours, setHours] = useState<OpeningHours>(facility.openingHours);
  // Los días ya pasados no vuelven a guardarse: se quedan fuera solos.
  const [exceptions, setExceptions] = useState<OpeningException[]>(() =>
    facility.openingExceptions.filter((e) => e.date >= localDateString()),
  );

  function copyToAll(day: Weekday) {
    const source = hours[day] ?? null;
    setHours(Object.fromEntries(WEEKDAYS.map((d) => [d, source])) as OpeningHours);
    toast.success(`Horario del ${DAY_LABELS[day].toLowerCase()} copiado a toda la semana.`);
  }

  function changeException(index: number, patch: Partial<OpeningException>) {
    setExceptions((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }

  async function save() {
    for (const day of WEEKDAYS) {
      const issue = dayHoursIssue(hours[day]);
      if (issue) {
        toast.error(`${DAY_LABELS[day]}: ${issue}`);
        return;
      }
    }
    const dates = exceptions.map((e) => e.date);
    if (dates.some((d) => !d)) {
      toast.error('Indica la fecha de cada día especial.');
      return;
    }
    if (new Set(dates).size !== dates.length) {
      toast.error('Hay dos días especiales con la misma fecha.');
      return;
    }
    const wrong = exceptions.find((e) => dayHoursIssue(e.hours));
    if (wrong) {
      toast.error(`${wrong.label || wrong.date}: ${dayHoursIssue(wrong.hours)}`);
      return;
    }
    try {
      await update.mutateAsync({
        id: facility.id,
        input: { openingHours: hours, openingExceptions: exceptions },
      });
      toast.success('Horario actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Horario de apertura</CardTitle>
        <CardDescription>
          Se muestra en la página pública del local y en el área de clientes (zona horaria:{' '}
          <span className="font-mono">{facility.timezone}</span>). Deja un día sin marcar si el
          local está cerrado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {WEEKDAYS.map((day) => {
          const dayHours = hours[day];
          return (
            <div
              key={day}
              className="flex flex-wrap items-center gap-3 border-b pb-2 last:border-0"
            >
              <label className="flex w-28 shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={dayHours != null}
                  onChange={(e) =>
                    setHours((prev) => ({
                      ...prev,
                      [day]: e.target.checked ? (prev[day] ?? DEFAULT_DAY_HOURS) : null,
                    }))
                  }
                  className="size-4"
                />
                {DAY_LABELS[day]}
              </label>
              {dayHours ? (
                <DayHoursFields
                  hours={dayHours}
                  onChange={(next) => setHours((prev) => ({ ...prev, [day]: next }))}
                />
              ) : (
                <span className="text-sm text-muted-foreground">Cerrado</span>
              )}
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ml-auto h-auto p-0 text-xs"
                onClick={() => copyToAll(day)}
              >
                Copiar a toda la semana
              </Button>
            </div>
          );
        })}

        <div className="space-y-3 pt-3">
          <div>
            <p className="text-sm font-medium">Festivos y días con otro horario</p>
            <p className="text-xs text-muted-foreground">
              Mandan sobre el horario de la semana. En la web salen los de los próximos 30 días.
            </p>
          </div>
          {exceptions.map((e, index) => (
            <div key={index} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <DateSelect
                  value={e.date || undefined}
                  future
                  years={3}
                  onChange={(date) => changeException(index, { date: date ?? '' })}
                />
                <Input
                  value={e.label ?? ''}
                  placeholder="Motivo (Navidad, inventario…)"
                  aria-label="Motivo"
                  maxLength={80}
                  onChange={(ev) => changeException(index, { label: ev.target.value })}
                  className="h-9 min-w-40 flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Quitar este día"
                  onClick={() => setExceptions((prev) => prev.filter((_, i) => i !== index))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={e.hours === null}
                    onCheckedChange={(v) =>
                      changeException(index, { hours: v === true ? null : DEFAULT_DAY_HOURS })
                    }
                  />
                  Cerrado
                </label>
                {e.hours && (
                  <DayHoursFields
                    hours={e.hours}
                    onChange={(next) => changeException(index, { hours: next })}
                  />
                )}
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={exceptions.length >= 60}
            onClick={() => setExceptions((prev) => [...prev, { date: '', hours: null }])}
          >
            <Plus className="mr-1 h-4 w-4" /> Añadir un día
          </Button>
        </div>

        <Button onClick={save} disabled={update.isPending} className="mt-2">
          {update.isPending ? 'Guardando...' : 'Guardar'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Cómo llegar: en la web, en el área de clientes y en el correo de contrato firmado. */
function DirectionsCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [directions, setDirections] = useState(facility.directions ?? '');
  const [mapsUrl, setMapsUrl] = useState(facility.mapsUrl ?? '');
  const link = mapsUrl.trim();
  const found = link ? coordinatesFromMapsUrl(link) : null;
  const changed =
    directions.trim() !== (facility.directions ?? '') || link !== (facility.mapsUrl ?? '');

  async function save() {
    try {
      await update.mutateAsync({
        id: facility.id,
        input: { directions: directions.trim(), mapsUrl: link },
      });
      toast.success('Cómo llegar actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cómo llegar</CardTitle>
        <CardDescription>
          Se ve en la página del local, en el área de clientes y en el correo de contrato firmado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="directions">Indicaciones</Label>
          <Textarea
            id="directions"
            value={directions}
            rows={3}
            maxLength={1000}
            placeholder="Entrada por la calle de atrás, junto a la gasolinera. Aparcamiento en la puerta."
            onChange={(e) => setDirections(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="maps-url">Enlace de Google Maps</Label>
          <Input
            id="maps-url"
            value={mapsUrl}
            placeholder="https://www.google.com/maps/place/…"
            onChange={(e) => setMapsUrl(e.target.value)}
          />
          {link && (
            <p className="text-xs text-muted-foreground">
              {found
                ? facility.latitude == null
                  ? `✓ Ubicación encontrada (${found.latitude}, ${found.longitude}): se usará para el mapa.`
                  : '✓ Enlace correcto. El mapa sigue con la ubicación que ya tiene el local.'
                : 'Este enlace no trae la ubicación (los cortos no la llevan): sirve de enlace, pero el mapa sigue con la dirección.'}
            </p>
          )}
        </div>
        <Button onClick={() => void save()} disabled={update.isPending || !changed}>
          {update.isPending ? 'Guardando...' : 'Guardar'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Características del local: la sugerencia de precio las compara con la competencia. */
function FeaturesCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [features, setFeatures] = useState<CompetitorFeature[]>(
    facility.features as CompetitorFeature[],
  );

  async function save() {
    try {
      await update.mutateAsync({ id: facility.id, input: { features } });
      toast.success('Características actualizadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Características del local</CardTitle>
        <CardDescription>
          Se ven en la página del local y se comparan con las de la competencia para que la
          sugerencia de precio compare lo comparable (por ejemplo, un competidor climatizado frente
          a un local que no lo está).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {CompetitorFeatureEnum.options.map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={features.includes(f)}
                onCheckedChange={(v) =>
                  setFeatures((prev) => (v === true ? [...prev, f] : prev.filter((x) => x !== f)))
                }
              />
              {COMPETITOR_FEATURE_LABELS[f]}
            </label>
          ))}
        </div>
        <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
          Guardar
        </Button>
      </CardContent>
    </Card>
  );
}

function CurfewCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [enabled, setEnabled] = useState(facility.accessCurfewEnabled);
  const [start, setStart] = useState(facility.accessCurfewStart ?? '00:00');
  const [end, setEnd] = useState(facility.accessCurfewEnd ?? '06:00');

  async function save() {
    if (enabled && start === end) {
      toast.error('El toque de queda tiene que empezar y acabar a horas distintas.');
      return;
    }
    try {
      await update.mutateAsync({
        id: facility.id,
        input: {
          accessCurfewEnabled: enabled,
          accessCurfewStart: enabled ? start : '',
          accessCurfewEnd: enabled ? end : '',
        },
      });
      toast.success('Toque de queda actualizado.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Toque de queda de acceso</CardTitle>
        <CardDescription>
          Bloquea el acceso en una franja (zona horaria del local:{' '}
          <span className="font-mono">{facility.timezone}</span>). Las credenciales con «acceso 24
          h» (las del equipo, por ejemplo) lo saltan.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4"
          />
          Activar toque de queda
        </label>
        {enabled && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Cerrado desde</Label>
              <Input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="h-9 w-32"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hasta</Label>
              <Input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="h-9 w-32"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              p. ej. de 00:00 a 06:00 = cerrado de medianoche a las 6.
            </p>
          </div>
        )}
        <Button onClick={save} disabled={update.isPending}>
          {update.isPending ? 'Guardando...' : 'Guardar'}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Propietario del local (plan Administrador). */
function OwnerCard({ facility }: { facility: FacilityDto }) {
  const hasFeature = useHasFeature('multi_owner');
  const owners = useOwners();
  const update = useUpdateFacility();
  const pending = useContractsWithoutOwner(facility.id, hasFeature && !!facility.ownerId);
  const apply = useApplyOwnerToContracts();
  if (!hasFeature && !facility.ownerId) return null;

  async function applyToContracts() {
    try {
      const res = await apply.mutateAsync(facility.id);
      toast.success(
        `${res.updated} ${res.updated === 1 ? 'contrato pasa' : 'contratos pasan'} a nombre de ${facility.ownerName ?? 'su propietario'}.`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }
  const pendingCount = pending.data?.count ?? 0;

  async function change(value: string) {
    const ownerId = value === 'none' ? null : value;
    try {
      await update.mutateAsync({ id: facility.id, input: { ownerId } });
      toast.success(ownerId ? 'Propietario asignado.' : 'Sin propietario: es del propio negocio.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  const active = (owners.data ?? []).filter((o) => o.isActive || o.id === facility.ownerId);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Propietario</CardTitle>
        <CardDescription>
          Los contratos nuevos de este local quedan a nombre de este propietario. Los ya creados
          conservan el suyo (si no tenían, puedes ponérselo abajo).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select
          value={facility.ownerId ?? 'none'}
          onValueChange={(v) => void change(v)}
          disabled={update.isPending}
        >
          <SelectTrigger className="max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Del propio negocio</SelectItem>
            {facility.ownerId && !active.some((o) => o.id === facility.ownerId) && (
              <SelectItem value={facility.ownerId}>
                {facility.ownerName ?? 'Propietario'}
              </SelectItem>
            )}
            {active.map((o) => (
              <SelectItem key={o.id} value={o.id} disabled={!hasFeature}>
                {o.legalName} · {o.taxId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {facility.ownerId && pendingCount > 0 && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p>
              {pendingCount === 1
                ? 'Hay 1 contrato de este local sin propietario'
                : `Hay ${pendingCount} contratos de este local sin propietario`}{' '}
              (se crearon antes de asignárselo, por ejemplo al importarlos). Sus facturas se emiten
              a nombre de tu empresa.
            </p>
            <Button
              size="sm"
              className="mt-2"
              disabled={apply.isPending || !hasFeature}
              onClick={() => void applyToContracts()}
            >
              Ponerlos a nombre de {facility.ownerName ?? 'este propietario'}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Las facturas que ya estén creadas no cambian de emisor; las siguientes las emitirá el
              propietario.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SlugCard({ facility }: { facility: FacilityDto }) {
  const update = useUpdateFacility();
  const [slug, setSlug] = useState(facility.publicSlug ?? '');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => setSlug(facility.publicSlug ?? ''), [facility.publicSlug]);

  async function save(value: string) {
    setSuggestion(null);
    try {
      await update.mutateAsync({ id: facility.id, input: { publicSlug: value } });
      toast.success('Dirección actualizada.');
    } catch (err) {
      if (!(err instanceof ApiError)) {
        toast.error('No se pudo guardar.');
        return;
      }
      const details = err.body.details as { suggestion?: string } | undefined;
      setSuggestion(details?.suggestion ?? null);
      toast.error(err.body.message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Dirección en tu web</CardTitle>
        <CardDescription>
          Lo que va en la dirección de la página de este local:{' '}
          <span className="font-mono">/s/&lt;empresa&gt;/{slug || '…'}</span>. Si la cambias, la
          dirección antigua sigue funcionando y lleva a la nueva.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="slug">Dirección web</Label>
            <Input
              id="slug"
              value={slug}
              placeholder="madrid-centro"
              onChange={(e) =>
                setSlug(
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, '-')
                    .replace(/-+/g, '-'),
                )
              }
            />
          </div>
          <Button
            onClick={() => void save(slug.trim())}
            disabled={update.isPending || !slug.trim() || slug === (facility.publicSlug ?? '')}
          >
            {update.isPending ? 'Guardando...' : 'Guardar'}
          </Button>
        </div>
        {suggestion && (
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              setSlug(suggestion);
              void save(suggestion);
            }}
          >
            Usar «{suggestion}»
          </Button>
        )}
        <p className="text-sm">
          <Link href={`/facilities/${facility.id}/poster`} className="text-primary hover:underline">
            Imprimir un cartel con el QR de esta página
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function ImagesCard({ facility }: { facility: FacilityDto }) {
  const ask = useConfirm();
  const setImages = useSetFacilityImages();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const currentKeys = facility.images.map((img) => img.key);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    e.target.value = '';
    if (currentKeys.length + files.length > 12) {
      toast.error('Máximo 12 imágenes por local.');
      return;
    }
    setUploading(true);
    try {
      const newKeys: string[] = [];
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
          toast.error(`Formato no soportado: ${file.name}`);
          continue;
        }
        newKeys.push(await uploadFacilityImage(facility.id, file));
      }
      if (newKeys.length > 0) {
        await setImages.mutateAsync({ id: facility.id, images: [...currentKeys, ...newKeys] });
        toast.success('Imágenes subidas.');
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo subir.');
    } finally {
      setUploading(false);
    }
  }

  async function moveTo(from: number, to: number) {
    if (from === to || to < 0 || to >= currentKeys.length) return;
    const next = [...currentKeys];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    try {
      await setImages.mutateAsync({ id: facility.id, images: next });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function remove(idx: number) {
    if (
      !(await ask({
        title: '¿Quitar esta imagen?',
        description: idx === 0 ? 'Es la portada: la siguiente pasará a serlo.' : undefined,
        confirmLabel: 'Quitar',
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await setImages.mutateAsync({
        id: facility.id,
        images: currentKeys.filter((_, i) => i !== idx),
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  async function saveAlt(key: string, value: string) {
    const text = value.trim();
    const previous = facility.images.find((img) => img.key === key)?.alt ?? '';
    if (text === previous) return;
    const alts = Object.fromEntries(
      facility.images.flatMap((img) => {
        const alt = img.key === key ? text : img.alt;
        return alt ? [[img.key, alt]] : [];
      }),
    );
    try {
      await setImages.mutateAsync({ id: facility.id, images: currentKeys, alts });
      toast.success('Descripción guardada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'Error');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Imágenes del local</CardTitle>
        <CardDescription>
          Se muestran en la página pública del local; la primera es la portada y puedes arrastrarlas
          para ordenarlas. Hasta 12 (PNG/JPG/WebP, máx. 2 MB — se comprimen automáticamente al
          subirlas). La descripción la leen Google y los lectores de pantalla.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {facility.images.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {facility.images.map((img, idx) => (
              <div key={img.key} className="space-y-1">
                <div
                  draggable
                  onDragStart={() => setDragged(idx)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(idx);
                  }}
                  onDragLeave={() => setOver((o) => (o === idx ? null : o))}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragged !== null) void moveTo(dragged, idx);
                    setDragged(null);
                    setOver(null);
                  }}
                  className={`group relative aspect-video cursor-grab overflow-hidden rounded-md border ${
                    over === idx && dragged !== idx ? 'ring-2 ring-primary' : ''
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.url}
                    alt={img.alt ?? ''}
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                  {idx === 0 && (
                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
                      Portada
                    </span>
                  )}
                  <div className="absolute inset-x-1 bottom-1 flex justify-between gap-1 sm:opacity-0 sm:transition sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <span className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => void moveTo(idx, idx - 1)}
                        disabled={setImages.isPending || idx === 0}
                        className="rounded bg-black/60 p-1 text-white disabled:opacity-40"
                        aria-label="Mover a la izquierda"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void moveTo(idx, idx + 1)}
                        disabled={setImages.isPending || idx === facility.images.length - 1}
                        className="rounded bg-black/60 p-1 text-white disabled:opacity-40"
                        aria-label="Mover a la derecha"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </span>
                    <button
                      type="button"
                      onClick={() => void remove(idx)}
                      disabled={setImages.isPending}
                      className="rounded bg-black/60 p-1 text-white"
                      aria-label="Eliminar imagen"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <Input
                  key={img.alt ?? ''}
                  defaultValue={img.alt ?? ''}
                  placeholder="Descripción"
                  aria-label={`Descripción de la imagen ${idx + 1}`}
                  maxLength={150}
                  onBlur={(e) => void saveAlt(img.key, e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Aún no has subido imágenes.</p>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={onPick}
        />
        <Button
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={uploading || setImages.isPending}
        >
          {uploading ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="mr-1 h-4 w-4" />
          )}
          Subir imágenes
        </Button>
      </CardContent>
    </Card>
  );
}
