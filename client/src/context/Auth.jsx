import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post, refreshSession, setAccessToken, setSignedOutHandler } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const clear = useCallback(() => {
    setAccessToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setSignedOutHandler(clear);
    refreshSession().then(setUser).catch(() => setUser(null)).finally(() => setIsLoading(false));
  }, [clear]);

  const value = useMemo(() => ({
    user,
    isLoading,
    can: (permission) => Boolean(user?.permissions?.includes(permission)),
    async signIn(email, password) {
      const data = await post('/auth/login', { email, password });
      setAccessToken(data.accessToken);
      setUser(data.user);
    },
    async signOut() {
      try {
        await post('/auth/logout');
      } finally {
        clear();
      }
    },
  }), [user, isLoading, clear]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
