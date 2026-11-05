'use client';

import {
  chatReplyChannel,
  CONVERSATION_STATUS_LABELS,
  fillCannedResponse,
  MESSAGE_THREAD_PAGE,
  type ConversationStatus,
  type CustomerMessageDto,
} from '@storageos/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ClipboardList,
  Loader2,
  Lock,
  MessageCircle,
  Send,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { SectionError } from '@/components/dashboard/section-state';
import {
  AttachmentList,
  AttachmentPicker,
  uploadMessageAttachments,
} from '@/components/messages/attachments';
import { MessageText } from '@/components/messages/message-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useSuggestReply } from '@/lib/ai/hooks';
import { ApiError } from '@/lib/auth/api';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import {
  fetchOlderCustomerMessages,
  presignCustomerMessageAttachment,
  useCustomerMessages,
  useSendCustomerMessage,
} from '@/lib/customers/hooks';
import {
  useCannedResponses,
  useConversationContext,
  useUpdateConversation,
} from '@/lib/messages/hooks';
import { useCreateIncident, useCreateTask } from '@/lib/operations/hooks';
import { useUsers } from '@/lib/users/hooks';
import { useCustomerWhatsappConversations } from '@/lib/whatsapp/hooks';

export function CustomerChatTab({ customerId }: { customerId: string }) {
  const messages = useCustomerMessages(customerId);
  const send = useSendCustomerMessage(customerId);
  const suggest = useSuggestReply();
  const hasAi = useHasFeature('ai_assistant');
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isInternal, setIsInternal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const canWrite = useHasPermission('customers:write');
  const context = useConversationContext(customerId);
  const canned = useCannedResponses();
  // El hilo trae los últimos; lo anterior se pide a mano.
  const [older, setOlder] = useState<CustomerMessageDto[]>([]);
  const [moreOlder, setMoreOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const latest = useMemo(() => messages.data ?? [], [messages.data]);
  const items = useMemo(() => {
    const seen = new Set(latest.map((m) => m.id));
    return [...older.filter((m) => !seen.has(m.id)), ...latest];
  }, [older, latest]);
  const hasOlder = moreOlder && latest.length >= MESSAGE_THREAD_PAGE;

  async function loadOlder() {
    const first = items[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const page = await fetchOlderCustomerMessages(customerId, first.id);
      setOlder((prev) => [...page, ...prev]);
      if (page.length < MESSAGE_THREAD_PAGE) setMoreOlder(false);
    } catch {
      toast.error('No se han podido cargar los mensajes anteriores.');
    } finally {
      setLoadingOlder(false);
    }
  }

  // La respuesta sale también por donde escribió el inquilino (WhatsApp en 24 h o email).
  const replyVia = chatReplyChannel(items);
  // Su conversación en el WhatsApp del negocio (otra bandeja), si la hay.
  const hasWhatsapp = useHasFeature('whatsapp_business');
  const canReadComms = useHasPermission('communications:read');
  const canWhatsapp = hasWhatsapp && canReadComms;
  const waConversations = useCustomerWhatsappConversations(customerId, canWhatsapp).data ?? [];

  async function suggestReply() {
    try {
      const res = await suggest.mutateAsync(customerId);
      setText(res.suggestion);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo sugerir una respuesta.');
    }
  }

  // Al cargar el hilo se marcan leídos en el server → refrescamos el badge.
  useEffect(() => {
    if (messages.isSuccess) {
      void qc.invalidateQueries({ queryKey: ['customers', 'unread-summary'] });
      void qc.invalidateQueries({ queryKey: ['customers', 'conversations'] });
    }
  }, [messages.isSuccess, messages.dataUpdatedAt, qc]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [latest.length]);

  async function submit() {
    const body = text.trim();
    if (!body && files.length === 0) return;
    setUploading(true);
    try {
      const attachments = await uploadMessageAttachments(files, (mime) =>
        presignCustomerMessageAttachment(customerId, mime),
      );
      await send.mutateAsync({ body, attachments, isInternal });
      setText('');
      setFiles([]);
      setIsInternal(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Chat con el inquilino</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {canWrite && <ConversationBar customerId={customerId} />}
        {context.data?.reach.unreachable && (
          <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            No se va a enterar: no tiene correo{context.data.reach.emailBlocked ? ' válido' : ''} y
            nunca ha entrado en su área de clientes. Avísale por teléfono.
          </p>
        )}
        {waConversations.map((c) => (
          <Link
            key={c.id}
            href={`/whatsapp?c=${c.id}`}
            className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
          >
            <MessageCircle className="size-4 shrink-0" />
            <span className="flex-1">
              También te escribe al WhatsApp del negocio
              {c.unreadCount > 0 ? ` · ${c.unreadCount} sin leer` : ''}
            </span>
            <span className="font-medium">Abrir</span>
          </Link>
        ))}
        {messages.isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : messages.isError ? (
          <SectionError onRetry={() => void messages.refetch()} />
        ) : (
          <div className="max-h-[28rem] space-y-2 overflow-y-auto rounded-md border p-3">
            {hasOlder && (
              <div className="text-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={loadOlder}
                  disabled={loadingOlder}
                >
                  {loadingOlder ? 'Cargando…' : 'Ver mensajes anteriores'}
                </Button>
              </div>
            )}
            {items.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {canWrite
                  ? 'Sin mensajes. Escribe para iniciar la conversación con el inquilino.'
                  : 'Sin mensajes.'}
              </p>
            ) : (
              items.map((m) => <MessageBubble key={m.id} message={m} customerId={customerId} />)
            )}
            <div ref={endRef} />
          </div>
        )}
        {canWrite && (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-muted-foreground">
                <Checkbox checked={isInternal} onCheckedChange={(c) => setIsInternal(c === true)} />
                Nota interna (el inquilino no la ve)
              </label>
              {(canned.data ?? []).length > 0 && (
                <Select
                  value=""
                  onValueChange={(id) => {
                    const c = canned.data?.find((r) => r.id === id);
                    if (c) setText(fillCannedResponse(c.body, context.data?.variables ?? {}));
                  }}
                >
                  <SelectTrigger className="h-8 w-56">
                    <SelectValue placeholder="Respuesta guardada…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(canned.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="flex gap-2">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder={
                  isInternal
                    ? 'Nota para el equipo…'
                    : 'Escribe una respuesta… (Mayús + Intro para otra línea)'
                }
                maxLength={5000}
                rows={2}
                className="min-h-10 resize-none"
              />
              <AttachmentPicker files={files} onChange={setFiles} disabled={uploading} />
              {hasAi && (
                <Button
                  variant="outline"
                  onClick={suggestReply}
                  disabled={suggest.isPending}
                  title="Sugerir respuesta con IA"
                  aria-label="Sugerir respuesta con IA"
                >
                  {suggest.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button
                onClick={submit}
                disabled={send.isPending || uploading || (!text.trim() && files.length === 0)}
                aria-label="Enviar"
              >
                {send.isPending || uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {replyVia === 'whatsapp'
                ? 'Te escribió por WhatsApp: la respuesta le llega también por WhatsApp y a su área de clientes.'
                : replyVia === 'email'
                  ? 'Te escribió por email: la respuesta le llega también por email. Si vuelve a contestar al correo, llega al buzón de tu negocio, no a este hilo.'
                  : 'La respuesta le llega a su área de clientes, con un aviso por correo (y en el móvil si lo tiene activado).'}
            </p>
          </>
        )}
        {hasAi && canWrite && (
          <p className="text-[11px] text-muted-foreground">
            <Sparkles className="mr-1 inline size-3" /> «Sugerir respuesta» redacta un borrador con
            IA a partir del hilo; revísalo antes de enviar.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Estado de la conversación y quién la lleva. */
function ConversationBar({ customerId }: { customerId: string }) {
  const context = useConversationContext(customerId);
  const update = useUpdateConversation(customerId);
  const users = useUsers();
  const data = context.data;
  if (!data) return null;
  const change = (input: Parameters<typeof update.mutate>[0]) =>
    update.mutate(input, {
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido cambiar.'),
    });
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select
        value={data.status}
        onValueChange={(status) => change({ status: status as ConversationStatus })}
      >
        <SelectTrigger className="h-8 w-40" aria-label="Estado de la conversación">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(CONVERSATION_STATUS_LABELS) as ConversationStatus[]).map((s) => (
            <SelectItem key={s} value={s}>
              {CONVERSATION_STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={data.assignedUserId ?? 'none'}
        onValueChange={(id) => change({ assignedUserId: id === 'none' ? null : id })}
      >
        <SelectTrigger className="h-8 w-52" aria-label="Quién la lleva">
          <SelectValue placeholder="Sin asignar" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Sin asignar</SelectItem>
          {(users.data ?? [])
            .filter((u) => u.isActive)
            .map((u) => (
              <SelectItem key={u.id} value={u.id}>
                {u.fullName}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function MessageBubble({
  message: m,
  customerId,
}: {
  message: CustomerMessageDto;
  customerId: string;
}) {
  const fromStaff = m.senderType === 'staff';
  const bubble = m.isInternal
    ? 'border border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100'
    : fromStaff
      ? 'bg-primary text-primary-foreground'
      : 'bg-muted text-foreground';
  return (
    <div className={`flex ${fromStaff ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${bubble}`}>
        {m.isInternal && (
          <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide opacity-70">
            <Lock className="size-3" /> Nota interna
          </p>
        )}
        {m.isAuto && (
          <p className="text-[10px] font-medium uppercase tracking-wide opacity-60">
            Respuesta automática
          </p>
        )}
        {fromStaff && m.senderName && (
          <p className="text-xs font-medium opacity-70">{m.senderName}</p>
        )}
        {!fromStaff && m.channel !== 'portal' && (
          <p className="text-[10px] font-medium uppercase tracking-wide opacity-60">
            vía {m.channel === 'whatsapp' ? 'WhatsApp' : 'email'}
          </p>
        )}
        {!fromStaff && !m.senderVerified && (
          <p
            className="mb-1 flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            title="El proveedor de email no ha verificado (DMARC) que este mensaje venga realmente de la dirección del inquilino. No actúes sobre datos sensibles (IBAN, accesos…) sin confirmarlo por otra vía."
          >
            <ShieldAlert className="h-3 w-3 shrink-0" />
            Remitente no verificado: confírmalo antes de actuar
          </p>
        )}
        {m.body && <MessageText text={m.body} />}
        <AttachmentList attachments={m.attachments} />
        <div className="mt-0.5 flex items-center justify-between gap-3">
          <p className="flex items-center gap-1 text-[10px] opacity-60">
            {new Date(m.createdAt).toLocaleString('es-ES', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {fromStaff && !m.isInternal && (
              <span
                className="inline-flex items-center gap-0.5"
                title={m.readAt ? 'Lo ha visto' : 'Aún no lo ha visto'}
              >
                {m.readAt ? <CheckCheck className="size-3" /> : <Check className="size-3" />}
                {m.readAt ? 'Visto' : ''}
              </span>
            )}
          </p>
          {!fromStaff && <MessageActions message={m} customerId={customerId} />}
        </div>
      </div>
    </div>
  );
}

/** De un mensaje a una incidencia o una tarea, con su texto ya puesto. */
function MessageActions({
  message,
  customerId,
}: {
  message: CustomerMessageDto;
  customerId: string;
}) {
  const canIncident = useHasPermission('incidents:write');
  const canTask = useHasPermission('tasks:write');
  const createIncident = useCreateIncident();
  const createTask = useCreateTask();
  const title = (message.body || 'Mensaje del inquilino').replace(/\s+/g, ' ').slice(0, 80);
  const description = `${message.body}\n\n/customers/${customerId}?tab=chat`.slice(0, 2000);

  async function incident() {
    try {
      await createIncident.mutateAsync({
        severity: 'medium',
        title,
        description,
        customerId,
        metadata: { source: 'customer_message', messageId: message.id },
      });
      toast.success('Incidencia creada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido crear.');
    }
  }

  async function task() {
    try {
      await createTask.mutateAsync({
        type: 'other',
        priority: 'normal',
        title,
        description,
        metadata: { source: 'customer_message', messageId: message.id, customerId },
      });
      toast.success('Tarea creada.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se ha podido crear.');
    }
  }

  return (
    <span className="flex gap-1 opacity-60">
      {canIncident && (
        <button
          type="button"
          onClick={incident}
          disabled={createIncident.isPending}
          aria-label="Crear incidencia con este mensaje"
          title="Crear incidencia"
          className="hover:opacity-100"
        >
          <AlertTriangle className="size-3.5" />
        </button>
      )}
      {canTask && (
        <button
          type="button"
          onClick={task}
          disabled={createTask.isPending}
          aria-label="Crear tarea con este mensaje"
          title="Crear tarea"
          className="hover:opacity-100"
        >
          <ClipboardList className="size-3.5" />
        </button>
      )}
    </span>
  );
}
