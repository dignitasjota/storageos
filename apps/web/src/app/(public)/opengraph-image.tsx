import { ImageResponse } from 'next/og';

export const alt = 'TrasterOS — Software de gestión para self-storage y trasteros';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Imagen Open Graph / Twitter (1200x630) generada en el servidor, con la marca
// TrasterOS. Se usa como preview al compartir el enlace en redes/mensajería.
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'linear-gradient(135deg, #2563EB 0%, #1e3a8a 100%)',
          color: '#ffffff',
          padding: '72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          {/* Isotipo aproximado: recuadro blanco con «persiana» de trastero */}
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
            <div style={{ width: '70px', height: '10px', borderRadius: '5px', background: '#2563EB' }} />
            <div style={{ width: '70px', height: '10px', borderRadius: '5px', background: '#2563EB' }} />
            <div style={{ width: '44px', height: '10px', borderRadius: '5px', background: '#2563EB' }} />
          </div>
          <div style={{ fontSize: '58px', fontWeight: 700, letterSpacing: '-2px' }}>TrasterOS</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div style={{ fontSize: '62px', fontWeight: 700, lineHeight: 1.1, letterSpacing: '-2px' }}>
            El software de gestión para tu self-storage
          </div>
          <div style={{ fontSize: '30px', color: '#dbeafe', lineHeight: 1.3 }}>
            Contratos · Facturación Veri*Factu · Cobros · Control de accesos · CRM y analítica
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '26px', color: '#eff6ff' }}>
          <span>En español · Multi-local · Prueba 30 días gratis</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
