import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { AdminService } from '../../../../core/services/admin.service';
import { TurnoItem } from '../../../../core/models/api-payloads';
import { Turno, nombreDia } from './turno.model';

/** Turnos de riego desde la API, normalizados para la tabla y el calendario semanal. */
@Injectable({ providedIn: 'root' })
export class TurnosService {
  private admin = inject(AdminService);

  listar(sector_id?: number): Observable<Turno[]> {
    return this.admin.getTurnos(undefined, sector_id).pipe(
      map((res) =>
        (res?.data ?? []).map((t: TurnoItem): Turno => ({
          id: t.id,
          sector_id: t.sector_id,
          dia_semana: Number(t.dia_semana),
          dia: nombreDia(t.dia_semana),
          sector: t.sector_nombre || 'N/A',
          representante: t.representante_nombre || '',
          horaInicio: String(t.hora_inicio || '').substring(0, 5),
          horaFin: String(t.hora_fin || '').substring(0, 5),
          observacion: t.observacion ?? undefined,
        })),
      ),
    );
  }
}
