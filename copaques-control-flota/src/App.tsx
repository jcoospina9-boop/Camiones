/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { AdminLayout } from './components/AdminLayout.tsx';
import { DriverApp } from './components/DriverApp.tsx';
import { LoginScreen } from './components/LoginScreen.tsx';
import { apiFetch, setAuthToken } from './lib/api.ts';
import type { User } from './types.ts';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);

  useEffect(() => {
    let active = true;
    apiFetch<{ user: User; token?: string }>('/api/auth/me')
      .then((res) => {
        if (!active) return;
        if (res.token) setAuthToken(res.token);
        setUser(res.user);
      })
      .catch(() => {
        // No active session cookie; show login screen
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function handleLogout() {
    apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthToken(null);
    setUser(null);
  }

  if (restoring) {
    return (
      <div className="min-h-screen bg-[#f6f9f6] flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-2xl px-6 py-5 text-sm font-medium text-slate-600 shadow-xs">
          Verificando sesión...
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen onAuthenticated={setUser} />;
  }

  if (user.role === 'CONDUCTOR') {
    return <DriverApp user={user} onLogout={handleLogout} />;
  }

  return <AdminLayout user={user} onLogout={handleLogout} />;
}
