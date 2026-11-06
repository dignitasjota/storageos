import { CreateFacilitySchema, UpdateFacilitySchema } from '@storageos/shared';

import { readableValidationMessage } from '../validation-message';

describe('readableValidationMessage', () => {
  const messageFor = (input: unknown) => {
    const parsed = CreateFacilitySchema.safeParse(input);
    return parsed.success ? null : readableValidationMessage(parsed.error.issues);
  };

  it('nombra el campo y respeta el mensaje del esquema', () => {
    expect(messageFor({ name: 'A' })).toBe('Nombre: Mínimo 2 caracteres');
    expect(messageFor({ name: 'Local', contactEmail: 'mal' })).toBe('Email no válido');
    expect(messageFor({ name: 'Local', videoUrl: 'javascript:alert(1)' })).toBe(
      'Vídeo: El enlace tiene que empezar por https://',
    );
    expect(messageFor({ name: 'Local', timezone: 'Marte/Olympus' })).toBe('Zona horaria no válida');
  });

  it('traduce los mensajes que Zod trae de serie', () => {
    expect(messageFor({})).toBe('Nombre: es obligatorio');
    expect(
      readableValidationMessage([
        { code: 'too_small', type: 'string', minimum: 3, path: ['city'], message: 'String must' },
      ]),
    ).toBe('Ciudad: necesita al menos 3 caracteres');
    expect(
      readableValidationMessage([
        { code: 'too_big', type: 'number', maximum: 10, path: ['amount'], message: 'Number must' },
      ]),
    ).toBe('Importe: tiene que ser 10 o menos');
  });

  it('un campo sin nombre conocido no enseña el nombre técnico', () => {
    expect(
      readableValidationMessage([
        { code: 'invalid_type', received: 'undefined', path: ['xyz'], message: 'Required' },
      ]),
    ).toBe('Revisa los datos del formulario');
  });

  it('un error sin campo enseña su mensaje', () => {
    const parsed = UpdateFacilitySchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(readableValidationMessage(parsed.error.issues)).toBe('Debes enviar al menos un campo');
    }
  });

  it('admite el formato del pipe propio (ruta en texto) y datos raros', () => {
    expect(
      readableValidationMessage([{ path: 'openingHours.mon.close', message: 'Hora HH:MM' }]),
    ).toBe('Horario: Hora HH:MM');
    expect(readableValidationMessage(undefined)).toBeNull();
    expect(readableValidationMessage([])).toBeNull();
  });
});
