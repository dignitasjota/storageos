'use client';

import {
  ADMIN_MESSAGE_VARIABLES,
  PLATFORM_ANNOUNCEMENT_STATUS_LABELS,
  type AnnouncementSegment,
  type PlatformAnnouncementDto,
} from '@storageos/shared';
import {
  CalendarClock,
  Copy,
  Loader2,
  Mail,
  Pencil,
  RotateCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { EmailPreviewFrame } from '@/components/admin/comms/email-preview-frame';
import { cleanSegment, SegmentBuilder } from '@/components/admin/comms/segment-builder';
import { useConfirm } from '@/components/confirm-provider';
import { DateTimeSelect } from '@/components/date-time-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useAnnouncementAction,
  useAnnouncementsHistory,
  useSaveAnnouncement,
} from '@/lib/admin/comms-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

interface Draft {
  id?: string;
  subject: string;
  body: string;
  segment: AnnouncementSegment;
  commercial: boolean;
}

const EMPTY: Draft = { subject: '', body: '', segment: { audience: 'active' }, commercial: false };

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  scheduled: 'secondary',
  sending: 'secondary',
  sent: 'default',
  cancelled: 'outline',
};

const FOOTER = '¿Dudas? Escríbenos desde Soporte en tu panel: https://trasteros.pro/support';

function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.body.message : 'No se pudo completar.';
}

export default function AdminAnnouncementsPage() {
  const [tab, setTab] = useState('new');
  const [draft, setDraft] = useState<Draft>(EMPTY);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Anuncios</h1>
        <p className="text-sm text-muted-foreground">
          Correos a los propietarios de los tenants que elijas. También quedan en su panel, en
          Soporte → Mensajes de TrasterOS.
        </p>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="new">{draft.id ? 'Editar anuncio' : 'Nuevo anuncio'}</TabsTrigger>
          <TabsTrigger value="history">Historial</TabsTrigger>
        </TabsList>
        <TabsContent value="new" className="mt-4">
          <Editor
            draft={draft}
            onChange={setDraft}
            onDone={() => {
              setDraft(EMPTY);
              setTab('history');
            }}
          />
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <History
            onEdit={(a) => {
              setDraft({
                id: a.id,
                subject: a.subject,
                body: a.body,
                segment: a.segment,
                commercial: a.commercial,
              });
              setTab('new');
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Editor({
  draft,
  onChange,
  onDone,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onDone: () => void;
}) {
  const canEdit = useIsSuperadmin();
  const confirm = useConfirm();
  const save = useSaveAnnouncement();
  const action = useAnnouncementAction();
  const [scheduleAt, setScheduleAt] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const valid = draft.subject.trim().length >= 3 && draft.body.trim().length > 0;

  const insert = (snippet: string) => onChange({ ...draft, body: `${draft.body}${snippet}` });

  async function persist(): Promise<string> {
    const saved = await save.mutateAsync({
      ...(draft.id ? { id: draft.id } : {}),
      input: {
        subject: draft.subject.trim(),
        body: draft.body.trim(),
        segment: cleanSegment(draft.segment),
        commercial: draft.commercial,
      },
    });
    onChange({ ...draft, id: saved.id });
    return saved.id;
  }

  async function onSaveDraft() {
    try {
      await persist();
      toast.success('Borrador guardado.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function onSend(scheduledFor: string | null) {
    const ok = await confirm({
      title: scheduledFor
        ? `¿Programar el anuncio para el ${formatDateTime(scheduledFor)}?`
        : '¿Enviar el anuncio ahora?',
      description: 'Lo recibirán los propietarios del público que has elegido.',
    });
    if (!ok) return;
    try {
      const id = await persist();
      await action.mutateAsync({ id, action: 'send', scheduledFor });
      toast.success(
        scheduledFor
          ? 'Anuncio programado.'
          : 'Anuncio encolado: se envía en segundo plano. Lo que llega o rebota lo ves en el historial.',
      );
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">A quién</CardTitle>
          </CardHeader>
          <CardContent>
            <SegmentBuilder
              value={draft.segment}
              onChange={(segment) => onChange({ ...draft, segment })}
              commercial={draft.commercial}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mensaje</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="ann-subject">Asunto</Label>
              <Input
                id="ann-subject"
                value={draft.subject}
                maxLength={200}
                onChange={(e) => onChange({ ...draft, subject: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="ann-body">Texto</Label>
                <div className="flex flex-wrap gap-1">
                  {ADMIN_MESSAGE_VARIABLES.map((v) => (
                    <Button
                      key={v.key}
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      title={v.label}
                      onClick={() => insert(v.key)}
                    >
                      {v.key}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() =>
                      insert('\n\n[[boton: Ver la novedad | https://trasteros.pro/]]\n')
                    }
                  >
                    Botón
                  </Button>
                </div>
              </div>
              <Textarea
                id="ann-body"
                rows={12}
                value={draft.body}
                onChange={(e) => onChange({ ...draft, body: e.target.value })}
                placeholder="Escribe el anuncio…"
              />
              <p className="text-xs text-muted-foreground">
                **negrita**, listas con «- », títulos con «## », enlaces [texto](https://…) y
                botones con [[boton: Texto | https://…]]. {'{empresa}'} y {'{nombre}'} se cambian
                por los de cada destinatario.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={draft.commercial}
                onChange={(e) => onChange({ ...draft, commercial: e.target.checked })}
              />
              <span>
                Comunicación comercial (novedades u ofertas): lleva enlace de baja y no llega a
                quien se dio de baja. Los avisos de servicio no la llevan.
              </span>
            </label>
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center gap-2">
          {draft.id && (
            <Button variant="ghost" onClick={onDone}>
              Cancelar edición
            </Button>
          )}
          <Button
            variant="outline"
            disabled={!valid || !canEdit || save.isPending}
            onClick={() => void onSaveDraft()}
          >
            Guardar borrador
          </Button>
          <Button
            variant="outline"
            disabled={!valid || !canEdit}
            onClick={() => setShowSchedule((v) => !v)}
          >
            <CalendarClock className="mr-1.5 size-4" /> Programar
          </Button>
          <Button
            disabled={!valid || !canEdit || action.isPending}
            onClick={() => void onSend(null)}
          >
            <Send className="mr-1.5 size-4" /> Enviar ahora
          </Button>
        </div>
        {showSchedule && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3">
            <DateTimeSelect value={scheduleAt} onChange={setScheduleAt} />
            <Button
              size="sm"
              disabled={!scheduleAt || !valid}
              onClick={() => void onSend(scheduleAt)}
            >
              Programar el envío
            </Button>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label>Vista previa (con un tenant de ejemplo)</Label>
        <EmailPreviewFrame
          subject={draft.subject}
          body={draft.body}
          commercial={draft.commercial}
          footer={FOOTER}
        />
      </div>
    </div>
  );
}

function History({ onEdit }: { onEdit: (a: PlatformAnnouncementDto) => void }) {
  const history = useAnnouncementsHistory();
  const action = useAnnouncementAction();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();

  async function run(
    a: PlatformAnnouncementDto,
    act: 'cancel' | 'duplicate' | 'resend-missing' | 'delete',
  ) {
    if (
      act === 'resend-missing' &&
      !(await confirm({
        title: '¿Reenviar a quien no lo recibió?',
        description:
          'Se envía de nuevo a los correos que fallaron y a los nuevos propietarios del público.',
      }))
    )
      return;
    if (act === 'delete' && !(await confirm({ title: '¿Borrar este anuncio?' }))) return;
    try {
      const res = await action.mutateAsync({ id: a.id, action: act });
      if (act === 'resend-missing') {
        const r = (res ?? { recipients: 0 }) as { recipients: number };
        toast.success(
          r.recipients
            ? `Reenviado a ${r.recipients} destinatario(s).`
            : 'Todos lo recibieron: nada que reenviar.',
        );
      } else if (act === 'duplicate') {
        toast.success('Copia creada como borrador.');
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (history.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  const rows = history.data ?? [];
  if (rows.length === 0) {
    return (
      <p className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
        Aún no hay anuncios.
      </p>
    );
  }
  return (
    <ul className="divide-y rounded-md border bg-card">
      {rows.map((a) => (
        <li key={a.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{a.subject}</span>
              <Badge variant={STATUS_VARIANT[a.status] ?? 'outline'}>
                {PLATFORM_ANNOUNCEMENT_STATUS_LABELS[a.status]}
              </Badge>
              {a.commercial && <Badge variant="outline">Comercial</Badge>}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {a.status === 'scheduled' && a.scheduledFor
                ? `Se enviará el ${formatDateTime(a.scheduledFor)}`
                : a.sentAt
                  ? `Enviado el ${formatDateTime(a.sentAt)}`
                  : `Creado el ${formatDateTime(a.createdAt)}`}
              {a.createdByName ? ` · ${a.createdByName}` : ''}
            </p>
            {a.status === 'sent' && (
              <p className="mt-1 text-xs">
                {a.tenantsCount} tenant(s) · {a.recipientsCount} correo(s) · {a.delivered}{' '}
                entregado(s)
                {a.bounced ? ` · ${a.bounced} rebotado(s)` : ''}
                {a.failed ? ` · ${a.failed} fallido(s)` : ''}
                {a.optedOutCount ? ` · ${a.optedOutCount} de baja` : ''}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {(a.status === 'draft' || a.status === 'scheduled') && canEdit && (
              <Button size="sm" variant="outline" onClick={() => onEdit(a)}>
                <Pencil className="mr-1 size-3.5" /> Editar
              </Button>
            )}
            {a.status === 'scheduled' && canEdit && (
              <Button size="sm" variant="outline" onClick={() => void run(a, 'cancel')}>
                <X className="mr-1 size-3.5" /> Cancelar
              </Button>
            )}
            {a.status === 'sent' && (
              <Button size="sm" variant="outline" asChild>
                <Link href={`/admin/email-log?announcementId=${a.id}`}>
                  <Mail className="mr-1 size-3.5" /> Correos
                </Link>
              </Button>
            )}
            {a.status === 'sent' && canEdit && (
              <Button size="sm" variant="outline" onClick={() => void run(a, 'resend-missing')}>
                <RotateCw className="mr-1 size-3.5" /> Reenviar
              </Button>
            )}
            {canEdit && (
              <Button size="sm" variant="outline" onClick={() => void run(a, 'duplicate')}>
                <Copy className="mr-1 size-3.5" /> Duplicar
              </Button>
            )}
            {(a.status === 'draft' || a.status === 'cancelled') && canEdit && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Borrar"
                title="Borrar"
                onClick={() => void run(a, 'delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
