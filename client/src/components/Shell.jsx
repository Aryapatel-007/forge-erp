// The frame around every page, built like the large ERPs:
//   top bar      always here: home, apps, search, create, notifications, you
//   area bar     the menus of the area you are in, and only that area
//   bottom bar   the same essentials within thumb reach on a phone
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, get, post, queryString } from '../api/client.js';
import { useAuth } from '../context/Auth.jsx';
import { useMeta } from '../context/Meta.jsx';
import { allDestinations, appForPath, buildApps, createItems } from '../config/apps.js';
import { currentLanguage, LANGUAGES, setLanguage } from '../i18n.js';
import { formatDateTime } from '../utils/format.js';
import { Icon } from './icons.jsx';
import { Menu, MenuButton, MenuLink, MenuTitle, Select } from './ui.jsx';

export function useApps() {
  const { can, user } = useAuth();
  const meta = useMeta();
  return useMemo(() => (meta ? buildApps(can, meta) : []), [meta, user]); // eslint-disable-line react-hooks/exhaustive-deps
}

const barButton = 'inline-flex h-9 w-9 items-center justify-center rounded-lg text-rail-text hover:bg-white/10 hover:text-white';

export const AppTile = ({ app }) => (
  <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: app.tint }}>
    <Icon name={app.icon} size={19} />
  </span>
);

function AppsMenu({ apps }) {
  return (
    <Menu
      label="Apps"
      align="left"
      width="md:w-[28rem]"
      button={({ toggle, isOpen }) => <button type="button" aria-label="All areas" aria-expanded={isOpen} className={barButton} onClick={toggle}><Icon name="grid" /></button>}
    >
      {(close) => (
        <ul className="grid grid-cols-3 gap-1 p-1">
          {apps.map((app) => (
            <li key={app.key}>
              <Link to={`/app/${app.key}`} onClick={close} className="flex flex-col items-center gap-1.5 rounded-lg px-1 py-3 text-center text-xs hover:bg-paper">
                <AppTile app={app} />
                {app.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Menu>
  );
}

function CreateMenu({ items, trigger }) {
  return (
    <Menu label="Create" button={trigger}>
      {(close) => (
        <>
          <MenuTitle>Create new</MenuTitle>
          {items.map((item) => <MenuLink key={item.to} to={item.to} onClick={close}>{item.label}</MenuLink>)}
        </>
      )}
    </Menu>
  );
}

function Bell({ unread }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications') });
  const readAll = useMutation({
    mutationFn: () => post('/notifications/read'),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['notifications'] });
      client.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });
  return (
    <Menu
      label="Notifications"
      width="md:w-80"
      button={({ toggle, isOpen }) => (
        <button type="button" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={isOpen} className={`${barButton} relative`} onClick={toggle}>
          <Icon name="bell" />
          {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-spark px-1 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs text-accent underline" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          {(notes.data ?? []).length === 0 && <p className="px-3 py-6 text-center text-sm text-steel">Nothing new.</p>}
          {(notes.data ?? []).slice(0, 12).map((note) => (
            <MenuButton key={note.id} onClick={() => { close(); if (note.link) navigate(note.link); }}>
              <span className="min-w-0">
                <span className={`block text-sm ${note.readAt ? 'text-steel' : 'font-medium'}`}>{note.title}</span>
                <span className="block text-xs text-steel">{formatDateTime(note.createdAt)}</span>
              </span>
            </MenuButton>
          ))}
          <MenuLink to="/my-work" onClick={close}><Icon name="check" size={16} />My work</MenuLink>
        </>
      )}
    </Menu>
  );
}

function UserMenu({ user, signOut }) {
  const initials = user.name.split(/\s+/).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
  return (
    <Menu
      label="Your account"
      button={({ toggle, isOpen }) => (
        <button type="button" aria-label="Your account" aria-expanded={isOpen} className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs font-semibold text-white hover:bg-white/25" onClick={toggle}>{initials}</button>
      )}
    >
      {(close) => (
        <>
          <div className="px-3 py-2">
            <div className="truncate text-sm font-semibold">{user.name}</div>
            <div className="truncate text-xs text-steel">{user.email}</div>
          </div>
          <MenuLink to="/my-work" onClick={close}><Icon name="check" size={16} />My work</MenuLink>
          <MenuLink to="/password" onClick={close}><Icon name="edit" size={16} />Change password</MenuLink>
          <div className="px-3 py-2">
            <label className="block text-xs text-steel" htmlFor="language">Language</label>
            <Select id="language" className="mt-1" defaultValue={currentLanguage()} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </Select>
          </div>
          <MenuButton onClick={signOut}><Icon name="logout" size={16} />Sign out</MenuButton>
        </>
      )}
    </Menu>
  );
}

/* ---------- Search everywhere ---------- */

function CommandSearch({ apps, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef(null);
  const destinations = useMemo(() => allDestinations(apps), [apps]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 200);
    return () => clearTimeout(timer);
  }, [q]);
  const records = useQuery({ queryKey: ['search', term], queryFn: () => get(`/search${queryString({ q: term })}`), enabled: term.length >= 2 });

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const places = words.length ? destinations.filter((d) => words.every((word) => d.label.toLowerCase().includes(word))).slice(0, 8) : [];
  const found = (records.data ?? []).map((row) => ({ to: `/${row.doctype}/${row.id}`, label: row.label, appLabel: row.typeLabel ?? row.doctype.replace(/([a-z0-9])([A-Z])/g, '$1 $2'), isRecord: true }));
  const rows = [...found, ...places];
  useEffect(() => { setAt(0); }, [q, records.data]);

  const go = (row) => { onClose(); navigate(row.to); };
  const onKey = (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setAt((i) => Math.min(rows.length - 1, i + 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    if (event.key === 'Enter' && rows[at]) go(rows[at]);
    if (event.key === 'Escape') onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-0 md:p-4 md:pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <button type="button" aria-label="Close search" className="absolute inset-0" onClick={onClose} />
      <div className="relative flex h-full w-full flex-col overflow-hidden bg-card shadow-2xl md:h-auto md:max-h-[70vh] md:max-w-xl md:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="text-steel" />
          <input
            ref={input}
            aria-label="Search for a document, a person, or a screen"
            placeholder="Search numbers, names or screens"
            className="min-h-12 flex-1 bg-transparent outline-none"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="button" aria-label="Close" className="p-1 text-steel" onClick={onClose}><Icon name="close" /></button>
        </div>
        <ul className="flex-1 overflow-y-auto p-1.5">
          {rows.map((row, index) => (
            <li key={row.to}>
              <button type="button" className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm ${index === at ? 'bg-accent-soft' : 'hover:bg-paper'}`} onMouseEnter={() => setAt(index)} onClick={() => go(row)}>
                <span className="min-w-0 truncate">{row.label}</span>
                <span className="shrink-0 text-xs text-steel">{row.appLabel}</span>
              </button>
            </li>
          ))}
          {!rows.length && words.length > 0 && !records.isFetching && <li className="px-3 py-8 text-center text-sm text-steel">Nothing found.</li>}
          {!words.length && <li className="px-3 py-8 text-center text-sm text-steel">Type a document number, a customer, an item, or the name of a screen.</li>}
        </ul>
      </div>
    </div>
  );
}

/* ---------- The bar for the area you are in ---------- */

function AreaBar({ app }) {
  const location = useLocation();
  const groupHas = (section) => section.items.some((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`));
  const tabClass = (isActive) => `inline-flex h-10 shrink-0 items-center gap-1 whitespace-nowrap border-b-2 px-2.5 text-sm ${isActive ? 'border-accent font-semibold text-ink' : 'border-transparent text-steel hover:text-ink'}`;
  return (
    <div className="no-print border-b border-line bg-card">
      <nav aria-label={app.label} className="no-scrollbar mx-auto flex max-w-[1500px] items-center gap-0.5 overflow-x-auto px-3 md:overflow-visible md:px-5">
        <Link to={`/app/${app.key}`} className="mr-2 flex shrink-0 items-center gap-2 py-1.5 pr-1">
          <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-white" style={{ background: app.tint }}><Icon name={app.icon} size={14} /></span>
          <span className="text-sm font-semibold">{app.label}</span>
        </Link>
        <NavLink to={`/app/${app.key}`} end className={({ isActive }) => tabClass(isActive)}>Overview</NavLink>
        {app.sections.map((section) => (section.items.length === 1 ? (
          <NavLink key={section.title} to={section.items[0].to} className={({ isActive }) => tabClass(isActive)}>{section.title}</NavLink>
        ) : (
          <Menu
            key={section.title}
            label={section.title}
            align="left"
            width="md:w-60"
            button={({ toggle, isOpen }) => (
              <button type="button" aria-expanded={isOpen} aria-haspopup="menu" className={tabClass(groupHas(section))} onClick={toggle}>
                {section.title}<Icon name="chevronDown" size={13} />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="px-3 pb-1 pt-2 text-sm font-semibold md:hidden">{section.title}</div>
                {section.items.map((item) => (
                  <MenuLink key={item.to} to={item.to} onClick={close} {...(item.external ? { target: '_blank', rel: 'noreferrer' } : {})}>{item.label}</MenuLink>
                ))}
              </>
            )}
          </Menu>
        )))}
        {app.reports.length > 0 && <NavLink to={`/app/${app.key}/reports`} className={({ isActive }) => tabClass(isActive)}>Reports</NavLink>}
        {app.setup.length > 0 && <NavLink to={`/app/${app.key}/setup`} className={({ isActive }) => tabClass(isActive)}>Setup</NavLink>}
      </nav>
    </div>
  );
}

function BottomBar({ onSearch, createItemsList, unread }) {
  const item = 'flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]';
  const active = ({ isActive }) => `${item} ${isActive ? 'font-semibold text-accent' : 'text-steel'}`;
  return (
    <nav aria-label="Main" className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden">
      <NavLink to="/" end className={active}><Icon name="home" size={21} />Home</NavLink>
      <NavLink to="/apps" className={active}><Icon name="grid" size={21} />Apps</NavLink>
      <div className="flex flex-1 items-center justify-center">
        <CreateMenu
          items={createItemsList}
          trigger={({ toggle, isOpen }) => (
            <button type="button" aria-label="Create new" aria-expanded={isOpen} className="flex h-11 w-11 items-center justify-center rounded-full bg-accent text-white shadow-md" onClick={toggle}><Icon name="plus" size={22} /></button>
          )}
        />
      </div>
      <button type="button" className={`${item} text-steel`} onClick={onSearch}><Icon name="search" size={21} />Search</button>
      <NavLink to="/my-work" className={active}>
        <span className="relative">
          <Icon name="check" size={21} />
          {unread > 0 && <span className="absolute -right-2 -top-1 h-2.5 w-2.5 rounded-full bg-spark" />}
        </span>
        My work
      </NavLink>
    </nav>
  );
}

export function Shell() {
  const { user, can, signOut } = useAuth();
  const location = useLocation();
  const meta = useMeta();
  const apps = useApps();
  const [isSearching, setIsSearching] = useState(false);
  const lastApp = useRef(null);
  const notes = useQuery({ queryKey: ['notifications-count'], queryFn: () => api('/notifications'), refetchInterval: 120000 });
  const unread = notes.data?.meta?.unread ?? 0;
  const creatable = useMemo(() => (meta ? createItems(can, meta) : []), [meta, user]); // eslint-disable-line react-hooks/exhaustive-deps

  const app = appForPath(apps, location.pathname, lastApp.current);
  if (app) lastApp.current = app.key;

  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
      if ((event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !typing)) {
        event.preventDefault();
        setIsSearching(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setIsSearching(false); }, [location.pathname]);

  if (location.pathname.startsWith('/print/')) return <Outlet />;

  return (
    <div className="flex h-full flex-col">
      <header className="no-print z-40 bg-rail text-white">
        <div className="mx-auto flex h-12 max-w-[1500px] items-center gap-1.5 px-3 md:px-5">
          <div className="hidden md:block"><AppsMenu apps={apps} /></div>
          <Link to="/" className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 font-bold tracking-wide hover:bg-white/10" aria-label="Forge home">
            <span aria-hidden="true" className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-spark" />
            FORGE
          </Link>
          <div className="flex flex-1 justify-center px-2">
            <button type="button" className="hidden h-9 w-full max-w-md items-center gap-2 rounded-lg bg-white/10 px-3 text-sm text-rail-text hover:bg-white/15 md:flex" onClick={() => setIsSearching(true)}>
              <Icon name="search" size={16} />
              <span className="flex-1 text-left">Search everything</span>
              <kbd className="rounded bg-white/10 px-1.5 text-[11px]">Ctrl K</kbd>
            </button>
          </div>
          <div className="hidden md:block">
            <CreateMenu
              items={creatable}
              trigger={({ toggle, isOpen }) => <button type="button" aria-label="Create new" aria-expanded={isOpen} className={barButton} onClick={toggle}><Icon name="plus" /></button>}
            />
          </div>
          <Bell unread={unread} />
          <UserMenu user={user} signOut={signOut} />
        </div>
      </header>
      {app && <AreaBar app={app} />}
      <main className="flex-1 overflow-y-auto pb-20 md:pb-6">
        <div className="mx-auto max-w-[1500px] p-3 md:p-5"><Outlet /></div>
      </main>
      <BottomBar onSearch={() => setIsSearching(true)} createItemsList={creatable} unread={unread} />
      {isSearching && <CommandSearch apps={apps} onClose={() => setIsSearching(false)} />}
    </div>
  );
}
