// The public website: pages made of plain text blocks, the catalogue, and an enquiry basket.
// A machine is not bought by card, so the basket ends in an enquiry, not a payment.
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, ErrorBox, Field, Input, Spinner, TextArea } from '../components/ui.jsx';
import { formatPaise } from '../utils/format.js';

const load = async (path) => {
  const response = await fetch(`/api/v1/public${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? 'Something went wrong.');
  return body.data;
};

function useLoad(path) {
  const [state, setState] = useState({ isLoading: true });
  useEffect(() => {
    let isCurrent = true;
    setState({ isLoading: true });
    load(path).then((data) => { if (isCurrent) setState({ data }); }).catch((error) => { if (isCurrent) setState({ error }); });
    return () => { isCurrent = false; };
  }, [path]);
  return state;
}

function ItemImage({ code, name }) {
  const [isMissing, setIsMissing] = useState(false);
  if (isMissing) return null;
  return <img src={`/api/v1/public/catalogue/${encodeURIComponent(code)}/image`} alt={name} loading="lazy" className="mb-2 h-40 w-full rounded object-cover" onError={() => setIsMissing(true)} />;
}

function Catalogue({ basket, setBasket }) {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);
  const items = useLoad(`/catalogue${term ? `?q=${encodeURIComponent(term)}` : ''}`);
  const add = (item) => setBasket((rows) => {
    const found = rows.find((row) => row.code === item.code);
    return found ? rows.map((row) => (row.code === item.code ? { ...row, qty: row.qty + 1 } : row)) : [...rows, { code: item.code, name: item.name, qty: 1 }];
  });
  return (
    <section className="my-4">
      <Input aria-label="Search products" placeholder="Search products" className="mb-3 max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.isLoading && <Spinner />}
      <ErrorBox error={items.error} />
      {items.data?.length === 0 && <p className="text-sm text-steel">Nothing to show here yet.</p>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(items.data ?? []).map((item) => (
          <li key={item.code} className="flex flex-col rounded-lg border border-line bg-card p-3">
            <ItemImage code={item.code} name={item.name} />
            <h3 className="text-sm font-semibold">{item.name}</h3>
            <p className="mt-1 flex-1 whitespace-pre-wrap text-sm text-steel">{item.description}</p>
            {item.pricePaise && <p className="num mt-2 text-sm">{formatPaise(item.pricePaise)}</p>}
            <Button className="mt-2" onClick={() => add(item)}>{basket.some((row) => row.code === item.code) ? 'Add one more' : 'Add to enquiry'}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Enquiry({ basket, setBasket }) {
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const set = (key) => (event) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setIsSending(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/public/enquiry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, items: basket.map(({ code, qty }) => ({ code, qty })) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? 'Something went wrong.');
      setDone(body.data.message);
      setBasket([]);
    } catch (problem) {
      setError(problem);
    } finally {
      setIsSending(false);
    }
  };
  if (done) return <p role="status" className="my-4 rounded-lg border border-line bg-card p-4 text-sm">{done}</p>;
  return (
    <form onSubmit={submit} className="my-4 max-w-xl space-y-3 rounded-lg border border-line bg-card p-4">
      <h2 className="text-base font-semibold">Send an enquiry</h2>
      {basket.length > 0 && (
        <ul className="space-y-1 text-sm">
          {basket.map((row) => (
            <li key={row.code} className="flex items-center justify-between gap-2">
              <span>{row.qty} × {row.name}</span>
              <Button variant="ghost" onClick={() => setBasket((rows) => rows.filter((r) => r.code !== row.code))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <Field label="Your name *"><Input required value={values.name ?? ''} onChange={set('name')} /></Field>
      <Field label="Company"><Input value={values.company ?? ''} onChange={set('company')} /></Field>
      <Field label="Email *"><Input required type="email" value={values.email ?? ''} onChange={set('email')} /></Field>
      <Field label="Phone"><Input type="tel" value={values.phone ?? ''} onChange={set('phone')} /></Field>
      <Field label="What do you need?"><TextArea value={values.message ?? ''} onChange={set('message')} /></Field>
      <input type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px]" value={values.website ?? ''} onChange={set('website')} />
      <ErrorBox error={error} />
      <Button type="submit" variant="primary" disabled={isSending}>{isSending ? 'Sending…' : 'Send enquiry'}</Button>
    </form>
  );
}

function Block({ block, basket, setBasket }) {
  switch (block.kind) {
    case 'HEADING': return <h2 className="mt-6 text-lg font-semibold">{block.text}</h2>;
    case 'CATALOGUE': return <Catalogue basket={basket} setBasket={setBasket} />;
    case 'ENQUIRY': return <Enquiry basket={basket} setBasket={setBasket} />;
    default: return <p className="my-3 whitespace-pre-wrap text-sm leading-relaxed">{block.text}</p>;
  }
}

export function SitePage() {
  const { slug = 'home' } = useParams();
  const site = useLoad('/site');
  const page = useLoad(`/pages/${encodeURIComponent(slug)}`);
  const [basket, setBasket] = useState([]);
  useEffect(() => {
    if (page.data?.title) document.title = `${page.data.title} · ${site.data?.name ?? ''}`;
  }, [page.data, site.data]);
  // With no home page yet, the site still works as a catalogue.
  const fallback = slug === 'home' && page.error;
  return (
    <div className="min-h-full bg-paper">
      <header className="border-b border-line bg-card px-4 py-3">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2">
          <Link to="/site" className="text-base font-bold">{site.data?.name}</Link>
          <nav className="flex flex-wrap gap-3 text-sm" aria-label="Site">
            {(site.data?.menu ?? []).filter((m) => m.slug !== 'home').map((m) => <Link key={m.slug} to={`/site/${m.slug}`} className="underline-offset-2 hover:underline">{m.title}</Link>)}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4">
        {page.isLoading && <Spinner />}
        {page.error && !fallback && <ErrorBox error={page.error} />}
        {page.data && (
          <>
            <h1 className="text-xl font-semibold">{page.data.title}</h1>
            {page.data.blocks.map((block, index) => <Block key={index} block={block} basket={basket} setBasket={setBasket} />)}
          </>
        )}
        {fallback && (
          <>
            <Catalogue basket={basket} setBasket={setBasket} />
            <Enquiry basket={basket} setBasket={setBasket} />
          </>
        )}
      </main>
      {site.data && (
        <footer className="border-t border-line px-4 py-4 text-xs text-steel">
          <div className="mx-auto max-w-5xl whitespace-pre-wrap">{site.data.name}{site.data.address ? `\n${site.data.address}` : ''}{site.data.phone ? `\n${site.data.phone}` : ''}{site.data.email ? ` · ${site.data.email}` : ''}</div>
        </footer>
      )}
    </div>
  );
}
