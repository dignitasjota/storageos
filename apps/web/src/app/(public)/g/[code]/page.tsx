import { notFound, redirect } from 'next/navigation';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/**
 * Enlace corto de campaña de marketing (impreso en carteles/flyers, o en un
 * QR): cuenta el clic en el backend y redirige al booking del tenant con los
 * UTM ya puestos, para que la reserva atribuya la conversión a este canal.
 */
async function resolveTarget(code: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/public/marketing/go/${encodeURIComponent(code)}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { targetUrl: string };
    return data.targetUrl;
  } catch {
    return null;
  }
}

export default async function ShortLinkPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const target = await resolveTarget(code);
  if (!target) notFound();
  redirect(target);
}
