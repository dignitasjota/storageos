import { describe, expect, it } from 'vitest';

import { adminMessageHtml, adminMessageText, renderAdminEmail } from './email-format';

describe('formato de los correos del admin', () => {
  it('escapa el HTML y da formato al Markdown sencillo', () => {
    const html = adminMessageHtml('Hola **Ana**,\n\n<script>x</script>\n- uno\n- dos');
    expect(html).toContain('<strong>Ana</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<ul');
    expect(html.match(/<li/g)).toHaveLength(2);
  });

  it('convierte enlaces y direcciones sueltas, y rechaza los que no son http', () => {
    const html = adminMessageHtml(
      'Mira [la guía](https://trasteros.pro/ayuda?a=1&b=2) o https://trasteros.pro. [x](javascript:alert(1))',
    );
    expect(html).toContain('href="https://trasteros.pro/ayuda?a=1&amp;b=2"');
    expect(html).toContain('href="https://trasteros.pro"');
    expect(html).not.toContain('href="javascript');
  });

  it('el texto plano deja el enlace a la vista', () => {
    expect(adminMessageText('Ver [aquí](https://x.es) **ya**')).toBe('Ver aquí (https://x.es) ya');
  });

  it('el correo lleva la marca y el pie', () => {
    const mail = renderAdminEmail('Hola', { footerText: 'Pie' });
    expect(mail.html).toContain('TrasterOS');
    expect(mail.text).toBe('Hola\n\n—\nPie');
  });
});
