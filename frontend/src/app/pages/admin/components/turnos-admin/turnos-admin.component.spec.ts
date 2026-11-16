import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from '../../../../core/services/admin.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { TurnosAdminComponent } from './turnos-admin.component';
import { TurnoAsignarComponent } from './turno-asignar/turno-asignar.component';
import { SectorRepresentanteComponent } from './sector-representante/sector-representante.component';

const turnosApi = [
  {
    id: 1,
    sector_id: 1,
    dia_semana: 1,
    hora_inicio: '08:00:00',
    hora_fin: '10:00:00',
    sector_nombre: 'La Merced',
    representante_nombre: 'Ana Pérez',
  },
  {
    id: 2,
    sector_id: 2,
    dia_semana: 3,
    hora_inicio: '14:00:00',
    hora_fin: '16:00:00',
    sector_nombre: 'Centro',
    representante_nombre: null,
  },
];

describe('Turnos de agua', () => {
  let admin: any;
  let dialog: any;
  let notify: any;

  beforeEach(() => {
    admin = {
      getTurnos: vi.fn(() => of({ data: turnosApi })),
      eliminarTurno: vi.fn(() => of({ message: 'Eliminado' })),
      crearTurno: vi.fn(() => of({ message: 'Creado' })),
      asignarRepresentante: vi.fn(() => of({ message: 'Designado' })),
      getCronograma: vi.fn(() => of({ data: [] })),
      getPersonas: vi.fn(() => of({ data: [], pagination: { total: 0 } })),
      getSectores: vi.fn(() => of({ data: [{ id: 1, nombre: 'La Merced' }] })),
    };
    dialog = { confirmar: vi.fn(async () => true) };
    notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: DialogService, useValue: dialog },
        { provide: NotificationService, useValue: notify },
      ],
    });
  });

  it('cuenta los turnos de cada sector para las pastillas del filtro', () => {
    const component = TestBed.createComponent(TurnosAdminComponent).componentInstance;
    component.cargar();
    expect(component.turnosPorSector()).toEqual({ 'La Merced': 1, Centro: 1 });

    component.sectorFiltro.set('Centro');
    expect(component.filtrados().map((t) => t.id)).toEqual([2]);
    // El contador no cambia al filtrar: dice cuántos turnos tiene cada sector.
    expect(component.turnosPorSector()['La Merced']).toBe(1);
  });

  it('normaliza los turnos de la API y filtra por texto, día y sector', () => {
    const component = TestBed.createComponent(TurnosAdminComponent).componentInstance;
    component.cargar();
    expect(component.turnos().map((t) => [t.sector, t.representante, t.dia, t.horaInicio])).toEqual(
      [
        ['La Merced', 'Ana Pérez', 'Lunes', '08:00'],
        ['Centro', '', 'Miércoles', '14:00'],
      ],
    );
    component.busqueda.set('centro');
    expect(component.filtrados().map((t) => t.id)).toEqual([2]);
    component.busqueda.set('ana');
    expect(component.filtrados().map((t) => t.id)).toEqual([1]);
    component.limpiarFiltros();
    component.diaFiltro.set('Lunes');
    expect(component.filtrados().map((t) => t.id)).toEqual([1]);
    component.diaFiltro.set('');
    component.sectorFiltro.set('Centro');
    expect(component.filtrados().map((t) => t.id)).toEqual([2]);
  });

  it('elimina un turno solo tras confirmar y lo quita de la lista sin recargar', async () => {
    const component = TestBed.createComponent(TurnosAdminComponent).componentInstance;
    component.cargar();
    dialog.confirmar.mockResolvedValueOnce(false);
    await component.eliminar(component.turnos()[0]);
    expect(admin.eliminarTurno).not.toHaveBeenCalled();

    await component.eliminar(component.turnos()[0]);
    expect(admin.eliminarTurno).toHaveBeenCalledWith(1);
    expect(component.turnos().map((t) => t.id)).toEqual([2]);
    expect(admin.getTurnos).toHaveBeenCalledTimes(1);
  });

  it('pagina la tabla en el navegador y vuelve a la primera página al filtrar', () => {
    const muchos = Array.from({ length: 30 }, (_, i) => ({ ...turnosApi[i % 2], id: i + 1 }));
    admin.getTurnos.mockReturnValue(of({ data: muchos }));
    const component = TestBed.createComponent(TurnosAdminComponent).componentInstance;
    component.cargar();
    expect(component.turnosDeLaPagina().map((t) => t.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );

    component.pagina.set(2);
    expect(component.turnosDeLaPagina().map((t) => t.id)).toEqual([26, 27, 28, 29, 30]);

    component.porPagina.set(10);
    expect(component.paginaActual()).toBe(1);
    component.pagina.set(3);
    component.sectorFiltro.set('Centro');
    expect(component.paginaActual()).toBe(1);
    expect(component.turnosDeLaPagina()).toHaveLength(10);
    expect(component.turnosDeLaPagina().every((t) => t.sector === 'Centro')).toBe(true);
  });

  it('si la última página se queda sin turnos muestra la anterior', () => {
    const muchos = Array.from({ length: 26 }, (_, i) => ({ ...turnosApi[0], id: i + 1 }));
    admin.getTurnos.mockReturnValue(of({ data: muchos }));
    const component = TestBed.createComponent(TurnosAdminComponent).componentInstance;
    component.cargar();
    component.pagina.set(2);
    component.turnos.update((lista) => lista.filter((t) => t.id !== 26));
    expect(component.paginaActual()).toBe(1);
    expect(component.turnosDeLaPagina()).toHaveLength(25);
  });

  it('exige el sector y valida el horario antes de crear el turno', () => {
    const component = TestBed.createComponent(TurnoAsignarComponent).componentInstance;
    component.guardar();
    expect(notify.warning).toHaveBeenCalledWith('Debe seleccionar el sector.');

    component.turno.sector_id = 1;
    component.turno.hora_inicio = '10:00';
    component.turno.hora_fin = '09:00';
    component.guardar();
    expect(admin.crearTurno).not.toHaveBeenCalled();

    component.turno.hora_fin = '12:00';
    component.guardar();
    expect(admin.crearTurno).toHaveBeenCalledWith(
      expect.objectContaining({
        sector_id: 1,
        dia_semana: 1,
        hora_inicio: '10:00',
        hora_fin: '12:00',
      }),
    );
  });

  it('designa y quita al representante del sector', () => {
    const guardado = vi.fn();
    const fixture = TestBed.createComponent(SectorRepresentanteComponent);
    fixture.componentRef.setInput('sector', { id: 2, nombre: 'Centro', representante: '' });
    fixture.componentInstance.guardado.subscribe(guardado);
    fixture.componentInstance.guardar(7);
    expect(admin.asignarRepresentante).toHaveBeenCalledWith(2, 7);
    fixture.componentInstance.guardar(null);
    expect(admin.asignarRepresentante).toHaveBeenCalledWith(2, null);
    expect(guardado).toHaveBeenCalledTimes(2);
  });
});
