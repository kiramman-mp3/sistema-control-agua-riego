import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ROLES, session } from '../auth/session';

export interface LoginResponse {
  status: string;
  message: string;
  token: string;
  user: {
    cuentaId: number;
    personaId: number;
    cedula: string;
    nombres: string;
    apellidos: string;
    email: string;
    rol: 'ADMIN' | 'TESORERO' | 'USUARIO';
    rolNombre: string;
    debeCambiarPassword: boolean;
  };
}

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  private apiUrl = `${environment.apiUrl}/auth`;

  private readonly http = inject(HttpClient);

  /** Con `recordar` la sesión sobrevive al cierre del navegador; sin él dura lo que la pestaña. */
  login(cedula: string, password: string, recordar = true): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>(`${this.apiUrl}/login`, { cedula, password, recordar })
      .pipe(
        tap((res) => {
          if (res.token) session.guardar(res.token, res.user, recordar);
        }),
      );
  }

  /**
   * Cierra la sesión en este navegador y en el servidor: el token deja de valer aunque alguien lo
   * haya copiado, y el servidor borra la cookie. El aviso al servidor no bloquea la salida si no hay conexión.
   */
  logout(): void {
    const habia = session.activa();
    session.limpiar();
    if (!habia) return;
    this.http.post(`${this.apiUrl}/logout`, {}).subscribe({ error: () => undefined });
  }

  /**
   * Cambia la contraseña. El servidor revoca los tokens anteriores y devuelve uno nuevo
   * con acceso completo, que reemplaza al de la sesión.
   */
  changePassword(actualPassword: string, nuevaPassword: string): Observable<LoginResponse> {
    return this.http
      .post<LoginResponse>(`${this.apiUrl}/change-password`, {
        actualPassword,
        nuevaPassword,
        recordar: session.recordada(),
      })
      .pipe(
        tap((res) => {
          if (res.token) session.guardar(res.token, res.user);
        }),
      );
  }

  getUser(): LoginResponse['user'] | null {
    return session.usuario<LoginResponse['user']>();
  }

  /** Hay una sesión vigente (la cookie la valida el servidor en cada petición). */
  isLoggedIn(): boolean {
    return session.activa();
  }

  /** La sesión tiene un token temporal que solo sirve para cambiar la contraseña. */
  debeCambiarPassword(): boolean {
    return this.getUser()?.debeCambiarPassword === true;
  }

  /** Directiva: administrador o tesorero. */
  esAdmin(): boolean {
    const rol = this.getUser()?.rol;
    return rol === ROLES.ADMIN || rol === ROLES.TESORERO;
  }

  /** Solo el tesorero accede a la parte financiera. */
  esTesorero(): boolean {
    return this.getUser()?.rol === ROLES.TESORERO;
  }
}
