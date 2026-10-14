'use client';

import { useTranslations } from 'next-intl';

/**
 * Botón flotante de WhatsApp (extra «WhatsApp Business»): abre una
 * conversación con el número del negocio con un mensaje ya escrito, que
 * indica que viene de la web (y de qué local, en su ficha).
 */
export function WhatsappFloatButton({
  number,
  facilityName,
}: {
  number: string | null;
  facilityName?: string | null;
}) {
  const t = useTranslations('publicWeb.common');
  if (!number) return null;
  const text = facilityName
    ? t('whatsappMessageFacility', { facility: facilityName })
    : t('whatsappMessage');
  const href = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('whatsappButton')}
      title={t('whatsappButton')}
      // Por encima de las barras fijas inferiores que algunas plantillas tienen en el móvil.
      className="fixed bottom-24 right-4 z-50 flex size-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-lg transition hover:scale-105 focus:outline-none focus-visible:ring-4 focus-visible:ring-[#25D366]/40 sm:bottom-6"
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7 fill-current">
        <path d="M16.04 3C9.4 3 4 8.36 4 14.96c0 2.11.56 4.17 1.62 5.98L4 29l8.27-1.58a12.1 12.1 0 0 0 3.77.6C22.68 28.02 28 22.66 28 16.06 28 9.46 22.68 3 16.04 3Zm0 22.83c-1.2 0-2.38-.2-3.5-.59l-.25-.09-4.9.94.96-4.72-.17-.27a9.7 9.7 0 0 1-1.5-5.14c0-5.4 4.42-9.79 9.86-9.79s9.86 4.39 9.86 9.79c0 5.4-4.43 9.87-9.86 9.87Zm5.4-7.34c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.66.15-.2.3-.76.95-.93 1.15-.17.2-.34.22-.64.07-.3-.15-1.25-.46-2.38-1.46a8.9 8.9 0 0 1-1.65-2.03c-.17-.3-.02-.46.13-.6.13-.13.3-.35.44-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.66-1.59-.91-2.18-.24-.57-.48-.5-.66-.5h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1-1.04 2.45 0 1.44 1.06 2.83 1.21 3.03.15.2 2.08 3.17 5.05 4.44.7.3 1.25.48 1.68.62.7.22 1.35.19 1.86.11.57-.08 1.75-.71 2-1.4.25-.69.25-1.28.17-1.4-.07-.13-.27-.2-.57-.35Z" />
      </svg>
    </a>
  );
}
