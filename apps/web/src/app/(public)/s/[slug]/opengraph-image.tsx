import { ImageResponse } from 'next/og';

import type { PublicLandingDto } from '@storageos/shared';

export const alt = 'Trasteros — reserva tu espacio online';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// Fallback consistente con el resto del sitio (plantilla por defecto, onepage,
// /book, /sign, /portal/login) cuando el tenant no ha configurado su color.
const DEFAULT_BRAND_COLOR = '#2563EB';

async function getLanding(slug: string): Promise<PublicLandingDto | null> {
  try {
    const res = await fetch(`${API_URL}/public/landing/${encodeURIComponent(slug)}`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicLandingDto;
  } catch {
    return null;
  }
}

function cities(data: PublicLandingDto): string {
  const set = [...new Set(data.facilities.map((f) => f.city).filter(Boolean))] as string[];
  return set.join(', ');
}

// Imagen Open Graph / Twitter (1200x630) por tenant: usa su nombre, color y
// logo (white-label) en vez de la marca de TrasterOS — así el enlace
// compartido en redes/WhatsApp muestra el negocio del tenant, no el nuestro.
export default async function OpengraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getLanding(slug);
  const brand = data?.brandColor ?? DEFAULT_BRAND_COLOR;
  const name = data?.tenantName ?? 'Trasteros';
  const where = data ? cities(data) : '';
  const headline = data?.webHeadline ?? `Trasteros${where ? ` en ${where}` : ''}`;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: `linear-gradient(135deg, ${brand} 0%, #0f172a 100%)`,
        color: '#ffffff',
        padding: '72px',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
        {data?.logoUrl ? (
          <img
            src={data.logoUrl}
            alt=""
            width={90}
            height={90}
            style={{
              borderRadius: '18px',
              background: '#ffffff',
              objectFit: 'contain',
              padding: '8px',
            }}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              background: '#ffffff',
              borderRadius: '20px',
              padding: '22px 20px',
            }}
          >
            <div
              style={{ width: '70px', height: '10px', borderRadius: '5px', background: brand }}
            />
            <div
              style={{ width: '70px', height: '10px', borderRadius: '5px', background: brand }}
            />
            <div
              style={{ width: '44px', height: '10px', borderRadius: '5px', background: brand }}
            />
          </div>
        )}
        <div style={{ fontSize: '54px', fontWeight: 700, letterSpacing: '-2px' }}>{name}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div style={{ fontSize: '58px', fontWeight: 700, lineHeight: 1.15, letterSpacing: '-2px' }}>
          {headline}
        </div>
        <div style={{ fontSize: '30px', color: '#e2e8f0', lineHeight: 1.3 }}>
          Consulta disponibilidad y precios · Reserva online en minutos
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', fontSize: '24px', color: '#cbd5e1' }}>
        <span>Creado con TrasterOS</span>
      </div>
    </div>,
    { ...size },
  );
}
