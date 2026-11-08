import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client.js';
import { useAuth } from './Auth.jsx';
import { ErrorBox, Spinner } from '../components/ui.jsx';

const MetaContext = createContext(null);

// Every engine document type this person may see. Screens are drawn from this.
export function MetaProvider({ children }) {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['meta', user?.id], queryFn: () => get('/meta'), enabled: Boolean(user), staleTime: 300000 });
  if (!user) return children;
  if (query.isLoading) return <Spinner label="Starting" />;
  if (query.isError) return <div className="p-4"><ErrorBox error={query.error} /></div>;
  return <MetaContext.Provider value={query.data}>{children}</MetaContext.Provider>;
}

export const useMeta = () => useContext(MetaContext);
