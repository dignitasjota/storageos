'use client';

import {
  CAMPAIGN_AUTOMATION_DEFAULTS,
  CAMPAIGN_TEMPLATE_VARIABLES,
  templateTextProblems,
  type CampaignAutomationDto,
  type CampaignAutomationKind,
} from '@storageos/shared';
import { AlertTriangle, CalendarHeart, UserRoundSearch } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { MarkupTextarea } from './markup-textarea';

import { SectionError } from '@/components/dashboard/section-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/auth/api';
import { useCampaignAutomations, useUpdateCampaignAutomation } from '@/lib/campaigns/hooks';

const COPY: Record<
  CampaignAutomationKind,
  { title: string; description: string; icon: typeof CalendarHeart }
> = {
  anniversary: {
    title: 'Aniversario del inquilino',
    description:
      'El día que un inquilino con contrato en vigor cumple años con vosotros, un correo de agradecimiento (una vez al año, nunca a quien debe dinero).',
    icon: CalendarHeart,
  },
  cold_leads: {
    title: 'Contactos que no avanzan',
    description:
      'Un correo a los contactos que aceptaron recibir ofertas y llevan un tiempo sin moverse (una sola vez por contacto).',
    icon: UserRoundSearch,
  },
};

/** Campañas que salen solas, además del win-back. */
export function CampaignAutomationsCard() {
  const automations = useCampaignAutomations();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Campañas automáticas</CardTitle>
        <p className="text-sm text-muted-foreground">
          Salen solas cada mañana a quien le toca. Respetan las bajas y las direcciones que rebotan.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {automations.isError ? (
          <SectionError onRetry={() => void automations.refetch()} />
        ) : (
          (automations.data ?? []).map((a) => <AutomationRow key={a.kind} automation={a} />)
        )}
      </CardContent>
    </Card>
  );
}

function AutomationRow({ automation }: { automation: CampaignAutomationDto }) {
  const update = useUpdateCampaignAutomation();
  const defaults = CAMPAIGN_AUTOMATION_DEFAULTS[automation.kind];
  const copy = COPY[automation.kind];
  const Icon = copy.icon;
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(automation.subject ?? defaults.subject);
  const [body, setBody] = useState(automation.bodyText ?? defaults.bodyText);
  const [days, setDays] = useState(String(automation.days));
  const variables =
    automation.kind === 'cold_leads'
      ? CAMPAIGN_TEMPLATE_VARIABLES.leads
      : CAMPAIGN_TEMPLATE_VARIABLES.customers;
  const problems = [
    ...templateTextProblems(subject, variables).map((p) => `Asunto: ${p}`),
    ...templateTextProblems(body, variables).map((p) => `Mensaje: ${p}`),
  ];

  async function save(input: Parameters<typeof update.mutateAsync>[0]['input'], done?: string) {
    try {
      await update.mutateAsync({ kind: automation.kind, input });
      if (done) toast.success(done);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  async function saveTexts() {
    const n = Number(days);
    if (automation.kind === 'cold_leads' && (!Number.isInteger(n) || n < 7 || n > 365)) {
      toast.error('Los días tienen que estar entre 7 y 365.');
      return;
    }
    await save(
      {
        subject: subject.trim() === defaults.subject ? '' : subject,
        bodyText: body.trim() === defaults.bodyText ? '' : body,
        ...(automation.kind === 'cold_leads' ? { days: n } : {}),
      },
      'Guardado.',
    );
    setEditing(false);
  }

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">{copy.title}</p>
            <p className="text-sm text-muted-foreground">{copy.description}</p>
            <p className="text-xs text-muted-foreground">
              {automation.enabled ? 'Activada' : 'Apagada'}
              {automation.kind === 'cold_leads'
                ? ` · a los ${automation.days} días sin moverse`
                : ''}
              {` · ${automation.sentLast30Days} enviados en 30 días`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Cerrar' : 'Cambiar el texto'}
          </Button>
          <Button
            size="sm"
            variant={automation.enabled ? 'outline' : 'default'}
            disabled={update.isPending}
            onClick={() =>
              void save(
                { enabled: !automation.enabled },
                automation.enabled ? 'Campaña apagada.' : 'Campaña activada.',
              )
            }
          >
            {automation.enabled ? 'Apagar' : 'Activar'}
          </Button>
        </div>
      </div>
      {editing && (
        <div className="mt-3 space-y-3 border-t pt-3">
          {automation.kind === 'cold_leads' && (
            <div className="max-w-[220px] space-y-1">
              <Label htmlFor={`auto-days-${automation.kind}`} className="text-sm">
                Días sin moverse
              </Label>
              <Input
                id={`auto-days-${automation.kind}`}
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
                className="text-base sm:text-sm"
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`auto-subject-${automation.kind}`} className="text-sm">
              Asunto
            </Label>
            <Input
              id={`auto-subject-${automation.kind}`}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`auto-body-${automation.kind}`} className="text-sm">
              Mensaje
            </Label>
            <MarkupTextarea id={`auto-body-${automation.kind}`} value={body} onChange={setBody} />
            <p className="text-xs text-muted-foreground">
              Variables: {variables.map((v) => `{{${v}}}`).join(' · ')}.
            </p>
          </div>
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
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => void saveTexts()}
              disabled={update.isPending || problems.length > 0}
            >
              Guardar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSubject(defaults.subject);
                setBody(defaults.bodyText);
              }}
            >
              Volver al texto de siempre
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
