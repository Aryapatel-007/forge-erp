// A form anyone can fill in, with no sign-in. It uses plain fetch so a visitor is never sent
// to the login screen by the session handling.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, ErrorBox, Field, Input, Select, Spinner, TextArea } from '../components/ui.jsx';
import { humanise } from '../utils/format.js';

const call = async (path, options) => {
  const response = await fetch(`/api/v1/public${path}`, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? 'Something went wrong.');
  return body.data;
};

export function PublicFormPage() {
  const { slug } = useParams();
  const [form, setForm] = useState(null);
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    call(`/forms/${encodeURIComponent(slug)}`)
      .then((data) => { if (isCurrent) setForm(data); })
      .catch((problem) => { if (isCurrent) setError(problem); });
    return () => { isCurrent = false; };
  }, [slug]);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setIsSending(true);
    try {
      const data = await call(`/forms/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      setDone(data.message);
    } catch (problem) {
      setError(problem);
    } finally {
      setIsSending(false);
    }
  };

  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));

  return (
    <main className="mx-auto min-h-full max-w-xl p-4 md:p-8">
      {!form && !error && <Spinner />}
      {!form && error && <ErrorBox error={error} />}
      {done && <p role="status" className="rounded-lg border border-line bg-card p-4 text-sm">{done}</p>}
      {form && !done && (
        <form onSubmit={submit} className="space-y-3 rounded-lg border border-line bg-card p-4">
          <h1 className="text-lg font-semibold">{form.title}</h1>
          {form.intro && <p className="whitespace-pre-wrap text-sm text-steel">{form.intro}</p>}
          {form.fields.map((field) => (
            <Field key={field.key} label={`${field.label}${field.required ? ' *' : ''}`}>
              {field.type === 'long' && <TextArea required={field.required} value={values[field.key] ?? ''} onChange={set(field.key)} />}
              {field.type === 'select' && (
                <Select required={field.required} value={values[field.key] ?? ''} onChange={set(field.key)}>
                  <option value="">Choose</option>
                  {field.options.map((option) => <option key={option} value={option}>{humanise(option)}</option>)}
                </Select>
              )}
              {!['long', 'select'].includes(field.type) && (
                <Input
                  required={field.required}
                  type={{ email: 'email', date: 'date', phone: 'tel' }[field.type] ?? 'text'}
                  value={values[field.key] ?? ''}
                  onChange={set(field.key)}
                />
              )}
            </Field>
          ))}
          {/* Hidden from people, so only a bot fills it. */}
          <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px]" value={values.website ?? ''} onChange={set('website')} />
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" disabled={isSending}>{isSending ? 'Sending…' : 'Send'}</Button>
        </form>
      )}
    </main>
  );
}
