import { INFORMACION_JUNTA } from './informacion-junta.data';

describe('Información de la Junta', () => {
  it('presenta la directiva con el presidente y el secretario de la Junta', () => {
    const directiva = INFORMACION_JUNTA.directiva;
    expect(directiva.map((m) => m.cargo)).toEqual([
      'Presidente',
      'Vicepresidente',
      'Secretario',
      'Tesorera',
    ]);
    expect(directiva[0].nombre).toBe('Ramiro Cepeda Caicedo');
    expect(directiva[2].nombre).toBe('John Mora Pérez');
    directiva.forEach((m) => expect(m.nombre.trim()).not.toBe(''));
  });

  it('da la dirección de la sede, el teléfono y el correo de la Junta', () => {
    const contacto = Object.fromEntries(
      INFORMACION_JUNTA.contacto.map((c) => [c.etiqueta, c.valor]),
    );
    expect(contacto['Dirección de la sede']).toBe('Complejo PROMACERO, Sector La Merced');
    expect(contacto['Teléfono']).toBe('098 355 3457');
    expect(contacto['Correo']).toBe('juntalajones@gmail.com');
  });

  it('no publica números de cédula de la directiva', () => {
    expect(JSON.stringify(INFORMACION_JUNTA)).not.toMatch(/[0-9]{10}/);
  });
});
