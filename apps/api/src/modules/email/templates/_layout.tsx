import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';

import type { ReactNode } from 'react';

interface EmailLayoutProps {
  preview: string;
  heading: string;
  children: ReactNode;
}

/**
 * Estructura comun a todos los emails transaccionales: header con marca,
 * cuerpo dentro de un `Container` y footer con copyright.
 *
 * Estilos inline (los clientes de email no aceptan stylesheets externas).
 */
export function EmailLayout({ preview, heading, children }: EmailLayoutProps) {
  const year = new Date().getUTCFullYear();
  return (
    <Html lang="es">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: '#f6f7f9',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          margin: 0,
          padding: '24px 0',
          color: '#0f172a',
        }}
      >
        <Container
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: 8,
            maxWidth: 560,
            padding: 32,
          }}
        >
          <Section>
            <Text
              style={{
                margin: 0,
                marginBottom: 16,
                fontSize: 14,
                color: '#2563eb',
                fontWeight: 600,
                letterSpacing: 0.5,
              }}
            >
              STORAGEOS
            </Text>
            <Heading
              as="h1"
              style={{
                margin: 0,
                fontSize: 22,
                lineHeight: '28px',
                fontWeight: 600,
              }}
            >
              {heading}
            </Heading>
          </Section>
          <Section style={{ marginTop: 24, fontSize: 15, lineHeight: '24px' }}>{children}</Section>
          <Hr style={{ borderColor: '#e2e8f0', marginTop: 32, marginBottom: 16 }} />
          <Section>
            <Text style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
              © {year} StorageOS. Este email se envia automaticamente; no es necesario que
              respondas.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
