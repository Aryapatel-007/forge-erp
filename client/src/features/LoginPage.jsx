import { useState } from 'react';
import { Button, ErrorBox, Field, Input } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [isPending, setIsPending] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setIsPending(true);
    try {
      await signIn(email, password);
    } catch (problem) {
      setError(problem);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <main className="flex min-h-full flex-col items-center justify-center bg-rail p-4">
      <div className="mb-5 flex items-center gap-2 text-lg font-bold tracking-wide text-white">
        <span aria-hidden="true" className="h-3 w-3 rotate-45 rounded-[2px] bg-spark" />
        FORGE
      </div>
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-card p-6 shadow-xl">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <Field label="Email"><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <Button type="submit" variant="primary" className="w-full" disabled={isPending}>{isPending ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </main>
  );
}
