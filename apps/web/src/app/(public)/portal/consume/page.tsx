'use client';

import {
  type PaymentMethodDto,
  type PortalAccountDto,
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
import { useTranslations } from 'next-intl';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { PortalLanguageSwitcher } from '../i18n/language-switcher';
import { intlLocaleForPortal } from '../i18n/messages';
import { usePortalLocale } from '../i18n/provider';

import { AccessCredentialItem } from './access-credential';
import { AccessLogsCard } from './access-logs-card';
import { AdditionalUnitCard } from './additional-unit-card';
import { PortalAiChatCard } from './ai-chat-card';
import { ChatCard } from './chat-card';
import { DocumentsCard } from './documents-card';
import { DoorOpenCard } from './door-open-card';
import { ExtrasCard } from './extras-card';
import { FaqCard } from './faq-card';
import { InsuranceCard } from './insurance-card';
import { InvoicesList } from './invoices-list';
import { NightAccessCard } from './night-access-card';
import { NoticesCard } from './notices-card';
import { OffersCard } from './offers-card';
import { OverviewCard } from './overview-card';
import { ProfileCard } from './profile-card';
import { RetentionOfferCard } from './retention-offer-card';
import { ShopCard } from './shop-card';
import { WaitlistCard } from './waitlist-card';

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
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { ApiError, apiFetch } from '@/lib/auth/api';
import { startGoCardlessMandatePortal } from '@/lib/payments/gocardless';
import { urlBase64ToUint8Array } from '@/lib/push/vapid';

/**
 * La sesión del portal se persiste en localStorage tras consumir el magic link
 * (que es de un solo uso): una recarga la reutiliza en vez de reintentar
 * consumir un token ya gastado. Se usa localStorage (no sessionStorage) para que
 * sobreviva al cierre del navegador → el inquilino puede volver a entrar durante
 * la vigencia de la sesión (48 h, fijada por el server vía `expiresIn`).
 */
const PORTAL_SESSION_KEY = 'storageos.portal.session';
/** Sincronizada al guardar la sesión para que `PortalI18nProvider` la recupere sin esperar al perfil. */
const PORTAL_LOCALE_KEY = 'storageos.portal.locale';
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
    localStorage.setItem(PORTAL_LOCALE_KEY, s.locale);
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
function depositLabel(
  status: string,
  t: ReturnType<typeof useTranslations<'portal.consume.contracts'>>,
): string {
  if (status === 'held') return t('depositHeld');
  if (status === 'returned') return t('depositReturned');
  if (status === 'partially_returned') return t('depositPartiallyReturned');
  return t('depositPending');
}

function paymentMethodLabel(
  type: string,
  t: ReturnType<typeof useTranslations<'portal.consume.invoices'>>,
): string {
  if (type === 'card') return t('paymentMethodCard');
  if (type === 'sepa_debit') return t('paymentMethodSepaDebit');
  if (type === 'bank_transfer') return t('paymentMethodBankTransfer');
  if (type === 'cash') return t('paymentMethodCash');
  return t('paymentMethodOther');
}

type PortalNavDef = { value: string; label: string; icon: typeof Home };
type NavBadge = { count: number; color: string } | null;

/** Secciones del portal. En móvil, las 4 primeras van a la barra inferior. */
function buildPortalNav(
  t: ReturnType<typeof useTranslations<'portal.consume.nav'>>,
): PortalNavDef[] {
  return [
    { value: 'inicio', label: t('home'), icon: Home },
    { value: 'contratos', label: t('contracts'), icon: Boxes },
    { value: 'facturas', label: t('invoices'), icon: Receipt },
    { value: 'accesos', label: t('access'), icon: KeyRound },
    { value: 'mensajes', label: t('messages'), icon: MessageSquare },
    { value: 'incidencias', label: t('incidents'), icon: AlertTriangle },
    { value: 'cambio', label: t('unitChange'), icon: Replace },
    { value: 'nuevo', label: t('newUnit'), icon: PackagePlus },
    { value: 'local', label: t('facility'), icon: MapPin },
    { value: 'datos', label: t('profile'), icon: User },
  ];
}

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
          className={`absolute right-2 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium text-white ring-2 ring-background ${badge.color}`}
        >
          {badge.count}
        </span>
      )}
    </button>
  );
}

function paymentStatusLabel(
  status: string,
  t: ReturnType<typeof useTranslations<'portal.consume.invoices'>>,
): string {
  if (status === 'succeeded') return t('paymentStatusSucceeded');
  if (status === 'processing') return t('paymentStatusProcessing');
  if (status === 'pending') return t('paymentStatusPending');
  if (status === 'failed') return t('paymentStatusFailed');
  if (status === 'refunded') return t('paymentStatusRefunded');
  if (status === 'partially_refunded') return t('paymentStatusPartiallyRefunded');
  return status;
}

function PortalConsumeContent() {
  const t = useTranslations('portal.consume');
  const tNav = useTranslations('portal.consume.nav');
  const tContracts = useTranslations('portal.consume.contracts');
  const tUnitChange = useTranslations('portal.consume.unitChange');
  const tInvoices = useTranslations('portal.consume.invoices');
  const tAccess = useTranslations('portal.consume.access');
  const tIncidents = useTranslations('portal.consume.incidents');
  const tFacility = useTranslations('portal.consume.facility');
  const tReferrals = useTranslations('portal.consume.referrals');
  const tPush = useTranslations('portal.consume.push');
  const { locale } = usePortalLocale();
  const portalNav = useMemo(() => buildPortalNav(tNav), [tNav]);
  const portalPrimary = portalNav.slice(0, 4);
  const portalMore = portalNav.slice(4);
  const params = useSearchParams();
  const token = params.get('token');
  const [session, setSession] = useState<PortalSessionDto | null>(null);
  const [invoices, setInvoices] = useState<PortalInvoiceDto[] | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethodDto[] | null>(null);
  const [access, setAccess] = useState<PortalAccessCredentialDto[] | null>(null);
  const [nightPass, setNightPass] = useState<PortalNightPassInfoDto | null>(null);
  const [account, setAccount] = useState<PortalAccountDto | null>(null);
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
  const [cancelingMoveOutId, setCancelingMoveOutId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [addingAccess, setAddingAccess] = useState(false);
  const [extraAccessOpen, setExtraAccessOpen] = useState(false);
  const [extraAccessLabel, setExtraAccessLabel] = useState('');
  const [nightPassConfirmOpen, setNightPassConfirmOpen] = useState(false);
  const [nightPassFacility, setNightPassFacility] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupIntent, setSetupIntent] = useState<SetupIntentResponseDto | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addPending, setAddPending] = useState(false);
  const [goCardlessEnabled, setGoCardlessEnabled] = useState(false);
  // Alta y cobro con tarjeta/IBAN por Stripe (desactivado sin Stripe Connect).
  const [cardPaymentsEnabled, setCardPaymentsEnabled] = useState(false);
  const [redsysEnabled, setRedsysEnabled] = useState(false);
  const [bizumEnabled, setBizumEnabled] = useState(false);
  // Pago por referencia de Redsys: guardar la tarjeta para cobrar solas las cuotas.
  const [cardOnFileEnabled, setCardOnFileEnabled] = useState(false);
  const [saveCard, setSaveCard] = useState(true);
  const [gcPending, setGcPending] = useState(false);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [pmBusy, setPmBusy] = useState<string | null>(null);
  const [pmConfirm, setPmConfirm] = useState<string | null>(null);

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
        setError(err.body.code === 'account_unavailable' ? err.body.message : t('sessionExpired'));
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
        // 1) Un enlace de acceso en la URL manda sobre la sesión guardada: en
        //    un móvil compartido (o al abrir el enlace de otro inquilino) hay
        //    que entrar con el del enlace, no con la sesión anterior.
        let s: PortalSessionDto | null = null;
        if (token) {
          try {
            s = await apiFetch<PortalSessionDto>('/portal/login/consume', {
              method: 'POST',
              json: { token },
              requiresAuth: false,
            });
            storePortalSession(s);
          } catch (err) {
            // Enlace ya usado o caducado: si hay una sesión guardada se sigue
            // con ella (avisando de con quién); si no, error.
            s = loadStoredPortalSession();
            if (!s) throw err;
            toast.info(t('linkUsedContinue', { name: s.customerName }));
          }
          if (typeof window !== 'undefined') {
            window.history.replaceState(null, '', '/portal/consume');
          }
        } else {
          // 2) Sin enlace: la sesión persistida (recargas, volver a la pestaña).
          s = loadStoredPortalSession();
          if (!s) {
            setError(t('invalidLinkFallback'));
            setLoading(false);
            return;
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
        const [inv, pms, acc, refs, ctr, inc, ucr, ucr2, acct] = await Promise.all([
          safe(portalFetch<PortalInvoiceDto[]>(s, '/portal/me/invoices'), []),
          safe(portalFetch<PaymentMethodDto[]>(s, '/portal/me/payment-methods'), []),
          safe(portalFetch<PortalAccessCredentialDto[]>(s, '/portal/me/access'), []),
          safe(portalFetch<PortalReferralDto | null>(s, '/portal/me/referrals'), null),
          safe(portalFetch<PortalContractDto[]>(s, '/portal/me/contracts'), []),
          safe(portalFetch<PortalIncidentDto[]>(s, '/portal/me/incidents'), []),
          safe(portalFetch<PortalUnitChangeRequestDto[]>(s, '/portal/me/unit-change-requests'), []),
          safe(portalFetch<PortalNightPassInfoDto | null>(s, '/portal/me/access/night-pass'), null),
          safe(portalFetch<PortalAccountDto | null>(s, '/portal/me/account'), null),
        ]);
        if (cancelled) return;
        setInvoices(inv);
        setPaymentMethods(pms);
        setAccess(acc);
        setNightPass(ucr2);
        setAccount(acct);
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
          // ¿Ya las tiene activadas en este dispositivo?
          if (k.publicKey && 'serviceWorker' in navigator && 'PushManager' in window) {
            const reg = await navigator.serviceWorker.getRegistration();
            const sub = await reg?.pushManager.getSubscription();
            if (!cancelled && sub) setPushEnabled(true);
          }
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
        // ¿Se puede registrar tarjeta/IBAN por Stripe? (best-effort).
        try {
          const o = await portalFetch<{ cardPayments: boolean }>(s, '/portal/me/payments/options');
          if (!cancelled) setCardPaymentsEnabled(o.cardPayments);
        } catch {
          /* opcional */
        }
        // ¿Ofrece el negocio pago con tarjeta (Redsys)? (best-effort).
        try {
          const r = await portalFetch<{
            enabled: boolean;
            bizumEnabled: boolean;
            cardEnabled?: boolean;
            cardOnFileEnabled?: boolean;
          }>(s, '/portal/me/redsys/enabled');
          if (!cancelled) {
            // Con la tarjeta por Stripe, Redsys solo ofrece Bizum.
            setRedsysEnabled(r.cardEnabled ?? r.enabled);
            setBizumEnabled(r.bizumEnabled);
            setCardOnFileEnabled(!!r.cardOnFileEnabled);
          }
        } catch {
          /* redsys opcional */
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
        setError(err instanceof ApiError ? err.body.message : t('invalidLinkFallback'));
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
      toast.success(tAccess('regenerateSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tAccess('regenerateError'));
    } finally {
      setRegeneratingId(null);
    }
  }

  async function submitExtraAccess() {
    if (!session) return;
    const label = extraAccessLabel.trim();
    if (!label) return;
    setAddingAccess(true);
    try {
      const created = await portalFetch<PortalAccessCredentialDto>(
        session,
        '/portal/me/access/extra',
        { method: 'POST', json: { label } },
      );
      setAccess((prev) => [created, ...(prev ?? [])]);
      setExtraAccessOpen(false);
      setExtraAccessLabel('');
      toast.success(tAccess('extraAccessCreated'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tAccess('extraAccessError'));
    } finally {
      setAddingAccess(false);
    }
  }

  async function buyNightPass() {
    if (!session || !nightPass) return;
    // Con varios locales hay que elegir uno; con uno solo lo decide el servidor.
    const facilityId = nightPass.facilities.length > 1 ? nightPassFacility || undefined : undefined;
    if (nightPass.facilities.length > 1 && !facilityId) {
      toast.error(tAccess('nightPassChooseFacility'));
      return;
    }
    setNightPassConfirmOpen(false);
    setBuyingPass(true);
    try {
      const created = await portalFetch<PortalAccessCredentialDto>(
        session,
        '/portal/me/access/night-pass',
        { method: 'POST', json: facilityId ? { facilityId } : {} },
      );
      setAccess((prev) => [created, ...(prev ?? [])]);
      const inv = await portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices');
      setInvoices(inv);
      setPassRefresh((n) => n + 1);
      toast.success(tAccess('nightPassPurchased'));
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'no_payment_method') {
        toast.error(tAccess('nightPassNoPaymentMethod'));
      } else if (err instanceof ApiError && err.body.code === 'payment_failed') {
        toast.error(tAccess('nightPassChargeFailed'));
      } else {
        toast.error(err instanceof ApiError ? err.body.message : tAccess('nightPassError'));
      }
    } finally {
      setBuyingPass(false);
    }
  }

  async function enablePush() {
    if (!session || !pushKey) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      toast.error(tPush('unsupported'));
      return;
    }
    setPushBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toast.error(tPush('permissionDenied'));
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
      toast.success(tPush('success'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tPush('error'));
    } finally {
      setPushBusy(false);
    }
  }

  async function requestUnitChange() {
    if (!session || ucNote.trim().length < 5) {
      toast.error(tUnitChange('noteTooShort'));
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
      toast.success(tUnitChange('success'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tUnitChange('error'));
    } finally {
      setUcBusy(false);
    }
  }

  async function reportIncident() {
    if (!session || incidentTitle.trim().length < 3) {
      toast.error(tIncidents('tooShort'));
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
      toast.success(tIncidents('success'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tIncidents('error'));
    } finally {
      setReportingIncident(false);
    }
  }

  async function reloadInvoices() {
    if (!session) return;
    try {
      const [inv, acct] = await Promise.all([
        portalFetch<PortalInvoiceDto[]>(session, '/portal/me/invoices'),
        portalFetch<PortalAccountDto>(session, '/portal/me/account'),
      ]);
      setInvoices(inv);
      setAccount(acct);
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
      toast.error(err instanceof ApiError ? err.body.message : tContracts('downloadError'));
    }
  }

  async function downloadInvoicePdf(invoiceId: string) {
    if (!session) return;
    try {
      const { url } = await portalFetch<{ url: string }>(
        session,
        `/portal/me/invoices/${invoiceId}/signed-pdf`,
      );
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('pdfDownloadError'));
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
      toast.success(tContracts('moveOutSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tContracts('moveOutError'));
    }
  }

  async function cancelMoveOut(id: string) {
    if (!session) return;
    setCancelingMoveOutId(id);
    try {
      const updated = await portalFetch<PortalContractDto>(
        session,
        `/portal/me/contracts/${id}/cancel-move-out`,
        { method: 'POST' },
      );
      setContracts((prev) => (prev ?? []).map((c) => (c.id === id ? updated : c)));
      toast.success(tContracts('moveOutCancelSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tContracts('moveOutCancelError'));
    } finally {
      setCancelingMoveOutId(null);
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
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('startAddError'));
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
      toast.success(tInvoices('savedSuccess'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('saveError'));
    }
  }

  async function removePm(id: string) {
    if (!session) return;
    setPmBusy(id);
    try {
      setPaymentMethods(
        await portalFetch<PaymentMethodDto[]>(session, `/portal/me/payment-methods/${id}`, {
          method: 'DELETE',
        }),
      );
      setPmConfirm(null);
      toast.success(tInvoices('removed'));
      void reloadInvoices();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('pmError'));
    } finally {
      setPmBusy(null);
    }
  }

  async function setDefaultPm(id: string) {
    if (!session) return;
    setPmBusy(id);
    try {
      setPaymentMethods(
        await portalFetch<PaymentMethodDto[]>(session, `/portal/me/payment-methods/${id}/default`, {
          method: 'POST',
        }),
      );
      toast.success(tInvoices('defaultSaved'));
      void reloadInvoices();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('pmError'));
    } finally {
      setPmBusy(null);
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
      toast.error(err instanceof ApiError ? err.body.message : tInvoices('gocardlessStartError'));
      setGcPending(false);
    }
  }

  // «Pagar» cobra con el método por defecto: solo si se puede usar (una
  // domiciliación de GoCardless siempre; una tarjeta de Stripe si está activa).
  const canChargeAutomatically = cardPaymentsEnabled
    ? true
    : (paymentMethods ?? []).some((pm) => pm.isDefault && pm.gateway !== 'stripe');

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
        toast.info(tInvoices('chargeProcessing'));
        // Recargar para mostrar «Pago en curso» y desactivar los botones (evita
        // que el inquilino lance un segundo adeudo sobre la misma factura).
        await reloadInvoices();
      } else if (result.status === 'succeeded') {
        toast.success(tInvoices('chargeSuccess'));
        await reloadInvoices();
      } else {
        toast.error(
          result.failureReason
            ? tInvoices('chargeFailedWithReason', { reason: result.failureReason })
            : tInvoices('chargeFailed'),
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'no_payment_method') {
        if (cardPaymentsEnabled) {
          toast.message(tInvoices('addPaymentMethodFirst'));
          void openAddDialog();
        } else {
          toast.message(tInvoices('noAutomaticPayment'));
        }
      } else {
        toast.error(err instanceof ApiError ? err.body.message : tInvoices('chargeError'));
      }
    } finally {
      setPayingId(null);
    }
  }

  /** Paga todas las facturas pendientes con el método guardado, una a una. */
  async function handlePayAll(list: PortalInvoiceDto[]) {
    if (!session) return;
    let ok = 0;
    let processing = 0;
    let failed = 0;
    for (const invoice of list) {
      setPayingId(invoice.id);
      try {
        const r = await portalFetch<PortalChargeResultDto>(
          session,
          `/portal/me/invoices/${invoice.id}/charge`,
          { method: 'POST' },
        );
        if (r.status === 'succeeded') ok += 1;
        else if (r.status === 'processing') processing += 1;
        else failed += 1;
      } catch (err) {
        if (err instanceof ApiError && err.body.code === 'no_payment_method') {
          toast.message(
            cardPaymentsEnabled
              ? tInvoices('addPaymentMethodFirst')
              : tInvoices('noAutomaticPayment'),
          );
          break;
        }
        failed += 1;
      }
    }
    setPayingId(null);
    await reloadInvoices();
    if (failed > 0) toast.error(tInvoices('payAllResult', { ok: ok + processing, failed }));
    else if (processing > 0) toast.info(tInvoices('chargeProcessing'));
    else if (ok > 0) toast.success(tInvoices('chargeSuccess'));
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
            <CardTitle>{t('loadErrorTitle')}</CardTitle>
            <CardDescription>{error ?? t('loadErrorFallback')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/portal/login">{t('requestNewLink')}</Link>
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
  const moreBadgeTotal = portalMore.reduce((sum, i) => sum + (navBadge(i.value)?.count ?? 0), 0);

  return (
    <div className="container max-w-5xl space-y-6 py-10">
      {/* Marca del operador (white-label) — clicable para volver al inicio */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setTab('inicio')}
          title={t('backToHome')}
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
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('greeting', { name: session.customerName })}
          </h1>
          <p className="text-sm text-muted-foreground">{session.email}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PortalLanguageSwitcher />
          <ThemeToggle />
          <InstallPwaButton />
          <Button variant="outline" size="sm" onClick={logout} aria-label={t('logout')}>
            <LogOut className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">{t('logout')}</span>
          </Button>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Menú lateral (ordenador) */}
        <nav className="hidden w-52 shrink-0 space-y-1 md:block">
          {portalNav.map((item) => (
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
          className="pb-app-nav min-w-0 flex-1 md:pb-0"
        >
          <TabsContent value="inicio" className="space-y-6">
            <OverviewCard
              customerName={session.customerName}
              invoices={invoices}
              contracts={contracts ?? []}
              unreadMessages={unreadMessages}
              account={account}
              brandColor={session.brandColor ?? null}
              onNavigate={setTab}
            />
            <OffersCard session={session} onNavigate={handleNav} />
          </TabsContent>

          <TabsContent value="contratos" className="space-y-6">
            <ExtrasCard
              session={session}
              contracts={contracts ?? []}
              account={account}
              access={access ?? []}
              nightPass={nightPass}
              onNavigate={handleNav}
            />
            <RetentionOfferCard
              session={session}
              onChanged={() => {
                void apiFetch<PortalContractDto[]>('/portal/me/contracts', {
                  headers: { Authorization: `Bearer ${session.accessToken}` },
                  requiresAuth: false,
                })
                  .then(setContracts)
                  .catch(() => {});
              }}
            />
            {contracts && contracts.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>{tContracts('title')}</CardTitle>
                  <CardDescription>{tContracts('subtitle')}</CardDescription>
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
                            {c.contractNumber} ·{' '}
                            {tContracts('pricePerMonth', {
                              price: (c.effectivePriceWithVat ?? c.effectivePrice).toLocaleString(
                                intlLocaleForPortal(locale),
                                { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                              ),
                            })}
                            {c.status === 'ending' && c.endDate
                              ? tContracts('moveOutPlanned', { date: c.endDate })
                              : ''}
                          </p>
                        </div>
                        {c.status === 'ending' ? (
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary">{tContracts('moveOutRequested')}</Badge>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={cancelingMoveOutId === c.id}
                              onClick={() => void cancelMoveOut(c.id)}
                            >
                              {cancelingMoveOutId === c.id ? (
                                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                              ) : (
                                <RefreshCw className="mr-1 h-4 w-4" />
                              )}
                              {tContracts('cancelMoveOut')}
                            </Button>
                          </div>
                        ) : (
                          <Button variant="outline" size="sm" onClick={() => setMoveOutId(c.id)}>
                            <LogOut className="mr-1 h-4 w-4" /> {tContracts('requestMoveOut')}
                          </Button>
                        )}
                      </div>
                      {c.overlocked && (
                        <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-xs text-orange-800 dark:border-orange-900 dark:bg-orange-950 dark:text-orange-200">
                          {tContracts('overlockedWarning')}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        {c.depositAmount > 0 && (
                          <span>
                            {tContracts('depositLine', {
                              amount: c.depositAmount.toFixed(2),
                              status: depositLabel(c.depositStatus, tContracts),
                            })}
                          </span>
                        )}
                        {c.insurancePlanName && (
                          <span>
                            {tContracts('insuranceLine', { name: c.insurancePlanName })}
                            {c.insurancePrice
                              ? tContracts('insurancePriceSuffix', {
                                  price: (
                                    c.insurancePriceWithVat ?? c.insurancePrice
                                  ).toLocaleString(intlLocaleForPortal(locale), {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  }),
                                })
                              : ''}
                          </span>
                        )}
                        {c.freeMonthsRemaining > 0 && (
                          <span className="text-green-600">
                            {tContracts('freeMonthsRemaining', { count: c.freeMonthsRemaining })}
                          </span>
                        )}
                        {c.discountAmount > 0 && (
                          <span>
                            {tContracts('discountLine', { amount: c.discountAmount.toFixed(2) })}
                          </span>
                        )}
                      </div>
                      {c.hasSignedPdf && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void downloadContract(c.id)}
                        >
                          <Download className="mr-1 h-4 w-4" /> {tContracts('downloadContract')}
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
                  <Boxes className="h-4 w-4" /> {tUnitChange('title')}
                </CardTitle>
                <CardDescription>{tUnitChange('subtitle')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(contracts ?? []).length > 0 && (
                  <select
                    value={ucContractId}
                    onChange={(e) => setUcContractId(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
                  >
                    <option value="">{tUnitChange('currentUnitOption')}</option>
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
                  placeholder={tUnitChange('notePlaceholder')}
                  maxLength={1000}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
                />
                <Button onClick={requestUnitChange} disabled={ucBusy || ucNote.trim().length < 5}>
                  {ucBusy ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  {tUnitChange('submit')}
                </Button>

                {(unitChanges ?? []).length > 0 && (
                  <ul className="space-y-2 border-t pt-3">
                    {(unitChanges ?? []).map((r) => (
                      <li key={r.id} className="space-y-1 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="line-clamp-1">{r.note}</span>
                          <Badge variant={r.status === 'handled' ? 'default' : 'secondary'}>
                            {r.status === 'pending'
                              ? tUnitChange('statusPending')
                              : r.status === 'handled'
                                ? tUnitChange('statusHandled')
                                : tUnitChange('statusRejected')}
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
            <WaitlistCard session={session} />
          </TabsContent>

          <TabsContent value="facturas" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>{tInvoices('title')}</CardTitle>
              </CardHeader>
              <CardContent>
                {redsysEnabled &&
                  cardOnFileEnabled &&
                  invoices.some((i) => i.amountPending > 0) && (
                    <label className="mb-3 flex items-start gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={saveCard}
                        onChange={(e) => setSaveCard(e.target.checked)}
                      />
                      {tInvoices('saveCard')}
                    </label>
                  )}
                <InvoicesList
                  invoices={invoices}
                  accessToken={session.accessToken}
                  canChargeAutomatically={canChargeAutomatically}
                  redsysEnabled={
                    redsysEnabled &&
                    !(
                      canChargeAutomatically &&
                      (paymentMethods ?? []).some((pm) => pm.isDefault && pm.gateway === 'redsys')
                    )
                  }
                  bizumEnabled={bizumEnabled}
                  saveCard={cardOnFileEnabled && saveCard}
                  payingId={payingId}
                  onPay={(i) => void handlePay(i)}
                  onPayAll={(list) => void handlePayAll(list)}
                  onDownload={(id) => void downloadInvoicePdf(id)}
                />
              </CardContent>
            </Card>

            {payments.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Receipt className="h-5 w-5 text-muted-foreground" />{' '}
                    {tInvoices('paymentHistoryTitle')}
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
                            {p.amount.toLocaleString(intlLocaleForPortal(locale), {
                              style: 'currency',
                              currency: p.currency || 'EUR',
                            })}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {paymentMethodLabel(p.methodType, tInvoices)}
                            {p.invoiceNumber
                              ? tInvoices('paymentInvoiceSuffix', { number: p.invoiceNumber })
                              : ''}
                            {` · ${new Date(p.paidAt ?? p.createdAt).toLocaleDateString(
                              intlLocaleForPortal(locale),
                            )}`}
                          </p>
                        </div>
                        <Badge variant={p.status === 'succeeded' ? 'secondary' : 'outline'}>
                          {paymentStatusLabel(p.status, tInvoices)}
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
                  <CardTitle>{tInvoices('paymentMethodsTitle')}</CardTitle>
                  <CardDescription>{tInvoices('paymentMethodsSubtitle')}</CardDescription>
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
                      {tInvoices('directDebitGoCardless')}
                    </Button>
                  )}
                  {cardPaymentsEnabled && (
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
                      {tInvoices('addIbanOrCard')}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!paymentMethods?.length ? (
                  <p className="text-sm text-muted-foreground">{tInvoices('noPaymentMethod')}</p>
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
                              ? tInvoices('ibanLast4', { last4: pm.last4 ?? '????' })
                              : tInvoices('cardLast4', {
                                  brand: pm.brand ?? tInvoices('defaultCardBrand'),
                                  last4: pm.last4 ?? '????',
                                })}
                          </p>
                          {pm.type === 'sepa_debit' && pm.mandateReference && (
                            <p className="text-xs text-muted-foreground">
                              {tInvoices('mandateReference', { reference: pm.mandateReference })}
                            </p>
                          )}
                        </div>
                        {pm.isDefault ? (
                          <Badge variant="secondary">{tInvoices('default')}</Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pmBusy === pm.id}
                            onClick={() => void setDefaultPm(pm.id)}
                          >
                            {tInvoices('makeDefault')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-auto text-destructive"
                          disabled={pmBusy === pm.id}
                          onClick={() =>
                            pmConfirm === pm.id ? void removePm(pm.id) : setPmConfirm(pm.id)
                          }
                        >
                          {pmConfirm === pm.id ? tInvoices('removeConfirm') : tInvoices('remove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="accesos" className="space-y-6">
            {session && <DoorOpenCard session={session} />}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4" /> {tAccess('title')}
                </CardTitle>
                <CardDescription>{tAccess('subtitle')}</CardDescription>
              </CardHeader>
              <CardContent>
                {access === null ? (
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                ) : access.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{tAccess('noCredentials')}</p>
                ) : (
                  <ul className="grid gap-4 sm:grid-cols-2">
                    {access.map((c) => (
                      <AccessCredentialItem
                        key={c.id}
                        credential={c}
                        regenerating={regeneratingId === c.id}
                        onRegenerate={() => void regenerateAccess(c.id)}
                        onPay={() => handleNav('facturas')}
                      />
                    ))}
                  </ul>
                )}
                {access !== null && (
                  <div className="mt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={addingAccess}
                      onClick={() => {
                        setExtraAccessLabel('');
                        setExtraAccessOpen(true);
                      }}
                    >
                      {addingAccess ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Plus className="mr-1 h-4 w-4" />
                      )}
                      {tAccess('addAccess')}
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
                    <p className="text-sm font-medium">{tAccess('nightPassTitle')}</p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {tAccess('nightPassDescription')}
                    </p>
                    <Button
                      size="sm"
                      disabled={buyingPass}
                      onClick={() => setNightPassConfirmOpen(true)}
                    >
                      {buyingPass && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      {tAccess('buyNightPass', {
                        price: nightPass.price.toLocaleString(intlLocaleForPortal(locale), {
                          style: 'currency',
                          currency: 'EUR',
                        }),
                      })}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <AccessLogsCard session={session} />
          </TabsContent>

          <TabsContent value="mensajes" className="space-y-6">
            {session && <PortalAiChatCard session={session} />}
            {session && <ChatCard session={session} />}
            {session && <NoticesCard session={session} />}
          </TabsContent>

          <TabsContent value="incidencias" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wrench className="h-4 w-4" /> {tIncidents('title')}
                </CardTitle>
                <CardDescription>{tIncidents('subtitle')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <input
                  value={incidentTitle}
                  onChange={(e) => setIncidentTitle(e.target.value)}
                  placeholder={tIncidents('titlePlaceholder')}
                  maxLength={160}
                  className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
                />
                <textarea
                  value={incidentDesc}
                  onChange={(e) => setIncidentDesc(e.target.value)}
                  placeholder={tIncidents('detailsPlaceholder')}
                  maxLength={2000}
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
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
                  {tIncidents('submit')}
                </Button>

                {(incidents ?? []).length > 0 && (
                  <ul className="space-y-2 border-t pt-3">
                    {(incidents ?? []).map((i) => (
                      <li key={i.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="line-clamp-1">{i.title}</span>
                        <Badge variant={i.status === 'resolved' ? 'default' : 'secondary'}>
                          {i.status === 'reported'
                            ? tIncidents('statusReported')
                            : i.status === 'investigating'
                              ? tIncidents('statusInvestigating')
                              : i.status === 'resolved'
                                ? tIncidents('statusResolved')
                                : tIncidents('statusDismissed')}
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
                    <MapPin className="h-5 w-5 text-muted-foreground" /> {tFacility('title')}
                  </CardTitle>
                  <CardDescription>{tFacility('subtitle')}</CardDescription>
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
                          ? tFacility('curfewClosed', {
                              start: f.accessCurfewStart,
                              end: f.accessCurfewEnd,
                            })
                          : tFacility('curfew24h')}
                        {f.contactPhone ? tFacility('phoneSuffix', { phone: f.contactPhone }) : ''}
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
            <ProfileCard
              session={session}
              onSessionRenewed={(renewed) => {
                storePortalSession(renewed);
                setSession(renewed);
              }}
            />

            <DocumentsCard session={session} />

            {referrals?.enabled && referrals.referralCode && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Gift className="h-4 w-4" /> {tReferrals('title')}
                  </CardTitle>
                  <CardDescription>{tReferrals('subtitle')}</CardDescription>
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
                        toast.success(tReferrals('copied'));
                      }}
                    >
                      {tReferrals('copy')}
                    </Button>
                  </div>
                  {referrals.rewards.length > 0 && (
                    <p className="text-sm">
                      {tReferrals('rewardsLabel')}
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
                          {r.status === 'converted'
                            ? tReferrals('statusConverted')
                            : tReferrals('statusPending')}
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
                    <Bell className="h-4 w-4" /> {tPush('title')}
                  </CardTitle>
                  <CardDescription>{tPush('subtitle')}</CardDescription>
                </CardHeader>
                <CardContent>
                  {pushEnabled ? (
                    <p className="text-sm text-emerald-600">{tPush('enabled')}</p>
                  ) : (
                    <Button onClick={enablePush} disabled={pushBusy} variant="outline">
                      {pushBusy ? (
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                      ) : (
                        <Bell className="mr-1 h-4 w-4" />
                      )}
                      {tPush('enable')}
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Barra de navegación inferior (móvil): principales + «Más» */}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-background/95 backdrop-blur md:hidden">
        {portalPrimary.map((item) => (
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
          {tNav('more')}
          {moreBadgeTotal > 0 && (
            <span className="absolute right-2 top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-medium text-white ring-2 ring-background">
              {moreBadgeTotal}
            </span>
          )}
        </button>
      </nav>

      {/* Cajón «Más» (móvil): el resto de secciones */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="bottom" className="rounded-t-xl">
          <SheetTitle className="mb-2">{t('nav.moreOptions')}</SheetTitle>
          <div className="grid grid-cols-3 gap-2 pb-[calc(1rem_+_env(safe-area-inset-bottom))]">
            {portalMore.map((item) => {
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
                      className={`absolute right-2 top-2 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-medium text-white ring-2 ring-background ${b.color}`}
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

      {/* Acceso adicional (antes window.prompt). */}
      <Dialog open={extraAccessOpen} onOpenChange={(o) => !o && setExtraAccessOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tAccess('extraAccessDialogTitle')}</DialogTitle>
            <DialogDescription>{tAccess('extraAccessDialogDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="extra-access-label">
              {tAccess('labelField')}
            </label>
            <Input
              id="extra-access-label"
              value={extraAccessLabel}
              maxLength={60}
              placeholder={tAccess('labelPlaceholder')}
              onChange={(e) => setExtraAccessLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && extraAccessLabel.trim()) void submitExtraAccess();
              }}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setExtraAccessOpen(false)}>
              {tAccess('cancel')}
            </Button>
            <Button
              onClick={() => void submitExtraAccess()}
              disabled={addingAccess || extraAccessLabel.trim().length === 0}
            >
              {addingAccess && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {tAccess('createAccess')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmación de compra del pase nocturno (antes window.confirm). */}
      <Dialog
        open={nightPassConfirmOpen}
        onOpenChange={(o) => !o && setNightPassConfirmOpen(false)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tAccess('nightPassConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {nightPass
                ? tAccess('nightPassConfirmDescription', {
                    price: nightPass.price.toLocaleString(intlLocaleForPortal(locale), {
                      style: 'currency',
                      currency: 'EUR',
                    }),
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          {nightPass && nightPass.facilities.length > 1 && (
            <div className="space-y-1">
              <label htmlFor="night-pass-facility" className="text-sm font-medium">
                {tAccess('nightPassFacility')}
              </label>
              <select
                id="night-pass-facility"
                value={nightPassFacility}
                onChange={(e) => setNightPassFacility(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
              >
                <option value="">{tAccess('nightPassChooseFacility')}</option>
                {nightPass.facilities.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{tAccess('nightPassFacilityHint')}</p>
            </div>
          )}
          {nightPass && nightPass.facilities.length === 1 && (
            <p className="text-sm text-muted-foreground">
              {tAccess('nightPassForFacility', { name: nightPass.facilities[0]!.name })}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNightPassConfirmOpen(false)}>
              {tAccess('cancel')}
            </Button>
            <Button onClick={() => void buyNightPass()} disabled={buyingPass}>
              {buyingPass && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {tAccess('buyAndPay')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) setSetupIntent(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{tInvoices('addDialogTitle')}</DialogTitle>
            <DialogDescription>{tInvoices('addDialogDescription')}</DialogDescription>
          </DialogHeader>
          {setupIntent && (
            <StripeSetupForm
              clientSecret={setupIntent.clientSecret}
              publishableKey={setupIntent.publishableKey}
              stripeAccount={setupIntent.stripeAccount}
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
  const t = useTranslations('portal.consume.contracts.moveOutDialog');
  const notice = contract?.cancellationNoticeDays ?? 15;
  const min = new Date();
  min.setDate(min.getDate() + notice);
  // Fecha local (no UTC): entre las 00:00 y las 02:00 toISOString da la de ayer.
  const minDate = `${min.getFullYear()}-${String(min.getMonth() + 1).padStart(2, '0')}-${String(
    min.getDate(),
  ).padStart(2, '0')}`;
  const [endDate, setEndDate] = useState(minDate);

  return (
    <Dialog open={!!contract} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {contract ? `${contract.unitCode} · ${contract.facilityName}. ` : ''}
            {t('description', { days: notice, minDate })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="moveout-date">
            {t('dateLabel')}
          </label>
          <input
            id="moveout-date"
            type="date"
            min={minDate}
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm sm:text-sm"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button onClick={() => onConfirm(endDate)} disabled={!endDate || endDate < minDate}>
            {t('confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
