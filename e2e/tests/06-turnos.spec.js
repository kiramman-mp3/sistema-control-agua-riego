const { test, expect } = require('@playwright/test');
const { aviso, dialogo, leerEstado } = require('./ayudas');

// El turno de riego es del sector: se crea, se valida contra cruces de horario, se consulta en tres vistas,
// se edita y se elimina; cada sector tiene un representante que recibe el agua en nombre de todos.
test.describe.configure({ mode: 'serial' });

const SECTOR = 'La Merced';
const nombreCompleto = (u) => `${u.nombres} ${u.apellidos}`;

async function abrirNuevoTurno(page) {
  await page.goto('/admin/turnos');
  await page.getByRole('button', { name: 'Nuevo turno' }).first().click();
  return page.getByRole('dialog');
}

async function llenarHorario(modal, { dia, inicio, fin }) {
  await modal.locator('#turno-dia').selectOption({ label: dia });
  await modal.locator('#turno-inicio').fill(inicio);
  await modal.locator('#turno-fin').fill(fin);
}

test('un turno exige el sector y rechaza un horario que cruza la medianoche por más de 12 horas', async ({ page }) => {
  const modal = await abrirNuevoTurno(page);
  await modal.getByRole('button', { name: 'Guardar turno' }).click();
  await expect(aviso(page, 'Debe seleccionar el sector.')).toBeVisible();

  await modal.locator('#turno-sector').selectOption({ label: SECTOR });
  await llenarHorario(modal, { dia: 'Miércoles', inicio: '09:00', fin: '08:00' });
  await modal.getByRole('button', { name: 'Guardar turno' }).click();
  await expect(aviso(page, 'Un turno que cruza la medianoche puede durar como máximo 12 horas.')).toBeVisible();
  await expect(modal).toBeVisible();
});

// La base sembrada ya reparte el agua de cada sector con tres horarios a la semana: los de estas pruebas van de noche.
test('un turno válido queda en el sector y aparece en la tabla', async ({ page }) => {
  const modal = await abrirNuevoTurno(page);
  await modal.locator('#turno-sector').selectOption({ label: SECTOR });
  await llenarHorario(modal, { dia: 'Miércoles', inicio: '22:00', fin: '23:00' });
  await modal.locator('#turno-obs').fill('Riego por la toma norte (prueba E2E)');
  await modal.getByRole('button', { name: 'Guardar turno' }).click();
  await expect(aviso(page, /Turno de agua creado/i)).toBeVisible();

  await page.getByRole('group', { name: 'Filtrar por sector' }).getByRole('button', { name: SECTOR }).click();
  await page.locator('select[aria-label="Día"]').selectOption({ label: 'Miércoles' });
  const fila = page.locator('tbody tr').filter({ hasText: '22:00' });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText(SECTOR);
  await expect(fila).toContainText('23:00');
});

test('dos turnos que se cruzan en el mismo sector no se permiten', async ({ page }) => {
  const modal = await abrirNuevoTurno(page);
  await modal.locator('#turno-sector').selectOption({ label: SECTOR });
  await llenarHorario(modal, { dia: 'Miércoles', inicio: '22:30', fin: '23:30' });
  await modal.getByRole('button', { name: 'Guardar turno' }).click();
  await expect(page.locator('.toast--error, .toast--danger, .toast--warning').first()).toBeVisible();
  await expect(modal).toBeVisible();

  // Un horario contiguo (sin solaparse) sí es válido.
  await llenarHorario(modal, { dia: 'Miércoles', inicio: '23:00', fin: '23:30' });
  await modal.getByRole('button', { name: 'Guardar turno' }).click();
  await expect(modal).toBeHidden();
});

test('la ficha del turno muestra sus datos y permite editarlo', async ({ page }) => {
  await page.goto('/admin/turnos');
  await page.getByRole('group', { name: 'Filtrar por sector' }).getByRole('button', { name: SECTOR }).click();
  await page.locator('select[aria-label="Día"]').selectOption({ label: 'Miércoles' });
  await page.locator('tbody tr').filter({ hasText: '22:00' }).getByRole('button', { name: /^Ver turno de / }).click();
  const ficha = page.getByRole('dialog');
  await expect(ficha).toContainText(SECTOR);
  await expect(ficha).toContainText('Riego por la toma norte (prueba E2E)');
  await ficha.getByRole('button', { name: /Editar/ }).click();

  const edicion = page.getByRole('dialog');
  await edicion.locator('#edit-dia').selectOption({ label: 'Jueves' });
  await edicion.locator('#edit-inicio').fill('23:00');
  await edicion.locator('#edit-fin').fill('22:00');
  await edicion.getByRole('button', { name: /Guardar/ }).click();
  await expect(aviso(page, 'Un turno que cruza la medianoche puede durar como máximo 12 horas.')).toBeVisible();

  await edicion.locator('#edit-fin').fill('23:45');
  await edicion.getByRole('button', { name: /Guardar/ }).click();
  await expect(aviso(page, /Turno actualizado|actualizado/i)).toBeVisible();

  // La lista sigue filtrada por miércoles: se pasa a jueves para ver el turno editado.
  await page.locator('select[aria-label="Día"]').selectOption({ label: 'Jueves' });
  const fila = page.locator('tbody tr').filter({ hasText: 'Jueves' }).filter({ hasText: '23:45' });
  await expect(fila).toHaveCount(1);
  await expect(fila).toContainText('23:00');
});

test('el representante del sector se designa y se ve en la tabla y el calendario', async ({ page }) => {
  const { receptor } = leerEstado();
  await page.goto('/admin/turnos');
  const tarjeta = page.locator('.sector-rep').filter({ hasText: SECTOR });
  await tarjeta.getByRole('button', { name: /Cambiar|Designar/ }).click();

  const modal = page.getByRole('dialog');
  await modal.getByLabel('Buscar usuario').fill(receptor.cedula);
  await modal.getByRole('listbox', { name: 'Usuarios' }).getByRole('option').first().click();
  await modal.getByRole('button', { name: 'Designar' }).click();
  await expect(aviso(page, /Representante del sector designado/i)).toBeVisible();
  await expect(tarjeta).toContainText(nombreCompleto(receptor));

  await page.getByRole('group', { name: 'Filtrar por sector' }).getByRole('button', { name: SECTOR }).click();
  await expect(page.locator('tbody tr').first()).toContainText(nombreCompleto(receptor));

  await page.getByRole('tab', { name: 'Calendario semanal' }).click();
  await expect(page.getByText(receptor.nombres).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Tabla' }).click();
});

test('la tabla de turnos filtra por sector, día y texto', async ({ page }) => {
  const { receptor } = leerEstado();
  await page.goto('/admin/turnos');

  await page.getByRole('group', { name: 'Filtrar por sector' }).getByRole('button', { name: SECTOR }).click();
  // Buscar por el representante deja todos los turnos de su sector.
  await page.getByLabel('Buscar turno').fill(receptor.nombres);
  const filas = page.locator('tbody tr');
  await expect(filas.first()).toContainText(receptor.nombres);
  const total = await filas.count();
  expect(total).toBeGreaterThan(1);

  // La base sembrada puede tener otro turno el jueves: se identifica el de la prueba por su horario.
  await page.locator('select[aria-label="Día"]').selectOption({ label: 'Jueves' });
  await expect(filas.filter({ hasText: '23:45' })).toHaveCount(1);
  await expect(filas.filter({ hasNotText: 'Jueves' })).toHaveCount(0);
});

test('eliminar un turno pide confirmación y lo quita de la lista', async ({ page }) => {
  await page.goto('/admin/turnos');
  await page.getByRole('group', { name: 'Filtrar por sector' }).getByRole('button', { name: SECTOR }).click();
  await page.locator('select[aria-label="Día"]').selectOption({ label: 'Jueves' });
  const turno = page.locator('tbody tr').filter({ hasText: '23:45' });
  await expect(turno).toHaveCount(1);

  const eliminar = turno.getByRole('button', { name: `Eliminar turno de ${SECTOR}` });
  await eliminar.click();
  await dialogo(page).getByRole('button', { name: 'Cancelar' }).click();
  await expect(turno).toHaveCount(1);

  await eliminar.click();
  await dialogo(page).getByRole('button', { name: 'Eliminar' }).click();
  await expect(aviso(page, /Turno eliminado|eliminado/i)).toBeVisible();
  await expect(turno).toHaveCount(0);
});
