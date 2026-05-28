import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  fetchAdminSession,
  getAdminApiError,
  loginAdminRequest,
  type AdminLoginInput,
  type AdminUser,
  logoutAdminRequest,
} from '../services/adminApi';
import type { LoadState } from '../core/loadState';

interface AdminAuthContextValue {
  isAuthenticated: boolean;
  admin: AdminUser | null;
  loading: boolean;
  authState: LoadState;
  login: (credentials: AdminLoginInput) => Promise<void>;
  logout: () => void;
}

const AdminAuthContext = createContext<AdminAuthContextValue | null>(null);

export const AdminAuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authState, setAuthState] = useState<LoadState>('loading');

  useEffect(() => {
    const loadSession = async (): Promise<void> => {
      try {
        const activeAdmin = await fetchAdminSession();
        setAdmin(activeAdmin);
        setAuthState('ready');
      } catch {
        setAdmin(null);
        setAuthState('idle');
      } finally {
        setLoading(false);
      }
    };

    void loadSession();
  }, []);

  const login = async (credentials: AdminLoginInput): Promise<void> => {
    try {
      const session = await loginAdminRequest(credentials);
      setAdmin(session.admin);
      setAuthState('ready');
    } catch (error) {
      throw new Error(getAdminApiError(error));
    }
  };

  const logout = (): void => {
    void logoutAdminRequest().finally(() => {
      setAdmin(null);
      setAuthState('idle');
    });
  };

  return (
    <AdminAuthContext.Provider
      value={{
        isAuthenticated: Boolean(admin),
        admin,
        loading,
        authState,
        login,
        logout,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  );
};

export const useAdminAuth = (): AdminAuthContextValue => {
  const context = useContext(AdminAuthContext);

  if (!context) {
    throw new Error('useAdminAuth must be used inside AdminAuthProvider');
  }

  return context;
};
