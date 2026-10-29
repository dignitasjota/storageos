'use client';

import { ArrowLeft, Globe, Loader2, Mail, MessageCircle, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { CustomerChatTab } from '../customers/[id]/chat-tab';

import type { CustomerConversationDto, WhatsappConversationDto } from '@storageos/shared';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useWebChatConversations } from '@/lib/ai/web-chat-hooks';
import { useHasFeature, useHasPermission } from '@/lib/auth/hooks';
import { useCustomerConversations } from '@/lib/customers/hooks';
import { useHeaderFacilityId } from '@/lib/facilities/store';
import { useWhatsappConversations } from '@/lib/whatsapp/hooks';

/** Hora corta si es de hoy; si no, día y mes. */
function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
}

/**
 * Bandeja «Mensajes»: todas las conversaciones con inquilinos (portal, WhatsApp
 * y email de la plataforma) por último mensaje, con los no leídos de quien mira,
 * y la respuesta en la misma pantalla. Las del WhatsApp del negocio se enlazan.
 */
export default function MessagesPage() {
  const facilityId = useHeaderFacilityId();
  const conversations = useCustomerConversations(facilityId);
  const hasWhatsapp = useHasFeature('whatsapp_business');
  const canReadComms = useHasPermission('communications:read');
  const whatsapp = useWhatsappConversations(hasWhatsapp && canReadComms);
  const hasAi = useHasFeature('ai_assistant');
  const canReadMarketing = useHasPermission('marketing:read');
  const hasWebChat = hasAi && canReadMarketing;
  // Visitantes del chat de la web que esperan a una persona o han escrito al equipo.
  const webChat = useWebChatConversations(30, 'human', hasWebChat);
  const webItems = hasWebChat
    ? webChat.rows.filter((c) => c.waitingSince || c.staffUnread > 0)
    : [];
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);

  const items = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (conversations.data ?? []).filter(
      (c) =>
        (!onlyUnread || c.unread > 0) &&
        (!q ||
          c.customerName.toLowerCase().includes(q) ||
          c.lastMessage.body.toLowerCase().includes(q)),
    );
  }, [conversations.data, search, onlyUnread]);
  const waItems = (whatsapp.data ?? []).filter((c) => c.unreadCount > 0);
  const current = conversations.data?.find((c) => c.customerId === selected) ?? null;
  const totalUnread = (conversations.data ?? []).reduce((n, c) => n + c.unread, 0);

  return (
    <div className="space-y-4 px-4 py-4 sm:px-6 sm:py-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mensajes</h1>
        <p className="text-sm text-muted-foreground">
          Las conversaciones con tus inquilinos (área de clientes, WhatsApp y email), con la más
          reciente arriba. {totalUnread > 0 ? `${totalUnread} sin leer.` : 'Todo leído.'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Card className={selected ? 'hidden lg:block' : ''}>
          <CardContent className="space-y-3 p-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por inquilino o texto"
                className="pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                className="size-4"
                checked={onlyUnread}
                onChange={(e) => setOnlyUnread(e.target.checked)}
              />
              Solo sin leer
            </label>

            {waItems.length > 0 && (
              <div className="space-y-1">
                {waItems.map((c: WhatsappConversationDto) => (
                  <Link
                    key={c.id}
                    href={`/whatsapp?c=${c.id}`}
                    className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
                  >
                    <MessageCircle className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      WhatsApp del negocio · {c.customerName ?? c.contactName ?? c.waId}
                    </span>
                    <span className="rounded-full bg-emerald-600 px-1.5 text-xs text-white">
                      {c.unreadCount}
                    </span>
                  </Link>
                ))}
              </div>
            )}

            {webItems.length > 0 && (
              <div className="space-y-1">
                {webItems.map((c) => (
                  <Link
                    key={c.id}
                    href={`/marketing/web-chat?c=${c.id}`}
                    className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200"
                  >
                    <Globe className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      Chat de la web · {c.leadName ?? (c.preview || 'Visitante')}
                    </span>
                    <span className="rounded-full bg-blue-600 px-1.5 text-xs text-white">
                      {c.waitingSince ? 'Espera' : c.staffUnread}
                    </span>
                  </Link>
                ))}
              </div>
            )}

            {conversations.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : items.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {search || onlyUnread ? 'Nada con ese filtro.' : 'Aún no hay conversaciones.'}
              </p>
            ) : (
              <ul className="-mx-1 max-h-[65vh] space-y-0.5 overflow-y-auto">
                {items.map((c) => (
                  <ConversationRow
                    key={c.customerId}
                    c={c}
                    active={c.customerId === selected}
                    onSelect={() => setSelected(c.customerId)}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className={selected ? '' : 'hidden lg:block'}>
          {selected ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="lg:hidden"
                  onClick={() => setSelected(null)}
                >
                  <ArrowLeft className="mr-1 size-4" /> Conversaciones
                </Button>
                <span className="truncate font-medium">{current?.customerName}</span>
                <Button asChild variant="outline" size="sm">
                  <Link href={`/customers/${selected}`}>
                    <UserRound className="mr-1 size-4" /> Ficha
                  </Link>
                </Button>
              </div>
              <CustomerChatTab key={selected} customerId={selected} />
            </div>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-16 text-sm text-muted-foreground">
                <Mail className="size-6" />
                Elige una conversación para leerla y responder.
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationRow({
  c,
  active,
  onSelect,
}: {
  c: CustomerConversationDto;
  active: boolean;
  onSelect: () => void;
}) {
  const via =
    c.lastMessage.channel === 'whatsapp'
      ? 'WhatsApp · '
      : c.lastMessage.channel === 'email'
        ? 'Email · '
        : '';
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors ${
          active ? 'bg-accent' : 'hover:bg-accent/60'
        }`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm ${c.unread > 0 ? 'font-semibold' : 'font-medium'}`}>
              {c.customerName}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {when(c.lastMessage.createdAt)}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {c.lastMessage.senderType === 'staff' ? 'Tú: ' : via}
            {c.lastMessage.body}
          </p>
        </div>
        {c.unread > 0 && (
          <span className="mt-0.5 shrink-0 rounded-full bg-blue-500 px-1.5 text-xs font-medium text-white">
            {c.unread}
          </span>
        )}
      </button>
    </li>
  );
}
