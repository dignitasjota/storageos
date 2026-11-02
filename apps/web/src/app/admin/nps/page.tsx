'use client';

import { Loader2, Lock, Plus, Send, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AnnouncementSegment, NpsSurveyDto } from '@storageos/shared';

import { cleanSegment, SegmentBuilder } from '@/components/admin/comms/segment-builder';
import { useConfirm } from '@/components/confirm-provider';
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
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateNpsSurvey,
  useNpsAction,
  useNpsSurvey,
  useNpsSurveys,
} from '@/lib/admin/comms-hooks';
import { useIsSuperadmin } from '@/lib/admin/use-is-superadmin';
import { ApiError } from '@/lib/auth/api';
import { formatDateTime } from '@/lib/format';

const STATUS = { draft: 'Borrador', sent: 'Enviada', closed: 'Cerrada' } as const;
const DEFAULT_QUESTION =
  '¿Qué probabilidad hay de que recomiendes TrasterOS a otro operador de trasteros?';

export default function AdminNpsPage() {
  const surveys = useNpsSurveys();
  const canEdit = useIsSuperadmin();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Encuestas de satisfacción</h1>
          <p className="text-sm text-muted-foreground">
            Pregunta a los propietarios de los tenants si recomendarían TrasterOS (de 0 a 10). El
            NPS es el % de los que puntúan 9-10 menos el % de los que puntúan 0-6.
          </p>
        </div>
        <Button disabled={!canEdit} onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 size-4" /> Nueva encuesta
        </Button>
      </div>
      {surveys.isLoading ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : (surveys.data ?? []).length === 0 ? (
        <p className="rounded-md border bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          Aún no hay encuestas.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(surveys.data ?? []).map((s) => (
            <SurveyCard key={s.id} survey={s} onOpen={() => setOpenId(s.id)} />
          ))}
        </div>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} />}
      {openId && <ResultsDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function SurveyCard({ survey: s, onOpen }: { survey: NpsSurveyDto; onOpen: () => void }) {
  const action = useNpsAction();
  const confirm = useConfirm();
  const canEdit = useIsSuperadmin();
  const run = async (act: 'send' | 'close' | 'delete') => {
    const titles = {
      send: '¿Enviar la encuesta a los propietarios del público?',
      close: '¿Cerrar la encuesta? Ya no se podrá contestar.',
      delete: '¿Borrar la encuesta y sus respuestas?',
    };
    if (!(await confirm({ title: titles[act] }))) return;
    try {
      await action.mutateAsync({ id: s.id, action: act });
      if (act === 'send') toast.success('Encuesta enviada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo completar.');
    }
  };
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{s.name}</CardTitle>
          <Badge variant={s.status === 'sent' ? 'default' : 'outline'}>{STATUS[s.status]}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {s.sentAt
            ? `Enviada el ${formatDateTime(s.sentAt)}`
            : `Creada el ${formatDateTime(s.createdAt)}`}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {s.status !== 'draft' && (
          <div className="flex items-end gap-4">
            <div>
              <p className="text-3xl font-semibold tabular-nums">{s.nps ?? '—'}</p>
              <p className="text-xs text-muted-foreground">NPS</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {s.responses} de {s.sent} han respondido · {s.promoters} promotores · {s.passives}{' '}
              pasivos · {s.detractors} detractores
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-1">
          {s.status !== 'draft' && (
            <Button size="sm" variant="outline" onClick={onOpen}>
              Ver respuestas
            </Button>
          )}
          {s.status === 'draft' && canEdit && (
            <Button size="sm" onClick={() => void run('send')}>
              <Send className="mr-1 size-3.5" /> Enviar
            </Button>
          )}
          {s.status === 'sent' && canEdit && (
            <Button size="sm" variant="outline" onClick={() => void run('close')}>
              <Lock className="mr-1 size-3.5" /> Cerrar
            </Button>
          )}
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="Borrar"
              title="Borrar"
              onClick={() => void run('delete')}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateNpsSurvey();
  const [name, setName] = useState('');
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [segment, setSegment] = useState<AnnouncementSegment>({ audience: 'active' });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Nueva encuesta</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nps-name">Nombre (solo lo ves tú)</Label>
            <Input
              id="nps-name"
              value={name}
              maxLength={120}
              placeholder="NPS otoño 2026"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nps-q">Pregunta</Label>
            <Textarea
              id="nps-q"
              rows={2}
              value={question}
              maxLength={300}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>A quién (propietarios con el email verificado)</Label>
            <SegmentBuilder value={segment} onChange={setSegment} commercial={false} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={name.trim().length < 3 || question.trim().length < 10 || create.isPending}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  name: name.trim(),
                  question: question.trim(),
                  segment: cleanSegment(segment),
                });
                toast.success('Encuesta creada como borrador. Envíala cuando quieras.');
                onClose();
              } catch (err) {
                toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear.');
              }
            }}
          >
            Crear
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const survey = useNpsSurvey(id);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{survey.data?.name ?? 'Respuestas'}</DialogTitle>
        </DialogHeader>
        {survey.isLoading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : (survey.data?.answers ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no ha respondido nadie.</p>
        ) : (
          <ul className="divide-y">
            {(survey.data?.answers ?? []).map((a) => (
              <li key={a.id} className="flex gap-3 py-2 text-sm">
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    a.score >= 9
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : a.score >= 7
                        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                        : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'
                  }`}
                >
                  {a.score}
                </span>
                <div className="min-w-0">
                  <Link
                    href={`/admin/tenants/${a.tenantId}`}
                    className="font-medium hover:underline"
                  >
                    {a.tenantName}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {a.email} · {formatDateTime(a.respondedAt)}
                  </p>
                  {a.comment && <p className="mt-1 whitespace-pre-wrap">{a.comment}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
