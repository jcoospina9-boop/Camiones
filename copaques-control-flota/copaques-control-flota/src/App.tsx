/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { AdminLayout } from './components/AdminLayout.tsx';
import { DriverApp } from './components/DriverApp.tsx';
import { LoginScreen } from './components/LoginScreen.tsx';
import { setAuthToken } from './lib/api.ts';
import type { User } from './types.ts';

export default function App() {
  const [user, setUser] = useState<User | null>(null);

  function handleLogout() {
    setAuthToken(null);
    setUser(null);
  }

  if (!user) {
    return <LoginScreen onAuthenticated={setUser} />;
  }

  if (user.role === 'CONDUCTOR') {
    return <DriverApp user={user} onLogout={handleLogout} />;
  }

  return <AdminLayout user={user} onLogout={handleLogout} />;
}
