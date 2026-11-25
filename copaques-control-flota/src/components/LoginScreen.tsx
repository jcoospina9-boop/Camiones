import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, ShieldCheck, Truck, User as UserIcon } from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api.ts';
import type { User } from '../types.ts';

interface LoginScreenProps {
  onAuthenticated: (user: User) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ needsInitialSetup: boolean; envAdminConfigured: boolean }>('/api/auth/status')
      .then((res) => {
        if (!active) return;
        setNeedsInitialSetup(res.needsInitialSetup);
      })
      .catch(() => {
        if (!active) return;
        setError('No se pudo conectar con el servidor. Verifica que el servicio esté activo.');
      })
      .finally(() => {
        if (active) setCheckingStatus(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al iniciar sesión.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInitialSetup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch<{ token: string; user: User }>('/api/auth/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: username || 'gerencia',
          password,
          full_name: fullName,
        }),
      });
      setAuthToken(res.token);
      onAuthenticated(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al configurar la cuenta inicial.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center px-4 py-8 sm:px-6 lg:px-8">
      <div className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Informational Panel */}
        <div className="lg:col-span-6 bg-emerald-950 text-white rounded-2xl p-8 sm:p-10 flex flex-col justify-between border border-emerald-900">
          <div>
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-xl bg-yellow-400 text-emerald-950 flex items-center justify-center shrink-0">
                <Truck className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Copaques</h1>
                <p className="text-xs text-emerald-200">
                  Control de Flota y Recorridos
                </p>
              </div>
            </div>

            <h2 className="mt-8 text-3xl font-semibold tracking-tight text-balance text-white leading-tight">
              Trazabilidad GPS y control operativo de la flota Copaques
            </h2>

            <p className="mt-4 text-sm text-emerald-100/85 leading-relaxed">
              Registro automático de fecha, hora y ubicación GPS para los camiones distribuidores de
              materiales de construcción de Copaques.
            </p>
          </div>

          <div className="mt-10 pt-6 border-t border-emerald-900 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="font-semibold text-yellow-300">Aplicación Conductor</p>
              <p className="mt-1 text-xs text-emerald-100/75">
                Botones amplios para inicio de jornada, entradas, salidas y fin de jornada con captura GPS automática.
              </p>
            </div>
            <div>
              <p className="font-semibold text-yellow-300">Panel de Gerencia</p>
              <p className="mt-1 text-xs text-emerald-100/75">
                Mapas de recorridos diarios, geocercas automáticas, reportes PDF/Excel y respaldos locales.
              </p>
            </div>
          </div>
        </div>

        {/* Right Auth / Setup Card */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-2xl p-8 sm:p-10 flex flex-col justify-center">
          {checkingStatus ? (
            <div className="py-12 text-center text-sm text-slate-500">
              Verificando estado del sistema...
            </div>
          ) : needsInitialSetup ? (
            <div>
              <div className="flex items-center gap-2 text-emerald-700 text-xs font-semibold mb-2">
                <ShieldCheck className="w-4 h-4" />
                <span>Primer inicio del sistema</span>
              </div>
              <h2 className="text-2xl font-bold text-slate-900">
                Configurar Cuenta de Gerencia
              </h2>
              <p className="mt-2 text-sm text-slate-600">
                Crea la primera cuenta administrativa para gestionar camiones, conductores, geocercas y reportes.
              </p>

              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleInitialSetup} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Nombre completo del administrador
                  </label>
                  <input
                    type="text"
                    required
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Ej. Gerencia Copaques"
                    className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Usuario de acceso
                  </label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="gerencia"
                    className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Contraseña (mínimo 6 caracteres)
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      minLength={6}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full h-11 px-3.5 pr-11 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-slate-500 hover:text-emerald-800"
                      aria-label="Mostrar u ocultar contraseña"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 rounded-xl bg-emerald-800 text-white font-semibold text-sm hover:bg-emerald-900 disabled:opacity-60 transition-colors cursor-pointer"
                >
                  {submitting ? 'Creando cuenta...' : 'Crear Cuenta de Gerencia e Ingresar'}
                </button>
              </form>
            </div>
          ) : (
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Iniciar Sesión</h2>
              <p className="mt-1.5 text-sm text-slate-600">
                Ingresa con tu usuario asignado de conductor o gerencia.
              </p>

              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  {error}
                </div>
              )}

              <form onSubmit={handleLogin} className="mt-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Usuario
                  </label>
                  <div className="relative">
                    <UserIcon className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    <input
                      type="text"
                      required
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="camion01 o gerencia"
                      className="w-full h-12 pl-10 pr-3.5 rounded-lg border border-slate-300 text-slate-900 text-base focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Contraseña
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="w-full h-12 pl-10 pr-12 rounded-lg border border-slate-300 text-slate-900 text-base focus:outline-none focus:ring-2 focus:ring-emerald-700"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-0 top-0 h-12 w-12 flex items-center justify-center text-slate-500 hover:text-emerald-800"
                      aria-label="Mostrar u ocultar contraseña"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 rounded-xl bg-emerald-800 text-white font-semibold text-base hover:bg-emerald-900 disabled:opacity-60 transition-colors cursor-pointer"
                >
                  {submitting ? 'Verificando...' : 'Ingresar'}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
