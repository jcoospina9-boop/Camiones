import { useEffect, useState, type FormEvent } from 'react';
import { Eye, EyeOff, Lock, User as UserIcon } from 'lucide-react';
import { apiFetch, setAuthToken } from '../lib/api.ts';
import type { User } from '../types.ts';

interface LoginScreenProps {
  onAuthenticated: (user: User) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps) {
  const [checkingStatus, setCheckingStatus] = useState(true);
  const [needsInitialSetup, setNeedsInitialSetup] = useState(false);
  const [envAdminConfigured, setEnvAdminConfigured] = useState(false);
  const [forceLoginMode, setForceLoginMode] = useState(false);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [logoError, setLogoError] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiFetch<{ needsInitialSetup: boolean; envAdminConfigured: boolean }>('/api/auth/status')
      .then((res) => {
        if (!active) return;
        setNeedsInitialSetup(res.needsInitialSetup);
        setEnvAdminConfigured(res.envAdminConfigured);
      })
      .catch(() => {
        if (!active) return;
        setError('No se pudo conectar con el servidor.');
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
    <div className="min-h-screen bg-[#f6f9f6] flex flex-col justify-between">
      {/* Top Copaques Geometric Ribbon */}
      <div className="h-2 w-full flex shrink-0" aria-hidden="true">
        <div className="flex-1 bg-[#0e7a2d]" />
        <div className="w-1/4 bg-[#65a30d]" />
        <div className="w-1/5 bg-[#eab308]" />
      </div>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-[420px] bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
          {/* Clean White Logo Header */}
          <div className="px-8 pt-8 pb-6 bg-white border-b border-slate-100 flex flex-col items-center text-center">
            {!logoError ? (
              <img
                src="/assets/aistudio/image_2fcce064.png"
                alt="Copaques - Materiales para construcción"
                referrerPolicy="no-referrer"
                onError={() => setLogoError(true)}
                className="w-full max-w-[280px] h-auto object-contain rounded-lg"
              />
            ) : (
              <div className="py-2">
                <span className="text-3xl font-bold tracking-tight text-[#181a18]">copaques</span>
                <p className="text-xs tracking-[0.2em] text-slate-600 mt-1">
                  materiales para construcción
                </p>
              </div>
            )}
          </div>

          {/* Minimal Form Area */}
          <div className="p-7 sm:p-8">
            {checkingStatus ? (
              <div className="py-10 text-center text-sm text-slate-500">
                Conectando...
              </div>
            ) : needsInitialSetup && !forceLoginMode ? (
              <div>
                <h1 className="text-xl font-bold text-[#181a18]">Configuración Inicial</h1>
                <p className="mt-1 text-sm text-slate-600">
                  Crea la cuenta principal de Gerencia.
                </p>

                {error && (
                  <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <form onSubmit={handleInitialSetup} className="mt-5 space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Nombre completo
                    </label>
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Ej. Gerencia Copaques"
                      className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#15803d]"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Usuario
                    </label>
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="gerencia"
                      className="w-full h-11 px-3.5 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#15803d]"
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
                        className="w-full h-11 px-3.5 pr-11 rounded-lg border border-slate-300 text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#15803d]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-0 top-0 h-11 w-11 flex items-center justify-center text-slate-500 hover:text-[#0e7a2d]"
                        aria-label="Mostrar u ocultar contraseña"
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full h-12 rounded-xl bg-[#0e7a2d] hover:bg-[#0b6123] text-white font-semibold text-sm disabled:opacity-60 transition-colors cursor-pointer border-b-2 border-[#eab308]"
                  >
                    {submitting ? 'Creando cuenta...' : 'Crear cuenta e ingresar'}
                  </button>
                </form>

                {envAdminConfigured && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setForceLoginMode(true);
                    }}
                    className="mt-4 w-full text-center text-xs font-medium text-slate-500 hover:text-[#0e7a2d] cursor-pointer"
                  >
                    ¿Ya tienes clave de servidor? Iniciar sesión
                  </button>
                )}
              </div>
            ) : (
              <div>
                <h1 className="text-xl font-bold text-[#181a18]">Control de Flota</h1>
                <p className="mt-1 text-sm text-slate-600">
                  Ingresa con tu usuario y contraseña.
                </p>

                {error && (
                  <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <form onSubmit={handleLogin} className="mt-5 space-y-4">
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
                        placeholder="Tu usuario"
                        className="w-full h-12 pl-10 pr-3.5 rounded-lg border border-slate-300 text-slate-900 text-base focus:outline-none focus:ring-2 focus:ring-[#15803d]"
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
                        className="w-full h-12 pl-10 pr-12 rounded-lg border border-slate-300 text-slate-900 text-base focus:outline-none focus:ring-2 focus:ring-[#15803d]"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-0 top-0 h-12 w-12 flex items-center justify-center text-slate-500 hover:text-[#0e7a2d]"
                        aria-label="Mostrar u ocultar contraseña"
                      >
                        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                      </button>
                    </div>
                  </div>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full h-12 rounded-xl bg-[#0e7a2d] hover:bg-[#0b6123] text-white font-semibold text-base disabled:opacity-60 transition-colors cursor-pointer border-b-2 border-[#eab308]"
                  >
                    {submitting ? 'Ingresando...' : 'Ingresar'}
                  </button>
                </form>

                {needsInitialSetup && (
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setForceLoginMode(false);
                    }}
                    className="mt-4 w-full text-center text-xs font-medium text-slate-500 hover:text-[#0e7a2d] cursor-pointer"
                  >
                    Crear cuenta inicial de Gerencia
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Bottom Copaques Geometric Ribbon */}
      <div className="h-2 w-full flex shrink-0" aria-hidden="true">
        <div className="w-1/4 bg-[#eab308]" />
        <div className="w-1/4 bg-[#84cc16]" />
        <div className="flex-1 bg-[#0e7a2d]" />
      </div>
    </div>
  );
}
