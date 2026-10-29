'use client';

import { MapPin, MessageCircle, Navigation, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { PortalFacilityDto, PortalFacilityPlanDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** Un local del inquilino: fotos, cómo llegar, contacto, horarios y su trastero en el plano. */
export function FacilityInfoCard({ facility: f }: { facility: PortalFacilityDto }) {
  const t = useTranslations('portal.consume.facility');
  const hours = f.openingHours ?? {};
  const hasHours = DAYS.some((d) => hours[d]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MapPin className="h-5 w-5 text-muted-foreground" /> {f.name}
        </CardTitle>
        {(f.address || f.city) && (
          <CardDescription>
            {[f.address, f.postalCode, f.city].filter(Boolean).join(', ')}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {(f.imageUrls ?? []).length > 0 && (
          <div className="-mx-1 flex snap-x gap-2 overflow-x-auto px-1 pb-1">
            {(f.imageUrls ?? []).map((url) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={url}
                src={url}
                alt={f.name}
                className="h-36 w-56 shrink-0 snap-start rounded-md object-cover"
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {f.directionsUrl && (
            <Button asChild size="sm">
              <a href={f.directionsUrl} target="_blank" rel="noopener noreferrer">
                <Navigation className="mr-1 h-4 w-4" /> {t('directions')}
              </a>
            </Button>
          )}
          {f.contactPhone && (
            <Button asChild size="sm" variant="outline">
              <a href={`tel:${f.contactPhone}`}>
                <Phone className="mr-1 h-4 w-4" /> {t('call')}
              </a>
            </Button>
          )}
          {f.whatsappNumber && (
            <Button asChild size="sm" variant="outline">
              <a
                href={`https://wa.me/${f.whatsappNumber}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <MessageCircle className="mr-1 h-4 w-4" /> WhatsApp
              </a>
            </Button>
          )}
          {f.contactEmail && (
            <Button asChild size="sm" variant="ghost">
              <a href={`mailto:${f.contactEmail}`}>{f.contactEmail}</a>
            </Button>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="font-medium">{t('accessTitle')}</p>
            <p className="text-muted-foreground">
              {f.accessCurfewEnabled && f.accessCurfewStart && f.accessCurfewEnd
                ? t('curfewClosed', { start: f.accessCurfewStart, end: f.accessCurfewEnd })
                : t('curfew24h')}
            </p>
            {(f.myUnitCodes ?? []).length > 0 && (
              <p className="text-muted-foreground">
                {t('yourUnits', { codes: (f.myUnitCodes ?? []).join(', ') })}
              </p>
            )}
          </div>
          {hasHours && (
            <div className="space-y-1">
              <p className="font-medium">{t('officeHours')}</p>
              <ul className="text-muted-foreground">
                {DAYS.map((d) => (
                  <li key={d} className="flex justify-between gap-3">
                    <span>{t(`day.${d}`)}</span>
                    <span className="tabular-nums">
                      {hours[d] ? `${hours[d]!.open}–${hours[d]!.close}` : t('closed')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {(f.plans ?? []).map((p) => (
          <FacilityPlan key={p.floorName} plan={p} label={t('planTitle', { floor: p.floorName })} />
        ))}

        {f.mapEmbedUrl && (
          <iframe
            title={f.name}
            src={f.mapEmbedUrl}
            loading="lazy"
            className="h-56 w-full rounded-md border"
            referrerPolicy="no-referrer-when-downgrade"
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Plano de la planta con su trastero resaltado. */
function FacilityPlan({ plan, label }: { plan: PortalFacilityPlanDto; label: string }) {
  return (
    <div className="space-y-1">
      <p className="font-medium">{label}</p>
      <svg
        viewBox={`0 0 ${plan.width} ${plan.height}`}
        className="h-auto w-full rounded-md border bg-muted/30"
        role="img"
        aria-label={label}
      >
        {plan.imageUrl && (
          <image href={plan.imageUrl} x={0} y={0} width={plan.width} height={plan.height} />
        )}
        {plan.units.map((u) => (
          <g key={u.code}>
            <rect
              x={u.x}
              y={u.y}
              width={u.width}
              height={u.height}
              rx={3}
              className={
                u.mine
                  ? 'fill-primary stroke-primary'
                  : 'fill-background/60 stroke-muted-foreground/40'
              }
              strokeWidth={u.mine ? 3 : 1}
            />
            {u.mine && (
              <text
                x={u.x + u.width / 2}
                y={u.y + u.height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                className="fill-primary-foreground text-[14px] font-semibold"
              >
                {u.code}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}
