import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { FinanzasService } from '../../../../core/services/finanzas.service';
import { DialogService } from '../../../../core/services/dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { CARGADOR_JSPDF } from '../../../../core/utils/jspdf';
import { Deudor, Deudores } from '../../../../core/models/finanzas';
import { hoyEnEcuador } from '../../../../core/utils/fechas';
import { CajaPreviaComponent } from './caja-previa/caja-previa.component';
import { DeudoresComponent } from './deudores/deudores.component';

const sinMultas = { actual: 0, anteriores: 0, meses: [] };

const deudor = (id: number, nombre: string, parcial: Partial<Deudor>): Deudor => ({
  persona_id: id,
  cedula: `180000000${id}`,
  nombre,
  agua: { actual: 0, recargo_actual: 0, anteriores: 0, recargo_anteriores: 0, lotes_actual: [], total: 0 },
  multas_asamblea: sinMultas,
  multas_minga: sinMultas,
  total_multas: 0,
  total: 0,
  ...parcial,
});

const datos: Deudores = {
  fecha: '2026-11-26',
  anio: 2026,
  resumen: {
    usuarios: 2,
    total: 150,
    agua: { total: 132, actual: 110, recargo_actual: 22, anteriores: 0, usuarios: 1 },
    multas_asamblea: { total: 18, actual: 8, anteriores: 10, usuarios: 2 },
    multas_minga: { total: 0, actual: 0, anteriores: 0, usuarios: 0 },
  },
  deudores: [
    deudor(1, 'Rosa Caiza', {
      agua: { actual: 100, recargo_actual: 10, anteriores: 22, recargo_anteriores: 2, lotes_actual: ['LJA-1'], total: 132 },
      multas_asamblea: { actual: 5, anteriores: 10, meses: [{ mes: 3, valor: 5, cantidad: 1 }] },
      total_multas: 15,
      total: 147,
    }),
    deudor(2, 'Luis Tapia', {
      multas_asamblea: { actual: 3, anteriores: 0, meses: [{ mes: 4, valor: 3, cantidad: 1 }] },
      total_multas: 3,
      total: 3,
    }),
  ],
} as unknown as Deudores;

function configurar(api: Partial<Record<keyof FinanzasService, unknown>>, dialog: Partial<DialogService> = {}) {
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: FinanzasService, useValue: api },
      { provide: DialogService, useValue: dialog },
      { provide: NotificationService, useValue: notify },
    ],
  });
  return { notify };
}

describe('Deudores', () => {
  it('lista a quien debe algo y filtra por concepto y por nombre o cédula', () => {
    configurar({ getDeudores: () => of({ status: 'OK', data: datos }) });
    const fixture = TestBed.createComponent(DeudoresComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;

    expect(c.filtrados().map((d) => d.nombre)).toEqual(['Rosa Caiza', 'Luis Tapia']);
    expect(c.totalFiltrado()).toBe(150);

    c.filtro.set('AGUA');
    expect(c.filtrados().map((d) => d.nombre)).toEqual(['Rosa Caiza']);
    expect(c.totalFiltrado()).toBe(132);

    c.filtro.set('ASAMBLEA');
    expect(c.totalFiltrado()).toBe(18);
    c.texto.set('tapia');
    expect(c.filtrados().map((d) => d.nombre)).toEqual(['Luis Tapia']);
    c.texto.set('1800000001');
    expect(c.filtrados().map((d) => d.nombre)).toEqual(['Rosa Caiza']);
  });

  it('muestra el resumen y despliega el detalle de un usuario', () => {
    configurar({ getDeudores: () => of({ status: 'OK', data: datos }) });
    const fixture = TestBed.createComponent(DeudoresComponent);
    fixture.detectChanges();
    const texto = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(texto).toContain('2 usuarios con deuda');
    expect(texto).toContain('Rosa Caiza');
    expect(texto).not.toContain('LJA-1');

    fixture.componentInstance.alternar(1);
    fixture.detectChanges();
    const detalle = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(detalle).toContain('LJA-1');
    expect(detalle).toContain('Años anteriores');
  });

  it('descarga un PDF con el reporte filtrado', async () => {
    const tabla = vi.fn();
    const guardar = vi.fn();
    class DocFalso {
      internal = { pageSize: { getWidth: () => 297, getHeight: () => 210 } };
      setFontSize() {}
      text() {}
      getNumberOfPages() {
        return 1;
      }
      save(nombre: string) {
        guardar(nombre);
      }
    }
    configurar({ getDeudores: () => of({ status: 'OK', data: datos }) });
    TestBed.overrideProvider(CARGADOR_JSPDF, {
      useValue: () => Promise.resolve({ jsPDF: DocFalso, autoTable: tabla }),
    });
    const fixture = TestBed.createComponent(DeudoresComponent);
    fixture.detectChanges();
    await fixture.componentInstance.descargarPdf();
    expect(tabla).toHaveBeenCalledTimes(1);
    expect(tabla.mock.calls[0][1].body).toHaveLength(2);
    expect(guardar).toHaveBeenCalledWith('Deudores_2026-11-26.pdf');
  });
});

describe('Caja previa al sistema', () => {
  const registro = (id: number, valor: number, estado: 'VIGENTE' | 'ANULADO') => ({
    id,
    fecha: '2026-01-10',
    valor,
    descripcion: 'Total en caja',
    estado,
    motivo_anulacion: null,
    registrado_por_usuario: 'Tesorero',
  });

  it('suma solo los registros vigentes', () => {
    configurar({
      getIngresosPrevios: () =>
        of({ status: 'OK', data: [registro(1, 100.1, 'VIGENTE'), registro(2, 200.2, 'VIGENTE'), registro(3, 50, 'ANULADO')] }),
    });
    const fixture = TestBed.createComponent(CajaPreviaComponent);
    fixture.detectChanges();
    expect(fixture.componentInstance.total()).toBe(300.3);
  });

  it('valida el formulario antes de enviar y manda el valor con su descripción', () => {
    const registrarIngresoPrevio = vi.fn(() => of({ status: 'OK', message: 'Listo' }));
    const { notify } = configurar({
      getIngresosPrevios: () => of({ status: 'OK', data: [] }),
      registrarIngresoPrevio,
    });
    const fixture = TestBed.createComponent(CajaPreviaComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    const cambiado = vi.fn();
    c.cambiado.subscribe(cambiado);

    c.abrir();
    c.guardar();
    expect(registrarIngresoPrevio).not.toHaveBeenCalled();
    expect(c.errorDe('valor')).toContain('mayor a cero');
    expect(c.errorDe('descripcion')).toContain('mínimo 5');

    c.form.valor = 1250.5;
    c.form.descripcion = '  Total en caja al empezar  ';
    c.form.fecha = '2999-01-01';
    c.guardar();
    expect(c.errorDe('fecha')).toContain('futura');
    c.form.fecha = hoyEnEcuador();
    c.guardar();
    expect(registrarIngresoPrevio).toHaveBeenCalledWith({
      fecha: hoyEnEcuador(),
      valor: 1250.5,
      descripcion: 'Total en caja al empezar',
    });
    expect(notify.success).toHaveBeenCalled();
    expect(cambiado).toHaveBeenCalled();
  });

  it('anular pide el motivo y no hace nada si se cancela', async () => {
    const anularIngresoPrevio = vi.fn(() => of({ status: 'OK', message: 'Anulado' }));
    const solicitar = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('Registrado dos veces');
    configurar(
      { getIngresosPrevios: () => of({ status: 'OK', data: [registro(9, 10, 'VIGENTE')] }), anularIngresoPrevio },
      { solicitar },
    );
    const fixture = TestBed.createComponent(CajaPreviaComponent);
    fixture.detectChanges();
    const c = fixture.componentInstance;
    await c.anular(c.registros()[0]);
    expect(anularIngresoPrevio).not.toHaveBeenCalled();
    await c.anular(c.registros()[0]);
    expect(anularIngresoPrevio).toHaveBeenCalledWith(9, 'Registrado dos veces');
  });
});
