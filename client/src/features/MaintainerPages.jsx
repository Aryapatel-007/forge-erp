// The maintainer's section: accounts, switching parts of Forge on and off, and choosing what
// each role sees. Everything here is enforced by the server too: a hidden screen is refused
// for that role, and a switched-off part is refused for everyone.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { del, get, put } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Input, PageHeader, Spinner } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { useAuth } from '../context/Auth.jsx';
import { useMeta } from '../context/Meta.jsx';
import { RESOURCES } from '../config/resources.js';
import { allDestinations, buildApps, resolveToken } from '../config/apps.js';
import { buildDepartment, DEPARTMENTS, tokenId } from '../config/departments.js';
import { ROLE_INFO, roleLabel } from '../config/roles.js';
import { DepartmentPage } from './HomePage.jsx';

const everything = () => true;

export function MaintainerHome() {
  const { can } = useAuth();
  if (!can('settings.write')) return <Navigate to="/" replace />;
  const cards = [
    ['users', 'Accounts', 'Make sign-ins for people, set their role, reset passwords, switch accounts off.', '/users'],
    ['grid', 'Features on and off', 'Switch off parts of Forge the company does not use. They disappear for everyone.', '/maintainer/features'],
    ['board', 'What each role sees', 'Choose each role\'s screens. Anything hidden is also blocked for that role.', '/maintainer/roles'],
    ['folder', 'Drawing vault access', 'Who can pull and who can push, per project folder, and tasks that give push rights for a while.', '/vault/admin'],
    ['gear', 'Company settings', 'Name, GSTIN, addresses, approval limits and more.', '/settings'],
    ['shield', 'Audit trail', 'Every change, chained so nothing can be quietly altered.', '/audit'],
    ['clock', 'Jobs and backups', 'Scheduled jobs, email, and backups of everything.', '/system'],
  ];
  return (
    <>
      <PageHeader title="Maintainer" subtitle="Everyone uses the same Forge. What each person sees comes from their role, which you decide here." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(([icon, title, text, to]) => (
          <Link key={to} to={to} className="flex gap-3 rounded-xl border border-line bg-card p-4 transition-shadow hover:shadow-md">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={20} /></span>
            <span><span className="block font-semibold">{title}</span><span className="mt-0.5 block text-sm text-steel">{text}</span></span>
          </Link>
        ))}
      </div>
    </>
  );
}

// ---------- Features ----------
export function FeaturesPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['maintainer', 'features'], queryFn: () => get('/maintainer/features') });
  const [off, setOff] = useState(null);
  const current = off ?? new Set((query.data ?? []).filter((f) => !f.enabled).map((f) => f.key));
  const save = useMutation({
    mutationFn: () => put('/maintainer/features', { disabled: [...current] }),
    onSuccess: () => {
      setOff(null);
      queryClient.invalidateQueries();
      // Menus are built at sign-in; a reload picks up the change at once.
      setTimeout(() => window.location.reload(), 300);
    },
  });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  const groups = [...new Set(query.data.map((f) => f.group))];
  const changed = off !== null;
  const toggle = (key) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOff(next);
  };
  return (
    <>
      <PageHeader
        back={{ to: '/maintainer', label: 'Maintainer' }}
        title="Features on and off"
        subtitle="A part that is off disappears from every screen and the server refuses it, for everyone. Nothing is deleted: switch it on again and it is all there."
        actions={<Button variant="primary" disabled={!changed || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>}
      />
      <ErrorBox error={save.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <Card key={group} title={group}>
            <ul className="divide-y divide-line">
              {query.data.filter((f) => f.group === group).map((f) => {
                const on = !current.has(f.key);
                return (
                  <li key={f.key} className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{f.label}</span>
                      <span className="block text-xs text-steel">{f.blurb}</span>
                    </span>
                    <button type="button" role="switch" aria-checked={on} aria-label={f.label} onClick={() => toggle(f.key)}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-ok' : 'bg-line-strong'}`}>
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
      <p className="mt-3 text-xs text-steel">Always on: items, customers and suppliers, company settings, accounts and the reports on operations.</p>
    </>
  );
}

// ---------- Roles ----------
export function RolesPage() {
  const query = useQuery({ queryKey: ['maintainer', 'roles'], queryFn: () => get('/maintainer/roles') });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  return (
    <>
      <PageHeader back={{ to: '/maintainer', label: 'Maintainer' }} title="What each role sees"
        subtitle="One app for everyone. When someone signs in, their role decides their home page, their menus and what the server lets them do." />
      <Card>
        <ul className="divide-y divide-line">
          {query.data.map((r) => {
            const editable = Boolean(DEPARTMENTS[r.role]);
            const changes = r.screen ? (r.screen.hidden?.length ?? 0) + (r.screen.added?.length ?? 0) : 0;
            return (
              <li key={r.role} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{roleLabel(r.role)} <span className="font-normal text-steel">· {r.people} {r.people === 1 ? 'person' : 'people'}</span></span>
                  <span className="block text-xs text-steel">{ROLE_INFO[r.role]?.blurb}</span>
                </span>
                {changes > 0 && <Badge value={`${changes} changed`} tone="info" />}
                {editable ? <Link to={`/maintainer/roles/${r.role}`}><Button>Choose screens</Button></Link>
                  : <span className="text-xs text-steel">{r.role === 'ADMIN' ? 'Sees everything' : 'Sees the whole company'}</span>}
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="mt-3 text-xs text-steel">Accounts are made under <Link to="/users" className="text-accent underline">Accounts</Link>. A customer or supplier gets the portal role and sees only their own documents.</p>
    </>
  );
}

// What hiding a screen takes away on the server, given what stays visible.
function denials(hiddenIds, visibleTokens) {
  const keep = new Set();
  for (const token of visibleTokens) {
    const config = typeof token === 'string' ? RESOURCES[token.replace(/^\+/, '')] : null;
    if (config) { keep.add(config.read); if (config.write) keep.add(config.write); }
  }
  const deniedPerms = new Set();
  const deniedDoctypes = [];
  const deniedReports = [];
  for (const id of hiddenIds) {
    if (id.startsWith('+') || id.startsWith('@') || id.startsWith('/') || id.startsWith('tile:')) continue;
    if (id.startsWith('#')) { deniedReports.push(id.slice(1)); continue; }
    const config = RESOURCES[id];
    if (config) {
      for (const perm of [config.read, config.write]) if (perm && !keep.has(perm)) deniedPerms.add(perm);
    } else if (id.charAt(0) === id.charAt(0).toUpperCase()) {
      deniedDoctypes.push(id);
    }
  }
  return { deniedPerms: [...deniedPerms], deniedDoctypes, deniedReports };
}

export function RoleScreenPage() {
  const { role } = useParams();
  const meta = useMeta();
  const queryClient = useQueryClient();
  const roles = useQuery({ queryKey: ['maintainer', 'roles'], queryFn: () => get('/maintainer/roles') });
  const saved = roles.data?.find((r) => r.role === role)?.screen ?? null;
  const [hidden, setHidden] = useState(null);
  const [added, setAdded] = useState(null);
  const [search, setSearch] = useState('');
  const dept = DEPARTMENTS[role];
  const hiddenSet = hidden ?? new Set(saved?.hidden ?? []);
  const addedList = added ?? saved?.added ?? [];

  // Every screen in Forge, named the way the role choices name them.
  const destinations = useMemo(() => (meta ? allDestinations(buildApps(everything, meta)) : [])
    .map((d) => ({ ...d, token: d.token ?? (d.to.startsWith('/rep/') ? `#${d.to.slice(5)}` : d.to.startsWith('/reports/') ? `@${d.to.slice(9)}` : null) }))
    .filter((d) => d.token), [meta]);
  const save = useMutation({
    mutationFn: () => {
      const all = [...dept.tasks, ...dept.sections.flatMap((s) => s.items), ...dept.reports];
      const visible = [...all.filter((t) => !hiddenSet.has(tokenId(t))), ...addedList];
      return put(`/maintainer/role-screens/${role}`, { hidden: [...hiddenSet], added: addedList, ...denials([...hiddenSet], visible) });
    },
    onSuccess: () => { setHidden(null); setAdded(null); queryClient.invalidateQueries({ queryKey: ['maintainer', 'roles'] }); },
  });
  const reset = useMutation({
    mutationFn: () => del(`/maintainer/role-screens/${role}`),
    onSuccess: () => { setHidden(null); setAdded(null); queryClient.invalidateQueries({ queryKey: ['maintainer', 'roles'] }); },
  });

  if (!dept) return <Navigate to="/maintainer/roles" replace />;
  if (roles.isLoading || !meta) return <Spinner />;
  const toggle = (id) => {
    const next = new Set(hiddenSet);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHidden(next);
  };
  const label = (token) => {
    if (typeof token === 'string' && token.startsWith('+')) return `New ${(RESOURCES[token.slice(1)]?.single ?? meta.doctypes.find((d) => d.name === token.slice(1))?.label ?? token.slice(1)).toLowerCase()}`;
    return resolveToken(token, everything, meta)?.label ?? tokenId(token);
  };
  const row = (token) => {
    const id = tokenId(token);
    const shown = !hiddenSet.has(id);
    return (
      <label key={id} className="flex cursor-pointer items-center gap-2 px-4 py-1.5 text-sm hover:bg-paper">
        <input type="checkbox" checked={shown} onChange={() => toggle(id)} className="h-4 w-4 accent-[var(--color-accent)]" />
        <span className={shown ? '' : 'text-steel line-through'}>{label(token)}</span>
      </label>
    );
  };
  const preview = buildDepartment(role, everything, meta, { hidden: [...hiddenSet], added: addedList });
  const addable = destinations.filter((d) => d.token && !addedList.includes(d.token) && d.label.toLowerCase().includes(search.toLowerCase())).slice(0, 12);
  const dirty = hidden !== null || added !== null;

  return (
    <>
      <PageHeader
        back={{ to: '/maintainer/roles', label: 'What each role sees' }}
        title={`${roleLabel(role)}: screens`}
        subtitle="Untick what this role does not need. Hidden screens are also blocked for the role, so check nothing they rely on is hidden."
        actions={(
          <div className="flex gap-2">
            {saved && <Button onClick={() => window.confirm('Go back to Forge\'s standard screens for this role?') && reset.mutate()}>Standard screens</Button>}
            <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</Button>
          </div>
        )}
      />
      <ErrorBox error={save.error ?? reset.error} />
      <div className="grid gap-4 xl:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <Card title="Buttons on their home page">{dept.tasks.map(row)}</Card>
          {dept.sections.map((section) => <Card key={section.title} title={section.title}>{section.items.map(row)}</Card>)}
          <Card title="Reports">{dept.reports.map(row)}</Card>
          <Card title="Figures at the top">
            {dept.tiles.map((key) => {
              const id = `tile:${key}`;
              return (
                <label key={id} className="flex cursor-pointer items-center gap-2 px-4 py-1.5 text-sm hover:bg-paper">
                  <input type="checkbox" checked={!hiddenSet.has(id)} onChange={() => toggle(id)} className="h-4 w-4" />
                  <span>{key.replace(/-/g, ' ')}</span>
                </label>
              );
            })}
          </Card>
          <Card title="Also show">
            {addedList.map((token) => (
              <div key={token} className="flex items-center justify-between px-4 py-1.5 text-sm">
                <span>{label(token)}</span>
                <button type="button" className="text-xs text-danger underline" onClick={() => setAdded(addedList.filter((t) => t !== token))}>Remove</button>
              </div>
            ))}
            <div className="p-3">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a screen to add" aria-label="Find a screen to add" />
              {search && (
                <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
                  {addable.map((d) => (
                    <li key={d.token}><button type="button" className="w-full px-3 py-1.5 text-left text-sm hover:bg-paper" onClick={() => { setAdded([...addedList, d.token]); setSearch(''); }}>{d.label} <span className="text-xs text-steel">· {d.appLabel}</span></button></li>
                  ))}
                  {addable.length === 0 && <li className="px-3 py-1.5 text-sm text-steel">Nothing matches.</li>}
                </ul>
              )}
              <p className="mt-2 text-xs text-steel">An added screen shows only if the role is allowed to open it.</p>
            </div>
          </Card>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold text-steel">How their home page will look</p>
          <div className="rounded-2xl border-2 border-dashed border-line p-3">
            <DepartmentPage dept={preview} preview />
          </div>
        </div>
      </div>
    </>
  );
}
