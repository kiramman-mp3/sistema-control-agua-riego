import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { vi } from 'vitest';
import { FinanzasService } from '../../../../../core/services/finanzas.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import { DialogService } from '../../../../../core/services/dialog.service';
import { HistoricoUsuario } from '../../../../../core/models/finanzas';
import { hoyEnEcuador } from '../../../../../core/utils/fechas';
import { HistoricoUsuarioComponent, PersonaHistorico } from './historico-usuario.component';

const persona: PersonaHistorico = {
  id: 7,
  cedula: '1804567890',
  nombres: 'Rosa',
  apellidos: 'Caiza',
};

const anio = Number(hoyEnEcuador().slice(0, 4));
const mes = Number(hoyEnEcuador().slice(5, 7));
const vacias = { anterior: null, meses: {} };

const historico = (lotes: HistoricoUsuario['lotes']): { status: 'OK'; data: HistoricoUsuario } => ({
  status: 'OK',
  data: {
    anio,
    mes_actual: mes,
    valor_hectarea_sugerido: 50,
    lotes,
    agua_anterior: null,
    multas: { ASAMBLEA: vacias, MINGA: vacias },
  } as unknown as HistoricoUsuario,
});

const lote = (id: number, hectareas: number) => ({
  lote_id: id,
  codigo: `LJA-${id}`,
  sector_nombre: 'La Merced',
  hectareas,
  superficie_m2: hectareas * 10000,
  cuota: null,
});

function crear(lotes: HistoricoUsuario['lotes'], usuario: PersonaHistorico | null = persona) {
  const guardarHistorico = vi.fn(() => of({ status: 'OK', message: 'Histórico guardado.' }));
  TestBed.configureTestingModule({
    providers: [
      {
        provide: FinanzasService,
        useValue: {
          getHistorico: () => of(historico(lotes)),
          guardarHistorico,
          buscarUsuarios: () => of({ status: 'OK', data: [] }),
        },
      },
      { provide: NotificationService, useValue: { success: vi.fn(), error: vi.fn() } },
      { provide: DialogService, useValue: { confirmarDescartar: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(HistoricoUsuarioComponent);
  fixture.componentRef.setInput('usuario', usuario);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, guardarHistorico };
}

/** Cuota de un lote de 2 ha a $50 por hectárea, con el 10% de recargo si ya pasó el 31 de marzo. */
const cuotaHoy = () => (hoyEnEcuador() > `${anio}-03-31` ? 110 : 100);

describe('Registrar histórico', () => {
  it('empieza por el agua del año si el usuario tiene lotes', () => {
    expect(crear([lote(1, 2)]).c.paso()).toBe('agua');
  });

  it('sin lotes empieza por los años anteriores', () => {
    expect(crear([]).c.paso()).toBe('anteriores');
  });

  it('cada pestaña muestra lo que suma y el total sigue lo que se escribe', () => {
    const { c } = crear([lote(1, 2)]);
    c.estadoLote[1] = 'DEBE';
    c.aguaAnterior = 30;
    c.multas.ASAMBLEA.meses[0] = 5;
    c.multas.MINGA.anterior = 8;

    const [agua, anteriores, multas] = c.pasos();
    expect(agua.subtotal).toBe(cuotaHoy());
    expect(anteriores.subtotal).toBe(38);
    expect(multas.subtotal).toBe(5);
    expect(c.totalPendiente()).toBe(cuotaHoy() + 38 + 5);

    c.estadoLote[1] = 'PAGADA';
    expect(c.pasos()[0].subtotal).toBe(0);
    expect(c.totalPendiente()).toBe(43);
  });

  it('rechaza importes negativos o con más de dos decimales', () => {
    const { c } = crear([lote(1, 2)]);
    c.aguaAnterior = -1;
    c.multas.MINGA.anterior = 2.555;
    expect(c.errores()).toHaveLength(2);
    c.aguaAnterior = 1;
    c.multas.MINGA.anterior = 2.5;
    expect(c.errores()).toEqual([]);
  });

  it('al cambiar de usuario vuelve a la búsqueda con el campo limpio', () => {
    const { c } = crear([lote(1, 2)], null);
    c.elegir(persona);
    expect(c.datos()).not.toBeNull();
    c.buscar('acosta');
    c.cambiarUsuario();
    expect(c.persona()).toBeNull();
    expect(c.termino()).toBe('');
    expect(c.resultados()).toEqual([]);
  });

  it('guarda con lo anotado y avisa al terminar', () => {
    const { c, guardarHistorico } = crear([lote(1, 2)]);
    const guardado = vi.fn();
    c.guardado.subscribe(guardado);
    c.estadoLote[1] = 'PAGADA';
    c.aguaAnterior = 30;
    c.guardar();
    expect(guardarHistorico).toHaveBeenCalledTimes(1);
    const [id, envio] = guardarHistorico.mock.calls[0] as unknown as [
      number,
      { agua_anterior?: number; lotes: { lote_id: number; estado: string }[] },
    ];
    expect(id).toBe(7);
    expect(envio.agua_anterior).toBe(30);
    expect(envio.lotes).toEqual([{ lote_id: 1, estado: 'PAGADA' }]);
    expect(guardado).toHaveBeenCalled();
  });
});
