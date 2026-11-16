import { of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { DashboardComponent } from './dashboard.component';
import { DashboardResumen } from '../../../core/models/api-payloads';
import { TestBed } from '@angular/core/testing';
import { AdminService } from '../../../core/services/admin.service';
import { AuthService } from '../../../core/services/auth.service';
import { ChangeDetectorRef } from '@angular/core';

const resumen = {
  fecha: '2026-10-06',
  comunidad: {
    usuariosActivos: 114,
    lotes: 190,
    sectores: 4,
    turnosActivos: 182,
    cuentasActivas: 27,
    eventosAnio: 15,
  },
  finanzas: {
    recaudadoMes: 120.5,
    recaudadoAnio: 5300,
    egresosMes: 150,
    egresosAnio: 2100,
    saldoCaja: 7041.5,
    carteraPendiente: 1200,
    carteraVencida: 800,
    usuariosEnMora: 21,
  },
  cobranza: { emitido: 3500, cobrado: 3000, porcentaje: 0.857 },
  asistencia: { promedio: 0.88, ultimosEventos: [] },
  proximosEventos: [],
} satisfies DashboardResumen;

const cdr = { detectChanges: vi.fn() } as any;

describe('Dashboard de administración', () => {
  it('muestra el resumen real del backend', () => {
    const admin = { getDashboardResumen: vi.fn(() => of({ status: 'OK', data: resumen })) };
    TestBed.configureTestingModule({
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: AuthService, useValue: { esTesorero: () => true } },
        { provide: ChangeDetectorRef, useValue: cdr },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    component.ngOnInit();
    expect(admin.getDashboardResumen).toHaveBeenCalled();
    expect(component.resumen?.finanzas?.carteraPendiente).toBe(1200);
    expect(component.resumen?.comunidad.usuariosActivos).toBe(114);
    expect(component.cargandoResumen).toBe(false);
    expect(component.errorCarga).toBe('');
  });

  it('informa el error sin inventar valores', () => {
    const admin = { getDashboardResumen: vi.fn(() => throwError(() => new Error('sin red'))) };
    TestBed.configureTestingModule({
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: AuthService, useValue: { esTesorero: () => true } },
        { provide: ChangeDetectorRef, useValue: cdr },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    component.ngOnInit();
    expect(component.resumen).toBeNull();
    expect(component.errorCarga).not.toBe('');
  });

  it('para quien no es tesorero no hay finanzas ni atajos de cobro', () => {
    const sinFinanzas: DashboardResumen = { ...resumen, finanzas: null, cobranza: null };
    const admin = { getDashboardResumen: vi.fn(() => of({ status: 'OK', data: sinFinanzas })) };
    TestBed.configureTestingModule({
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: AuthService, useValue: { esTesorero: () => false } },
        { provide: ChangeDetectorRef, useValue: cdr },
      ],
    });
    const component = TestBed.runInInjectionContext(() => new DashboardComponent());
    component.ngOnInit();
    expect(component.esTesorero).toBe(false);
    expect(component.resumen?.finanzas).toBeNull();
    expect(component.resumen?.cobranza).toBeNull();
    expect(component.resumen?.comunidad.usuariosActivos).toBe(114);
  });
});
