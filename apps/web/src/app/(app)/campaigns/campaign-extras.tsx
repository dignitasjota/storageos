'use client';

import {
  CAMPAIGN_SAVED_TEMPLATE_VARIABLES,
  templateTextProblems,
  type CampaignRecipientFilter,
} from '@storageos/shared';
import { BarChart3, Eye, Loader2, Pencil, Save, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/confirm-provider';
import { SectionError } from '@/components/dashboard/section-state';
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
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/auth/api';
import {
  useCampaignRecipients,
  useCampaignResults,
  useCampaignTemplates,
  useCreateCampaignTemplate,
  useDeleteCampaignTemplate,
  useCampaignTestSend,
  usePreviewCampaignEmail,
  useUpdateCampaignTemplate,
  useWinbackStats,
} from '@/lib/campaigns/hooks';
import { formatEur } from '@/lib/format';

function pct(v: number | null): string {
  return v === null ? '—' : `${v.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
}

/** Entregados, rebotes, bajas y clics de una campaña enviada. */
export function CampaignResultsButton({ campaignId }: { campaignId: string }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CampaignRecipientFilter | null>(null);
  const results = useCampaignResults(open ? campaignId : null);
  const r = results.data;
  const c = r?.conversions;
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <BarChart3 className="mr-1 h-4 w-4" /> Resultados
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Resultados de la campaña</DialogTitle>
          </DialogHeader>
          {results.isError ? (
            <SectionError onRetry={() => void results.refetch()} />
          ) : !r ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Figure label="Enviados" value={String(r.sent)} />
                <Figure label="Entregados" value={String(r.delivered)} />
                <Figure
                  label="Rebotados"
                  value={String(r.bounced)}
                  warn={r.bounced > 0}
                  onClick={r.bounced > 0 ? () => setList('bounced') : undefined}
                />
                <Figure
                  label="Pulsaron un enlace"
                  value={`${r.clickers} (${pct(r.clickRate)})`}
                  onClick={r.clickers > 0 ? () => setList('clicked') : undefined}
                />
                <Figure
                  label="Se dieron de baja"
                  value={String(r.unsubscribed)}
                  onClick={r.unsubscribed > 0 ? () => setList('unsubscribed') : undefined}
                />
                <Figure
                  label="No enviados"
                  value={String(r.failed + r.skipped)}
                  warn={r.failed > 0}
                  onClick={r.failed + r.skipped > 0 ? () => setList('failed') : undefined}
                />
              </div>
              {c && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">
                    Lo que trajo (en los {c.windowDays} días siguientes)
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Figure
                      label="Contratos firmados"
                      value={String(c.contracts)}
                      onClick={
                        c.contracts + c.leadsWon > 0 ? () => setList('converted') : undefined
                      }
                    />
                    <Figure label="Cuotas al mes" value={formatEur(c.monthlyRevenue)} />
                    <Figure label="Contactos ganados" value={String(c.leadsWon)} />
                    <Figure label="Usaron el cupón" value={String(c.couponUses)} />
                  </div>
                </div>
              )}
              {list && (
                <RecipientList
                  campaignId={campaignId}
                  filter={list}
                  onClose={() => setList(null)}
                />
              )}
              <p className="text-xs text-muted-foreground">
                «Entregados» solo cuenta los que el proveedor de correo ha confirmado. Los clics se
                cuentan una vez por persona y enlace. Pulsa una cifra para ver quiénes son.
              </p>
              {r.links.length > 0 && (
                <div className="space-y-1">
                  <p className="text-sm font-medium">Enlaces</p>
                  <ul className="space-y-1 text-sm">
                    {r.links.map((l) => (
                      <li key={l.url} className="flex items-center gap-2">
                        <span
                          className="min-w-0 flex-1 truncate text-muted-foreground"
                          title={l.url}
                        >
                          {l.url}
                        </span>
                        <span className="shrink-0 font-medium">{l.clicks}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Figure({
  label,
  value,
  warn,
  onClick,
}: {
  label: string;
  value: string;
  warn?: boolean;
  onClick?: (() => void) | undefined;
}) {
  const content = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold ${warn ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        {value}
      </p>
    </>
  );
  if (!onClick) return <div className="rounded-lg border p-2">{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border p-2 text-left transition-colors hover:bg-muted/60"
    >
      {content}
    </button>
  );
}

const RECIPIENT_LIST_TITLES: Record<CampaignRecipientFilter, string> = {
  clicked: 'Pulsaron un enlace',
  bounced: 'Rebotaron',
  unsubscribed: 'Se dieron de baja',
  converted: 'Firmaron o pasaron a ganados',
  failed: 'No se enviaron',
};

/** Quiénes están detrás de una cifra de los resultados. */
function RecipientList({
  campaignId,
  filter,
  onClose,
}: {
  campaignId: string;
  filter: CampaignRecipientFilter;
  onClose: () => void;
}) {
  const list = useCampaignRecipients(campaignId, filter);
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{RECIPIENT_LIST_TITLES[filter]}</p>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      {list.isError ? (
        <SectionError onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nadie.</p>
      ) : (
        <ul className="max-h-60 space-y-1.5 overflow-y-auto text-sm">
          {list.data.map((p) => {
            const href = p.customerId
              ? `/customers/${p.customerId}`
              : p.leadId
                ? `/leads?lead=${p.leadId}`
                : null;
            return (
              <li key={`${p.recipient}-${p.customerId ?? p.leadId ?? ''}`} className="min-w-0">
                {href ? (
                  <Link href={href} className="font-medium hover:underline">
                    {p.name ?? p.recipient}
                  </Link>
                ) : (
                  <span className="font-medium">{p.name ?? p.recipient}</span>
                )}
                {p.name && <span className="text-muted-foreground"> · {p.recipient}</span>}
                {p.detail && <p className="text-xs text-muted-foreground">{p.detail}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Cómo llegará el correo, con la marca del negocio y un destinatario de ejemplo. */
export function EmailPreviewButton({
  subject,
  bodyText,
  audience,
  couponCode,
  disabled = false,
}: {
  subject: string;
  bodyText: string;
  audience: 'customers' | 'leads';
  couponCode?: string;
  disabled?: boolean;
}) {
  const preview = usePreviewCampaignEmail();
  const [open, setOpen] = useState(false);

  async function show() {
    try {
      await preview.mutateAsync({
        subject,
        bodyText,
        audience,
        ...(couponCode?.trim() ? { couponCode: couponCode.trim() } : {}),
      });
      setOpen(true);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se pudo preparar la vista previa',
      );
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => void show()}
        disabled={disabled || !subject.trim() || !bodyText.trim() || preview.isPending}
      >
        <Eye className="mr-1 h-4 w-4" /> Vista previa
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview.data?.subject ?? 'Vista previa'}</DialogTitle>
          </DialogHeader>
          {preview.data && (
            <iframe
              title="Vista previa del correo"
              sandbox=""
              srcDoc={preview.data.html}
              className="h-[60vh] w-full rounded-md border bg-white"
            />
          )}
          <p className="text-xs text-muted-foreground">
            Con un destinatario de ejemplo. El enlace de baja se añade al enviar.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Envía el correo de ejemplo a quien lo está preparando. */
export function TestSendButton({
  subject,
  bodyText,
  audience,
  couponCode,
  english = false,
  disabled = false,
}: {
  subject: string;
  bodyText: string;
  audience: 'customers' | 'leads';
  couponCode?: string;
  english?: boolean;
  disabled?: boolean;
}) {
  const test = useCampaignTestSend();
  async function send() {
    try {
      const res = await test.mutateAsync({
        subject,
        bodyText,
        audience,
        english,
        ...(couponCode?.trim() ? { couponCode: couponCode.trim() } : {}),
      });
      toast.success(`Te hemos enviado una prueba a ${res.sentTo}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar la prueba');
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void send()}
      disabled={disabled || !subject.trim() || !bodyText.trim() || test.isPending}
    >
      <Send className="mr-1 h-4 w-4" />
      {test.isPending
        ? 'Enviando…'
        : english
          ? 'Enviarme la versión en inglés'
          : 'Enviarme una prueba'}
    </Button>
  );
}

/** Elegir una plantilla guardada (rellena asunto y mensaje). */
export function TemplatePicker({
  onPick,
}: {
  onPick: (t: { subject: string; bodyText: string }) => void;
}) {
  const ask = useConfirm();
  const templates = useCampaignTemplates();
  const remove = useDeleteCampaignTemplate();
  const [selected, setSelected] = useState('');
  const [editing, setEditing] = useState(false);
  const list = templates.data ?? [];
  if (list.length === 0) return null;
  const current = list.find((t) => t.id === selected);
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1 space-y-1">
        <Label className="text-sm">Empezar desde una plantilla</Label>
        <Select
          value={selected}
          onValueChange={(id) => {
            setSelected(id);
            const t = list.find((x) => x.id === id);
            if (t) onPick({ subject: t.subject, bodyText: t.bodyText });
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder="Elige una plantilla" />
          </SelectTrigger>
          <SelectContent>
            {list.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {current && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cambiar la plantilla"
            title="Cambiar la plantilla"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Borrar la plantilla"
            title="Borrar la plantilla"
            onClick={async () => {
              if (!(await ask({ title: '¿Borrar la plantilla?', destructive: true }))) return;
              remove.mutate(selected, { onSuccess: () => setSelected('') });
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <EditTemplateDialog
            open={editing}
            onOpenChange={setEditing}
            template={current}
            onSaved={(t) => onPick({ subject: t.subject, bodyText: t.bodyText })}
          />
        </>
      )}
    </div>
  );
}

/** Cambiar el nombre, el asunto o el mensaje de una plantilla guardada. */
function EditTemplateDialog({
  open,
  onOpenChange,
  template,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: { id: string; name: string; subject: string; bodyText: string };
  onSaved: (t: { subject: string; bodyText: string }) => void;
}) {
  const update = useUpdateCampaignTemplate();
  const [name, setName] = useState(template.name);
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.bodyText);
  const problems = [
    ...templateTextProblems(subject, CAMPAIGN_SAVED_TEMPLATE_VARIABLES),
    ...templateTextProblems(body, CAMPAIGN_SAVED_TEMPLATE_VARIABLES),
  ];

  async function save() {
    try {
      const saved = await update.mutateAsync({
        id: template.id,
        input: { name: name.trim(), subject: subject.trim(), bodyText: body.trim() },
      });
      toast.success('Plantilla guardada.');
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Cambiar la plantilla</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="tpl-name">Nombre</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-subject">Asunto</Label>
            <Input
              id="tpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="text-base sm:text-sm"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-body">Mensaje</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
            />
          </div>
          {problems.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{problems.join(' ')}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            onClick={() => void save()}
            disabled={
              update.isPending ||
              problems.length > 0 ||
              !name.trim() ||
              !subject.trim() ||
              !body.trim()
            }
          >
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Guarda el asunto y el mensaje actuales como plantilla. */
export function SaveTemplateButton({
  subject,
  bodyText,
  disabled = false,
}: {
  subject: string;
  bodyText: string;
  disabled?: boolean;
}) {
  const create = useCreateCampaignTemplate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  async function save() {
    try {
      await create.mutateAsync({
        name: name.trim(),
        subject: subject.trim(),
        bodyText: bodyText.trim(),
      });
      toast.success('Plantilla guardada.');
      setOpen(false);
      setName('');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar');
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled || !subject.trim() || !bodyText.trim()}
      >
        <Save className="mr-1 h-4 w-4" /> Guardar como plantilla
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Guardar como plantilla</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="campaign-template-name">Nombre</Label>
            <Input
              id="campaign-template-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Oferta de verano"
              className="text-base sm:text-sm"
            />
          </div>
          <Button onClick={() => void save()} disabled={!name.trim() || create.isPending}>
            Guardar
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Cuántos ex-clientes recibieron el win-back y cuántos volvieron. */
export function WinbackStatsLine() {
  const stats = useWinbackStats();
  const s = stats.data;
  if (!s || s.firstSent === 0) return null;
  return (
    <p className="rounded-md bg-muted px-3 py-2 text-sm">
      {s.firstSent} ex-cliente{s.firstSent === 1 ? '' : 's'} recibieron el aviso
      {s.secondSent > 0 ? ` (${s.secondSent} también el segundo)` : ''} y{' '}
      <strong>
        {s.recovered} volvi{s.recovered === 1 ? 'ó' : 'eron'}
      </strong>{' '}
      ({pct(s.recoveryRate)}).
    </p>
  );
}
