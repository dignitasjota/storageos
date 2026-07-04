'use client';

import {
  type PaymentMethodDto,
  type PortalAccessCredentialDto,
  type PortalChargeResultDto,
  type PortalContractDto,
  type PortalFacilityDto,
  type PortalIncidentDto,
  type PortalInvoiceDto,
  type PortalNightPassInfoDto,
  type PortalPaymentDto,
  type PortalReferralDto,
  type PortalSessionDto,
  type PortalUnitChangeRequestDto,
  type SetupIntentResponseDto,
} from '@storageos/shared';
import {
  AlertTriangle,
  Bell,
  Boxes,
  CreditCard,
  Download,
  Gift,
  Home,
  KeyRound,
  Landmark,
  Loader2,
  LogOut,
  MapPin,
  MessageSquare,
  MoreHorizontal,
  PackagePlus,
  Plus,
  Receipt,
  RefreshCw,
  Replace,
  User,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';
import { Suspense, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AccessLogsCard } from './access-logs-card';
import { AdditionalUnitCard } from './additional-unit-card';
import { ChatCard } from './chat-card';
import { DocumentsCard } from './documents-card';
import { FaqCard } from './faq-card';
import { InsuranceCard } from './insurance-card';
import { NightAccessCard } from './night-access-card';
import { OverviewCard } from './overview-card';
import { ProfileCard } from './profile-card';
import { ShopCard } from './shop-card';

import { StripeSetupForm } from '@/components/billing/stripe-setup-form';
import { ThemeToggle } from '@/components/layout/theme-toggle';
import { InstallPwaButton } from '@/components/pwa/install-pwa-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { startGoCardlessMandatePortal } from '@/lib/payments/gocardless';
import { fetchPortalRedsysRedirect, submitRedsysForm } from '@/lib/payments/redsys';

/**
 * La sesión del portal se persiste en localStorage tras consumir el magic link
 * (que es de un solo uso): una recarga la reutiliza en vez de reintentar
 * consumir un token ya gastado. Se usa localStorage (no sessionStorage) para que
 * sobreviva al cierre del navegador → el inquilino puede volver a entrar durante
 * la vigencia de la sesión (48 h, fijada por el server vía `expiresIn`).
 */
const PORTAL_SESSION_KEY = 'storageos.portal.session';
type StoredPortalSession = PortalSessionDto & { expiresAtMs: number };

function loadStoredPortalSession(): PortalSessionDto | null {
  try {
    const raw = localStorage.getItem(PORTAL_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredPortalSession;
    // Margen de 10 s para no usar un token a punto de expirar en el server.
    if (!s.accessToken || s.expiresAtMs <= Date.now() + 10_000) {
      localStorage.removeItem(PORTAL_SESSION_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

function storePortalSession(s: PortalSessionDto): void {
  try {
    const stored: StoredPortalSession = { ...s, expiresAtMs: Date.now() + s.expiresIn * 1000 };
    localStorage.setItem(PORTAL_SESSION_KEY, JSON.stringify(stored));
  } catch {
    /* localStorage no disponible: seguimos sin persistir */
  }
}

function clearStoredPortalSession(): void {
  try {
    localStorage.removeItem(PORTAL_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Texto legible del estado de la fianza. */
function depositLabel(status: string): string {
  if (status === 'held') return 'retenida';
  if (status === 'returned') return 'devuelta';
  if (status === 'partially_returned') return 'devuelta parcialmente';
  return 'pendiente';
}

function paymentMethodLabel(type: string): string {
  if (type === 'card') return 'Tarjeta';
  if (type === 'sepa_debit') return 'Domiciliación SEPA';
  if (type === 'bank_transfer') return 'Transferencia';
  if (type === 'cash') return 'Efectivo';
  return 'Otro';
}

type PortalNavDef = { value: string; label: string; icon: typeof Home };
type NavBadge = { count: number; color: string } | null;

/** Secciones del portal. En móvil, las 4 primeras van a la barra inferior. */
const PORTAL_NAV: PortalNavDef[] = [
  { value: 'inicio', label: 'Inicio', icon: Home },
  { value: 'contratos', label: 'Contratos', icon: Boxes },
  { value: 'facturas', label: 'Facturas', icon: Receipt },
  { value: 'accesos', label: 'Accesos', icon: KeyRound },
  { value: 'mensajes', label: 'Mensajes', icon: MessageSquare },
  { value: 'incidencias', label: 'Incidencias', icon: AlertTriangle },
  { value: 'cambio', label: 'Cambio de trastero', icon: Replace },
  { value: 'nuevo', label: 'Contratar trastero', icon: PackagePlus },
  { value: 'local', label: 'Tu local', icon: MapPin },
  { value: 'datos', label: 'Mis datos', icon: User },
];
const PORTAL_PRIMARY = PORTAL_NAV.slice(0, 4);
const PORTAL_MORE = PORTAL_NAV.slice(4);

/** Item del menú lateral (ordenador). */
function PortalNavItem({
  item,
  active,
  badge,
  onClick,
}: {
  item: PortalNavDef;
  active: boolean;
  badge: NavBadge;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? 'bg-accent font-medium text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      }`}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 text-left">{item.label}</span>
      {badge && badge.count > 0 && (
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white ${badge.color}`}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

/** Item de la barra inferior (móvil). */
function PortalBottomItem({
  item,
  active,
  badge,
  onClick,
}: {
  item: PortalNavDef;
  active: boolean;
  badge: NavBadge;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${
        active ? 'text-primary' : 'text-muted-foreground'
      }`}
    >
      <Icon className="size-5" />
      {item.label}
      {badge && badge.count > 0 && (
        <span
          className={`absolute right-3 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium text-white ${badge.color}`}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

function paymentStatusLabel(status: string): string {
  if (status === 'succeeded') return 'Cobrado';
  if (status === 'processing') return 'En curso';
  if (status === 'pending') return 'Pendiente';
  if (status === 'failed') return 'Fallido';
  if (status === 'refunded') return 'Reembolsado';
  if (status === 'partially_refunded') return 'Reemb. parcial';
  return status;
}

/** Convierte la clave pública VAPID (base64url) al formato que pide pushManager. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function PortalConsumeContent() {
  const params = useSearchParams();
  const token = params.get('token');
  const [session, setSession] = useState<PortalSessionDto | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoiceDto[] | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodDto[] | null>(null);
  const [access, setAccess] = useState<PortalAccessCredentialDto[] | null>(null);
  const [nightPass, setNightPass] = useState<PortalNightPassInfoDto | null>(null);
  const [passRefresh, setPassRefresh] = useState(0);
  const [buyingPass, setBuyingPass] = useState(false);
  const [referrals, setReferrals] = useState<PortalReferralDto | null>(null);
  const [contracts, setContracts] = useState<PortalContractDto[] | null>(null);
  const [payments, setPayments] = useState<PortalPaymentDto[]>([]);
  const [facilities, setFacilities] = useState<PortalFacilityDto[]>([]);
  const [incidents, setIncidents] = useState<PortalIncidentDto[] | null>(null);
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentDesc, setIncidentDesc] = useState('');
  const [reportingIncident, setReportingIncident] = useState(false);
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [unitChanges, setUnitChanges] = useState<PortalUnitChangeRequestDto[] | null>(null);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [tab, setTab] = useState('inicio');
  const [moreOpen, setMoreOpen] = useState(false);
  const [ucNote, setUcNote] = useState('');
  const [ucContractId, setUcContractId] = useState('');
  const [ucBusy, setUcBusy] = useState(false);
  const [moveOutId, setMoveOutId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [addingAccess, setAddingAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [goCardlessEnabled, setGoCardlessEnabled] = useState(false);
  const [gcPending, setGcPending] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);

  /** Fetch autenticado con el JWT corto del portal (no usa el auth store del staff). */
  function portalFetch<T>(
    s: PortalSessionDto,
    path: string,
    init?: { method?: string; json?: unknown },
  ) {
    return apiFetch<T>(path, {
      method: init?.method ?? 'GET',
      ...(init?.json !== undefined ? { json: init.json } : {}),
      headers: { Authorization: `Bearer ${s.accessToken}` },
      requiresAuth: false,
    }).catch((err: unknown) => {
      // Sesión de portal caducada (48 h): en vez de dejar cada acción fallando
      // con un toast crudo, limpiamos y mostramos la pantalla de re-login.
      if (err instanceof ApiError && err.statusCode === 401) {
        clearStoredPortalSession();
        setSession(null);
        setError('Tu sesión ha caducado. Pide un enlace nuevo para volver a entrar.');
      }
      throw err;
    });
  }

  const startedRef = useRef(false);
  useEffect(() => {
    // Guard: una sola ejecución por montaje (evita doble consumo del token).
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // 1) ¿Sesión persistida todavía válida? (recargas, volver a la pestaña).
        let s = loadStoredPortalSession();
        // 2) Si no, consumimos el magic link de la URL (un solo uso) y lo
        //    quitamos de la URL para que las recargas no lo reintenten.
        if (!s) {
          if (!token) {
            setError('Enlace inválido o caducado. Pide uno nuevo a tu gestor.');
            setLoading(false);
            return;
          }
          s = await apiFetch<PortalSessionDto>('/portal/login/consume', {
            method: 'POST',
            json: { token },
            requiresAuth: false,
          });
          storePortalSession(s);
          if (typeof window !== 'undefined') {
            window.history.replaceState(null, '', '/portal/consume');
          }
        }
        if (cancelled) return;
        setSession(s);
        // Un fallo transitorio en UNA sección no debe tumbar todo el portal:
        // cada fetch cae a un valor por defecto, salvo el 401 (sesión muerta),
        // que se re-lanza para llevar a la pantalla de re-login.
        const safe = <U,>(p: Promise<U>, fallback: U): Promise<U> =>
          p.catch((err: unknown) => {
            if (err instanceof ApiError && err.statusCode === 401) throw err;
            return fallback;
          });
        const [inv, pms, acc, refs, ctr, inc, ucr, ucr2] = await Promise.all([
          safe(portalFetch<PortalInvoiceDto[]>(s, '/portal/me/invoices'), []),
          safe(portalFetch<PaymentMethodDto[]>(s, '/portal/me/payment-methods'), []),
          safe(portalFetch<PortalAccessCredentialDto[]>(s, '/portal/me/access'), []),
          safe(portalFetch<PortalReferralDto | null>(s, '/portal/me/referrals'), null),
          safe(portalFetch<PortalContractDto[]>(s, '/portal/me/contracts'), []),
          safe(portalFetch<PortalIncidentDto[]>(s, '/portal/me/incidents'), []),
          safe(portalFetch<PortalUnitChangeRequestDto[]>(s, '/portal/me/unit-change-requests'), []),
          safe(portalFetch<PortalNightPassInfoDto | null>(s, '/portal/me/access/night-pass'), null),
        ]);
        if (cancelled) return;
        setInvoices(inv);
        setPaymentMethods(pms);
        setAccess(acc);
        setNightPass(ucr2);
        setReferrals(refs);
        setContracts(ctr);
        setIncidents(inc);
        setUnitChanges(ucr);
        // Clave pública de push (best-effort; null si no está configurado).
        try {
          const k = await portalFetch<{ publicKey: string | null }>(
            s,
            '/portal/me/push/public-key',
          );
          if (!cancelled) setPushKey(k.publicKey);
        } catch {
          /* push opcional */
        }
        // ¿Ofrece el negocio domiciliación GoCardless? (best-effort).
        try {
          const gc = await portalFetch<{ enabled: boolean }>(s, '/portal/me/gocardless/enabled');
          if (!cancelled) setGoCardlessEnabled(gc.enabled);
        } catch {
          /* gocardless opcional */
        }
        // Historial de pagos + datos del local (best-effort).
        try {
          const [pays, facs] = await Promise.all([
            portalFetch<PortalPaymentDto[]>(s, '/portal/me/payments'),
            portalFetch<PortalFacilityDto[]>(s, '/portal/me/facilities'),
          ]);
          if (!cancelled) {
            setPayments(pays);
            setFacilities(facs);
          }
        } catch {
          /* opcional */
        }
        // Mensajes del staff sin leer (badge de la pestaña «Mensajes»).
        try {
          const u = await portalFetch<{ count: number }>(s, '/portal/me/messages/unread-count');
          if (!cancelled) setUnreadMessages(u.count);
        } catch {
          /* opcional */
        }
      } catch (err) {
        if (cancelled) return;
        // La sesión persistida pudo caducar en el server: la descartamos.
        clearStoredPortalSession();
        setError(
          err instanceof ApiError
            ? err.body.message
            : 'Enlace inválido o caducado. Pide uno nuevo a tu gestor.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Solo al montar: el `startedRef` ya garantiza una única ejecución y, al
    // limpiar el token de la URL con `replaceState`, `token` (de useSearchParams)
    // cambia — si lo pusiéramos como dep, el effect haría cleanup (cancelled=true)
    // a mitad de la carga y la página se quedaría colgada en "cargando".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function regenerateAccess(id: string) {
    if (!session) return;
    setRegeneratingId(id);
    try {
      const updated = await portalFetch<PortalAccessCredentialDto>(
        session,
        `/portal/me/access/${id}/regenerate`,
        { method: 'POST' },
      );
      setAccess((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
      toast.success('Código regenerado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo regenerar.');
    } finally {
      setRegeneratingId(null);
    }
  }

  async function addExtraAccess() {
    if (!session) return;
    const label = window.prompt('¿Para quién es este acceso? (p. ej. "Hijo", "Empleado")');
    if (!label || !label.trim()) return;
    setAddingAccess(true);
    try {
      const created = await portalFetch<PortalAccessCredentialDto>(
        session,
        '/portal/me/access/extra',
        { method: 'POST', json: { label: label.trim() } },
      );
      setAccess((prev) => [created, ...(prev ?? [])]);
      toast.success('Acceso adicional creado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo crear el acceso.');
    } finally {
      setAddingAccess(false);
    }
  }

  async function buyNightPass() {
    if (!session || !nightPass) return;
    if (
      !window.confirm(
        `Comprar un pase nocturno por ${nightPass.price.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })} (+ IVA). Se cobrará a tu método de pago por defecto.`,
      )
    )
      return;
    setBuyingPass(true);
    try {
      const created = await portalFetch<PortalAccessCredentialDto>(
        session,
        '/portal/me/access/night-pass',
        { method: 'POST' },
      );
      setAccess((prev) => [created, ...(prev ?? [])]);
      const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
      setInvoices(inv);
      setPassRefresh((n) => n + 1);
      toast.success(
        'Pase nocturno comprado y cobrado. Tu código es de un solo uso y caduca por la mañana.',
      );
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'no_payment_method') {
        toast.error(
          'Necesitas un método de pago para comprar el pase. Añádelo en «Método de pago».',
        );
      } else if (err instanceof ApiError && err.body.code === 'payment_failed') {
        toast.error('No se pudo cobrar tu método de pago. El pase no se ha emitido.');
      } else {
        toast.error(err instanceof ApiError ? err.body.message : 'No se pudo comprar el pase.');
      }
    } finally {
      setBuyingPass(false);
    }
  }

  async function enablePush() {
    if (!session || !pushKey) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error('Tu navegador no soporta notificaciones push.');
      return;
    }
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error('Permiso de notificaciones denegado.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushKey) as BufferSource,
      });
      await portalFetch(session, '/portal/me/push/subscribe', {
        method: 'POST',
        json: sub.toJSON(),
      });
      setPushEnabled(true);
      toast.success('Notificaciones activadas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudieron activar.');
    } finally {
      setPushBusy(false);
    }
  }

  async function requestUnitChange() {
    if (!session || ucNote.trim().length < 5) {
      toast.error('Cuéntanos qué cambio necesitas (mínimo 5 caracteres).');
      return;
    }
    setUcBusy(true);
    try {
      const created = await portalFetch<PortalUnitChangeRequestDto>(
        session,
        '/portal/me/unit-change-requests',
        { method: 'POST', json: { note: ucNote.trim(), contractId: ucContractId || undefined } },
      );
      setUnitChanges((prev) => [created, ...(prev ?? [])]);
      setUcNote('');
      setUcContractId('');
      toast.success('Solicitud enviada. Te contactaremos.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    } finally {
      setUcBusy(false);
    }
  }

  async function reportIncident() {
    if (!session || incidentTitle.trim().length < 3) {
      toast.error('Describe la incidencia (mínimo 3 caracteres).');
      return;
    }
    setReportingIncident(true);
    try {
      const created = await portalFetch<PortalIncidentDto>(session, '/portal/me/incidents', {
        method: 'POST',
        json: { title: incidentTitle.trim(), description: incidentDesc.trim() || undefined },
      });
      setIncidents((prev) => [created, ...(prev ?? [])]);
      setIncidentTitle('');
      setIncidentDesc('');
      toast.success('Incidencia enviada. La revisaremos lo antes posible.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo enviar.');
    } finally {
      setReportingIncident(false);
    }
  }

  async function reloadInvoices() {
    if (!session) return;
    try {
      const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
      setInvoices(inv);
    } catch {
      /* opcional */
    }
  }

  /** Cierra la sesión: borra la sesión persistida y vuelve al acceso del portal. */
  function logout() {
    clearStoredPortalSession();
    window.location.href = '/portal/login';
  }

  async function downloadContract(contractId: string) {
    if (!session) return;
    try {
      const { url } = await portalFetch<{ url: string }>(
        session,
        `/portal/me/contracts/${contractId}/signed-pdf`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo descargar el contrato.');
    }
  }

  async function requestMoveOut(id: string, endDate: string) {
    if (!session) return;
    try {
      const updated = await portalFetch<PortalContractDto>(
        session,
        `/portal/me/contracts/${id}/request-move-out`,
        { method: 'POST', json: { endDate } },
      );
      setContracts((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
      setMoveOutId(null);
      toast.success('Solicitud de baja enviada. Te contactaremos para el cierre.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo solicitar la baja.');
    }
  }

  async function openAddDialog() {
    if (!session) return;
    setAddPending(true);
    try {
      const intent = await portalFetch<SetupIntentResponseDto>(
        session,
        '/portal/me/payment-methods/setup-intent',
        { method: 'POST' },
      );
      setSetupIntent(intent);
      setAddOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo iniciar el alta.');
    } finally {
      setAddPending(false);
    }
  }

  async function registerPaymentMethod(gatewayToken: string) {
    if (!session || !setupIntent) return;
    try {
      await portalFetch<PaymentMethodDto>(session, '/portal/me/payment-methods', {
        method: 'POST',
        json: { gatewayToken, gatewayCustomerId: setupIntent.customerId },
      });
      const pms = await portalFetch<PaymentMethodDto[]>(session, '/portal/me/payment-methods');
      setPaymentMethods(pms);
      setAddOpen(false);
      setSetupIntent(null);
      toast.success('Método de pago guardado. Ya puedes pagar tus facturas.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : 'No se pudo guardar.');
    }
  }

  async function startGoCardless() {
    if (!session) return;
    setGcPending(true);
    try {
      const res = await startGoCardlessMandatePortal(session.accessToken);
      sessionStorage.setItem(
        'gc_portal_mandate',
        JSON.stringify({
          portalToken: session.accessToken,
          billingRequestId: res.billingRequestId,
        }),
      );
      window.location.href = res.authorisationUrl;
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.body.message : 'No se pudo iniciar la domiciliación.',
      );
      setGcPending(false);
    }
  }

  async function handlePay(invoice: PortalInvoiceDto) {
    if (!session) return;
    setPayingId(invoice.id);
    try {
      const result = await portalFetch<PortalChargeResultDto>(
        session,
        `/portal/me/invoices/${invoice.id}/charge`,
        { method: 'POST' },
      );
      if (result.status === 'processing') {
        toast.info('Pago domiciliado iniciado: tu banco lo confirmará en 2-5 días hábiles.');
        // Recargar para mostrar «Pago en curso» y desactivar los botones (evita
        // que el inquilino lance un segundo adeudo sobre la misma factura).
        const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
        setInvoices(inv);
      } else if (result.status === 'succeeded') {
        toast.success('Pago realizado. ¡Gracias!');
        const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
        setInvoices(inv);
      } else {
        toast.error(
          result.failureReason
            ? `El pago no se completó: ${result.failureReason}`
            : 'El pago no se completó.',
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'no_payment_method') {
        toast.message('Añade primero un IBAN o tarjeta para poder pagar.');
        void openAddDialog();
      } else {
        toast.error(err instanceof ApiError ? err.body.message : 'No se pudo procesar el pago.');
      }
    } finally {
      setPayingId(null);
    }
  }

  if (loading) {
    return (
      <div className="container flex justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !session || !invoices) {
    return (
      <div className="container max-w-md py-12">
        <Card className="border-border/60 text-center">
          <CardHeader>
            <CardTitle>No hemos podido abrir tu portal</CardTitle>
            <CardDescription>{error ?? 'El enlace no es válido o ha caducado.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/portal/login">Pedir un enlace nuevo</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Contadores de las pestañas (novedades del inquilino).
  const pendingUnitChanges = (unitChanges ?? []).filter((r) => r.status === 'pending').length;
  const openIncidents = (incidents ?? []).filter(
    (i) => i.status === 'reported' || i.status === 'investigating',
  ).length;

  function navBadge(value: string): NavBadge {
    if (value === 'cambio' && pendingUnitChanges > 0)
      return { count: pendingUnitChanges, color: 'bg-amber-500' };
    if (value === 'mensajes' && unreadMessages > 0)
      return { count: unreadMessages, color: 'bg-blue-500' };
    if (value === 'incidencias' && openIncidents > 0)
      return { count: openIncidents, color: 'bg-red-500' };
    return null;
  }
  function handleNav(value: string) {
    setTab(value);
    if (value === 'mensajes') setUnreadMessages(0);
    setMoreOpen(false);
  }
  const moreBadgeTotal = PORTAL_MORE.reduce((sum, i) => sum + (navBadge(i.value)?.count ?? 0), 0);

  return (
    <div className="container max-w-5xl space-y-6 py-10">
      {/* Marca del operador (white-label) — clicable para volver al inicio */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setTab('inicio')}
          title="Volver al inicio"
          className="flex items-center gap-3 transition-opacity hover:opacity-80"
        >
          {session.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={session.logoUrl}
              alt={session.tenantName}
              className="h-10 w-auto object-contain"
            />
          ) : null}
          <span
            className="text-lg font-semibold"
            style={session.brandColor ? { color: session.brandColor } : undefined}
          >
            {session.tenantName}
          </span>
        </button>
        {session.brandColor && (
          <div
            className="h-1 w-full rounded-full"
            style={{ backgroundColor: session.brandColor }}
          />
        )}
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hola, {session.customerName}</h1>
          <p className="text-sm text-muted-foreground">{session.email}</p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <InstallPwaButton />
          <Button variant="outline" size="sm" onClick={logout}>
            <LogOut className="mr-1 h-4 w-4" /> Cerrar sesión
          </Button>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Menú lateral (ordenador) */}
        <nav className="hidden w-52 shrink-0 space-y-1 md:block">
          {PORTAL_NAV.map((item) => (
            <PortalNavItem
              key={item.value}
              item={item}
              active={tab === item.value}
              badge={navBadge(item.value)}
              onClick={() => handleNav(item.value)}
            />
          ))}
        </nav>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v);
            // Al abrir Mensajes se marcan leídos en el server → ocultamos el badge.
            if (v === 'mensajes') setUnreadMessages(0);
          }}
          className="min-w-0 flex-1 pb-20 md:pb-0"
        >
          <TabsContent value="inicio" className="space-y-6">
            <OverviewCard
              customerName={session.customerName}
              invoices={invoices}
              contracts={contracts ?? []}
              unreadMessages={unreadMessages}
              brandColor={session.brandColor ?? null}
              onNavigate={setTab}
            />
          </TabsContent>

          <TabsContent value="contratos" className="space-y-6">
            {contracts && contracts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Mis contratos</CardTitle>
                  <CardDescription>
                    Tus trasteros activos. Puedes solicitar la baja online.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {contracts.map((c) => (
                    <div key={c.id} className="space-y-2 rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">
                            {c.unitCode} · {c.facilityName}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {c.contractNumber} · {c.effectivePrice.toFixed(2)} €/mes
                            {c.status === 'ending' && c.endDate
                              ? ` · baja prevista el ${c.endDate}`
                              : ''}
                          </p>
                        </div>
                        {c.status === 'ending' ? (
                          <Badge variant="secondary">Baja solicitada</Badge>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => setMoveOutId(c.id)}>
                            <LogOut className="mr-1 h-4 w-4" /> Solicitar baja
                          </Button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {c.depositAmount > 0 && (
                          <span>
                            Fianza {c.depositAmount.toFixed(2)} € · {depositLabel(c.depositStatus)}
                          </span>
                        )}
                        {c.insurancePlanName && (
                          <span>
                            Seguro: {c.insurancePlanName}
                            {c.insurancePrice ? ` (${c.insurancePrice.toFixed(2)} €/mes)` : ''}
                          </span>
                        )}
                        {c.freeMonthsRemaining > 0 && (
                          <span className="text-green-600">
                            {c.freeMonthsRemaining} mes(es) gratis pendientes
                          </span>
                        )}
                        {c.discountAmount > 0 && (
                          <span>Descuento {c.discountAmount.toFixed(2)} €/mes</span>
                        )}
                      </div>
                      {c.hasSignedPdf && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void downloadContract(c.id)}
                        >
                          <Download className="mr-1 h-4 w-4" /> Descargar contrato firmado
                        </Button>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {session && contracts && contracts.length > 0 && (
              <InsuranceCard
                session={session}
                contracts={contracts}
                onContractsChange={setContracts}
              />
            )}
          </TabsContent>

          <TabsContent value="cambio" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Boxes className="h-4 w-4" /> Cambiar de trastero
                </CardTitle>
                <CardDescription>
                  ¿Necesitas más espacio o un trastero distinto? Pídelo y te ayudamos con el cambio.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(contracts ?? []).length > 0 && (
                  <select
                    value={ucContractId}
                    onChange={(e) => setUcContractId(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Trastero actual (opcional)</option>
                    {(contracts ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.unitCode} · {c.facilityName}
                      </option>
                    ))}
                  </select>
                )}
                <textarea
                  value={ucNote}
                  onChange={(e) => setUcNote(e.target.value)}
                  placeholder="¿Qué necesitas? (p. ej. uno más grande, planta baja…)"
                  maxLength={1000}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button onClick={requestUnitChange} disabled={ucBusy || ucNote.trim().length < 5}>
                  {ucBusy ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  Solicitar cambio
                </Button>

                {(unitChanges ?? []).length > 0 && (
                  <ul className="space-y-2 border-t pt-3">
                    {(unitChanges ?? []).map((r) => (
                      <li key={r.id} className="space-y-1 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="line-clamp-1">{r.note}</span>
                          <Badge variant={r.status === 'handled' ? 'default' : 'secondary'}>
                            {r.status === 'pending'
                              ? 'Pendiente'
                              : r.status === 'handled'
                                ? 'Gestionada'
                                : 'Rechazada'}
                          </Badge>
                        </div>
                        {r.status !== 'pending' && r.resolutionNote && (
                          <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                            {r.resolutionNote}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="nuevo" className="space-y-6">
            <AdditionalUnitCard
              session={session}
              onBooked={() => {
                void reloadInvoices();
                setTab('facturas');
              }}
            />
          </TabsContent>

          <TabsContent value="facturas" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Tus facturas</CardTitle>
              </CardHeader>
              <CardContent>
                {invoices.length === 0 && (
                  <p className="text-sm text-muted-foreground">Aún no tienes facturas.</p>
                )}
                {invoices.length > 0 && (
                  <ul className="divide-y rounded-md border">
                    {invoices.map((i) => (
                      <li
                        key={i.id}
                        className="flex flex-wrap items-center justify-between gap-3 px-3 py-3"
                      >
                        <div>
                          <p className="font-mono text-sm font-medium">{i.invoiceNumber}</p>
                          <p className="text-xs text-muted-foreground">
                            Emitida {i.issueDate ?? '—'} · Vence {i.dueDate ?? '—'}
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-sm tabular-nums">
                            {i.total.toLocaleString('es-ES', {
                              style: 'currency',
                              currency: 'EUR',
                            })}
                          </span>
                          <Badge
                            variant={
                              i.status === 'paid'
                                ? 'default'
                                : i.status === 'overdue'
                                  ? 'destructive'
                                  : 'secondary'
                            }
                          >
                            {i.status}
                          </Badge>
                          {i.paymentInProgress && (
                            <Badge variant="outline" className="gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" /> Pago en curso
                            </Badge>
                          )}
                          {i.amountPending > 0 && !i.paymentInProgress && (
                            <Button onClick={() => void handlePay(i)} disabled={payingId !== null}>
                              {payingId === i.id && (
                                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                              )}
                              Pagar
                            </Button>
                          )}
                          {i.amountPending > 0 && !i.paymentInProgress && (
                            <Button
                              variant="outline"
                              onClick={async () => {
                                try {
                                  submitRedsysForm(
                                    await fetchPortalRedsysRedirect(session.accessToken, i.id),
                                  );
                                } catch (err) {
                                  toast.error(
                                    err instanceof ApiError
                                      ? err.body.message
                                      : 'Redsys no disponible',
                                  );
                                }
                              }}
                            >
                              Pagar con tarjeta
                            </Button>
                          )}
                          {i.pdfUrl && (
                            <Button variant="outline" asChild>
                              <a href={i.pdfUrl} target="_blank" rel="noreferrer">
                                <Download className="mr-1 h-4 w-4" /> PDF
                              </a>
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {payments.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Receipt className="h-5 w-5 text-muted-foreground" /> Historial de pagos
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y rounded-md border">
                    {payments.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div>
                          <p className="font-medium tabular-nums">
                            {p.amount.toFixed(2)} {p.currency}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {paymentMethodLabel(p.methodType)}
                            {p.invoiceNumber ? ` · factura ${p.invoiceNumber}` : ''}
                            {p.paidAt ? ` · ${new Date(p.paidAt).toLocaleDateString('es-ES')}` : ''}
                          </p>
                        </div>
                        <Badge variant={p.status === 'succeeded' ? 'secondary' : 'outline'}>
                          {paymentStatusLabel(p.status)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {session && <ShopCard session={session} onPurchased={reloadInvoices} />}

            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Método de pago</CardTitle>
                  <CardDescription>
                    Domicilia tus recibos con tu IBAN o paga con tarjeta.
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {goCardlessEnabled && (
                    <Button
                      onClick={() => void startGoCardless()}
                      disabled={gcPending}
                      variant="outline"
                    >
                      {gcPending ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Landmark className="mr-1 h-4 w-4" />
                      )}
                      Domiciliar (GoCardless)
                    </Button>
                  )}
                  <Button
                    onClick={() => void openAddDialog()}
                    disabled={addPending}
                    variant="outline"
                  >
                    {addPending ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-4 w-4" />
                    )}
                    Añadir IBAN o tarjeta
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {!paymentMethods?.length ? (
                  <p className="text-sm text-muted-foreground">
                    Sin método de pago guardado. Añade tu IBAN para domiciliar los recibos.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {paymentMethods.map((pm) => (
                      <li key={pm.id} className="flex items-center gap-3 py-3">
                        {pm.type === 'sepa_debit' ? (
                          <Landmark className="h-5 w-5 text-muted-foreground" />
                        ) : (
                          <CreditCard className="h-5 w-5 text-muted-foreground" />
                        )}
                        <div>
                          <p className="text-sm font-medium">
                            {pm.type === 'sepa_debit'
                              ? `IBAN •••• ${pm.last4 ?? '????'}`
                              : `${pm.brand ?? 'Tarjeta'} •••• ${pm.last4 ?? '????'}`}
                          </p>
                          {pm.type === 'sepa_debit' && pm.mandateReference && (
                            <p className="text-xs text-muted-foreground">
                              Mandato {pm.mandateReference}
                            </p>
                          )}
                        </div>
                        {pm.isDefault && <Badge variant="secondary">Predeterminado</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="accesos" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4" /> Tu acceso
                </CardTitle>
                <CardDescription>
                  Presenta tu código QR o teclea tu PIN en el lector de la puerta.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {access === null ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : access.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No tienes credenciales de acceso activas. Pídeselas a tu operador.
                  </p>
                ) : (
                  <ul className="grid gap-4 sm:grid-cols-2">
                    {access.map((c) => (
                      <li key={c.id} className="rounded-md border p-4">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-sm font-medium">
                            {c.label ?? (c.method === 'qr' ? 'Código QR' : 'PIN')}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Regenerar"
                            disabled={regeneratingId === c.id}
                            onClick={() => void regenerateAccess(c.id)}
                            aria-label="Actualizar"
                          >
                            <RefreshCw
                              className={`h-4 w-4 ${regeneratingId === c.id ? 'animate-spin' : ''}`}
                            />
                          </Button>
                        </div>
                        {c.value === null ? (
                          <p className="text-xs text-muted-foreground">
                            Esta credencial es antigua y no se puede mostrar. Pulsa regenerar para
                            obtener un código nuevo.
                          </p>
                        ) : c.method === 'qr' ? (
                          <div className="flex flex-col items-center gap-2">
                            <div className="rounded bg-white p-2">
                              <QRCodeSVG value={c.value} size={148} />
                            </div>
                            <span className="break-all text-center font-mono text-[10px] text-muted-foreground">
                              {c.value}
                            </span>
                          </div>
                        ) : (
                          <div className="text-center">
                            <span className="font-mono text-3xl tracking-[0.3em]">{c.value}</span>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {access !== null && (
                  <div className="mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={addingAccess}
                      onClick={() => void addExtraAccess()}
                    >
                      {addingAccess ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="mr-1 h-4 w-4" />
                      )}
                      Añadir acceso (familiar, etc.)
                    </Button>
                  </div>
                )}
                <div className="mt-3">
                  <NightAccessCard
                    session={session}
                    facilities={facilities}
                    refreshKey={passRefresh}
                  />
                </div>
                {nightPass?.enabled && (
                  <div className="mt-3 rounded-md border bg-muted/30 p-3">
                    <p className="text-sm font-medium">Pase nocturno</p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Código de un solo uso para entrar fuera de horario (toque de queda). Caduca a
                      la mañana siguiente. Se cobra en el acto a tu método de pago por defecto.
                    </p>
                    <Button size="sm" disabled={buyingPass} onClick={() => void buyNightPass()}>
                      {buyingPass && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      Comprar pase nocturno (
                      {nightPass.price.toLocaleString('es-ES', {
                        style: 'currency',
                        currency: 'EUR',
                      })}{' '}
                      + IVA)
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <AccessLogsCard session={session} />
          </TabsContent>

          <TabsContent value="mensajes" className="space-y-6">
            {session && <ChatCard session={session} />}
          </TabsContent>

          <TabsContent value="incidencias" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wrench className="h-4 w-4" /> Incidencias
                </CardTitle>
                <CardDescription>
                  ¿Algún problema con tu trastero o el acceso? Cuéntanoslo y lo revisaremos.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <input
                  value={incidentTitle}
                  onChange={(e) => setIncidentTitle(e.target.value)}
                  placeholder="Asunto (p. ej. la puerta no cierra)"
                  maxLength={160}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <textarea
                  value={incidentDesc}
                  onChange={(e) => setIncidentDesc(e.target.value)}
                  placeholder="Detalles (opcional)"
                  maxLength={2000}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <Button
                  onClick={reportIncident}
                  disabled={reportingIncident || incidentTitle.trim().length < 3}
                >
                  {reportingIncident ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  Reportar incidencia
                </Button>

                {(incidents ?? []).length > 0 && (
                  <ul className="space-y-2 border-t pt-3">
                    {(incidents ?? []).map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="line-clamp-1">{i.title}</span>
                        <Badge variant={i.status === 'resolved' ? 'default' : 'secondary'}>
                          {i.status === 'reported'
                            ? 'Recibida'
                            : i.status === 'investigating'
                              ? 'En curso'
                              : i.status === 'resolved'
                                ? 'Resuelta'
                                : 'Cerrada'}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="local" className="space-y-6">
            {facilities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <MapPin className="h-5 w-5 text-muted-foreground" /> Tu local
                  </CardTitle>
                  <CardDescription>Dirección, horario de acceso y contacto.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {facilities.map((f) => (
                    <div key={f.id} className="rounded-md border p-3 text-sm">
                      <p className="font-medium">{f.name}</p>
                      {(f.address || f.city) && (
                        <p className="text-muted-foreground">
                          {[f.address, f.postalCode, f.city].filter(Boolean).join(', ')}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {f.accessCurfewEnabled && f.accessCurfewStart && f.accessCurfewEnd
                          ? `Acceso cerrado de ${f.accessCurfewStart} a ${f.accessCurfewEnd}`
                          : 'Acceso 24 h'}
                        {f.contactPhone ? ` · Tel. ${f.contactPhone}` : ''}
                        {f.contactEmail ? ` · ${f.contactEmail}` : ''}
                      </p>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {session && <FaqCard session={session} />}
          </TabsContent>

          <TabsContent value="datos" className="space-y-6">
            <ProfileCard session={session} />

            <DocumentsCard session={session} />

            {referrals?.enabled && referrals.referralCode && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Gift className="h-4 w-4" /> Recomienda y gana
                  </CardTitle>
                  <CardDescription>
                    Comparte tu código. Cuando tu recomendado firme su contrato, recibirás una
                    recompensa.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-lg tracking-widest">
                      {referrals.referralCode}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(referrals.referralCode ?? '');
                        toast.success('Código copiado.');
                      }}
                    >
                      Copiar
                    </Button>
                  </div>
                  {referrals.rewards.length > 0 && (
                    <p className="text-sm">
                      Tus recompensas:{' '}
                      {referrals.rewards.map((c) => (
                        <span key={c} className="mr-1 font-mono text-xs">
                          {c}
                        </span>
                      ))}
                    </p>
                  )}
                  {referrals.referrals.length > 0 && (
                    <ul className="text-sm text-muted-foreground">
                      {referrals.referrals.map((r, i) => (
                        <li key={i}>
                          {r.referredName} —{' '}
                          {r.status === 'converted' ? 'recompensa concedida' : 'pendiente'}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}

            {pushKey && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Bell className="h-4 w-4" /> Notificaciones
                  </CardTitle>
                  <CardDescription>
                    Recibe avisos de pagos y vencimientos en este dispositivo.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {pushEnabled ? (
                    <p className="text-sm text-emerald-600">
                      ✓ Notificaciones activadas en este dispositivo.
                    </p>
                  ) : (
                    <Button onClick={enablePush} disabled={pushBusy} variant="outline">
                      {pushBusy ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Bell className="mr-1 h-4 w-4" />
                      )}
                      Activar notificaciones
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Barra de navegación inferior (móvil): principales + «Más» */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 backdrop-blur md:hidden">
        {PORTAL_PRIMARY.map((item) => (
          <PortalBottomItem
            key={item.value}
            item={item}
            active={tab === item.value}
            badge={navBadge(item.value)}
            onClick={() => handleNav(item.value)}
          />
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className="relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"
        >
          <MoreHorizontal className="size-5" />
          Más
          {moreBadgeTotal > 0 && (
            <span className="absolute right-3 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-white">
              {moreBadgeTotal}
            </span>
          )}
        </button>
      </nav>

      {/* Cajón «Más» (móvil): el resto de secciones */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-xl">
          <SheetTitle className="mb-2">Más opciones</SheetTitle>
          <div className="grid grid-cols-3 gap-2 pb-4">
            {PORTAL_MORE.map((item) => {
              const Icon = item.icon;
              const b = navBadge(item.value);
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => handleNav(item.value)}
                  className={`relative flex flex-col items-center gap-1 rounded-lg border p-3 text-xs ${
                    tab === item.value ? 'border-primary bg-accent' : 'border-border'
                  }`}
                >
                  <Icon className="size-5" />
                  <span className="text-center leading-tight">{item.label}</span>
                  {b && b.count > 0 && (
                    <span
                      className={`absolute right-2 top-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium text-white ${b.color}`}
                    >
                      {b.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>

      {moveOutId && (
        <MoveOutDialog
          contract={contracts?.find((c) => c.id === moveOutId) ?? null}
          onClose={() => setMoveOutId(null)}
          onConfirm={(endDate) => requestMoveOut(moveOutId, endDate)}
        />
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setSetupIntent(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Añadir método de pago</DialogTitle>
            <DialogDescription>
              Tu IBAN para domiciliación SEPA (aceptarás el mandato en este formulario) o una
              tarjeta.
            </DialogDescription>
          </DialogHeader>
          {setupIntent && (
            <StripeSetupForm
              clientSecret={setupIntent.clientSecret}
              publishableKey={setupIntent.publishableKey}
              onConfirmed={registerPaymentMethod}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function PortalConsumePage() {
  return (
    <Suspense fallback={null}>
      <PortalConsumeContent />
    </Suspense>
  );
}

function MoveOutDialog({
  contract,
  onClose,
  onConfirm,
}: {
  contract: PortalContractDto | null;
  onClose: () => void;
  onConfirm: (endDate: string) => void;
}) {
  const notice = contract?.cancellationNoticeDays ?? 15;
  const min = new Date();
  min.setDate(min.getDate() + notice);
  const minDate = min.toISOString().slice(0, 10);
  const [endDate, setEndDate] = useState(minDate);

  return (
    <Dialog open={!!contract} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Solicitar baja</DialogTitle>
          <DialogDescription>
            {contract ? `${contract.unitCode} · ${contract.facilityName}. ` : ''}
            El preaviso es de {notice} días: la fecha de salida más temprana es el {minDate}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="moveout-date">
            Fecha de salida
          </label>
          <input
            id="moveout-date"
            type="date"
            min={minDate}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => onConfirm(endDate)} disabled={!endDate || endDate < minDate}>
            Confirmar baja
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
