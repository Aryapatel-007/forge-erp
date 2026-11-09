// The drawing vault: every CAD file, with pictures, versions and release control.
// Like git, nothing moves by itself: people pull (download) and push (send a new version
// with a message). The maintainer decides who may pull and push where, and gives tasks.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { del, downloadBlob, fetchBlob, get, patch, post, queryString, sendRaw } from '../api/client.js';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table, TextArea } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatDateTime } from '../utils/format.js';
import { ActionDialog } from './generic/ActionDialog.jsx';
import { ROLE_KEYS, roleLabel } from '../config/roles.js';

const STATE = {
  WIP: { label: 'Being worked on', tone: 'neutral' },
  REVIEW: { label: 'In review', tone: 'warn' },
  RELEASED: { label: 'Released', tone: 'ok' },
  OBSOLETE: { label: 'Obsolete', tone: 'danger' },
};
const KIND = {
  PART: { label: 'SOLIDWORKS part', short: 'PART', tint: '#b4541a' },
  ASSEMBLY: { label: 'SOLIDWORKS assembly', short: 'ASM', tint: '#5b4fa8' },
  DRAWING: { label: 'SOLIDWORKS drawing', short: 'DRW', tint: '#0f6e8c' },
  DWG: { label: 'AutoCAD drawing', short: 'DWG', tint: '#a13a5c' },
  DXF: { label: 'AutoCAD DXF', short: 'DXF', tint: '#a13a5c' },
  PDF: { label: 'PDF', short: 'PDF', tint: '#b42318' },
  MODEL: { label: '3D model (STEP, IGES…)', short: '3D', tint: '#2c7a4b' },
  IMAGE: { label: 'Picture', short: 'IMG', tint: '#8a6d1b' },
  OTHER: { label: 'Other', short: 'FILE', tint: '#5f6b7a' },
};
const FILTERS = [
  { key: '', label: 'All' },
  { key: 'CAD', label: 'SOLIDWORKS' },
  { key: 'AUTOCAD', label: 'AutoCAD' },
  { key: 'PDF', label: 'PDF' },
  { key: 'MODEL', label: '3D models' },
];
const SOURCE = { WATCH: 'Imported from a folder', AGENT: 'Pushed from a PC', UPLOAD: 'Pushed from the browser' };

// The version each file was last pulled at in this browser, so a push can say what it changed.
const PULLED_KEY = 'vault-pulled';
const pulledVersions = () => {
  try { return JSON.parse(localStorage.getItem(PULLED_KEY) || '{}'); } catch { return {}; }
};
export function rememberPull(fileId, version) {
  try { localStorage.setItem(PULLED_KEY, JSON.stringify({ ...pulledVersions(), [fileId]: version })); } catch { /* not kept */ }
}
export const pulledVersion = (fileId) => pulledVersions()[fileId];

export async function pullFile(file, version) {
  await downloadBlob(`/vault/files/${file.id}/download${version ? `?version=${version}` : ''}`, version && version !== file.version ? file.name.replace(/(\.[^.]+)$/, `_v${version}$1`) : file.name);
  if (!version || version === file.version) rememberPull(file.id, file.version);
}

function accessText(summary) {
  if (summary.maintainer) return 'You are the maintainer: you can pull and push everywhere.';
  const push = summary.access.filter((g) => g.level === 'PUSH').map((g) => g.folder || 'everything');
  const pull = summary.access.filter((g) => g.level === 'PULL').map((g) => g.folder || 'everything');
  if (!push.length && !pull.length) return 'You have no access to any folder yet. The maintainer decides who can pull and push.';
  return [push.length ? `You can push to ${[...new Set(push)].join(', ')}` : '', pull.length ? `pull ${[...new Set(pull)].join(', ')}` : ''].filter(Boolean).join('; ') + '.';
}

export const formatBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const StateBadge = ({ state }) => <Badge value={STATE[state]?.label ?? state} tone={STATE[state]?.tone} />;
const Rev = ({ file }) => <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-xs text-steel">{file.revision ? `Rev ${file.revision}` : 'No rev'} · v{file.version}</span>;

// A picture from the vault, fetched with the session and freed when no longer shown.
function useBlobUrl(path, enabled) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled || !path) return undefined;
    let alive = true;
    let made = null;
    setFailed(false);
    fetchBlob(path)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [path, enabled]);
  return { url, failed };
}

function KindTile({ kind, large }) {
  const k = KIND[kind] ?? KIND.OTHER;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1" style={{ background: `${k.tint}12` }}>
      <span className={`rounded-md px-2 py-1 font-mono font-bold text-white ${large ? 'text-lg' : 'text-xs'}`} style={{ background: k.tint }}>{k.short}</span>
      {large && <span className="text-xs text-steel">{k.label}</span>}
    </div>
  );
}

function Thumb({ file, version, large = false }) {
  const path = `/vault/files/${file.id}/preview${version ? `?version=${version}` : ''}`;
  const { url, failed } = useBlobUrl(path, file.hasPreview || Boolean(version));
  if (!url || failed) return <KindTile kind={file.kind} large={large} />;
  return <img src={url} alt={`Picture of ${file.name}`} className="h-full w-full bg-white object-contain" />;
}

// ---------- The vault ----------
export function VaultPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('vault-view') || 'grid'; } catch { return 'grid'; }
  });
  const [uploading, setUploading] = useState(null);
  const tab = params.get('tab') ?? 'files';
  const [dragging, setDragging] = useState(false);
  const [limitPages, setLimitPages] = useState(1);
  const filters = { q: params.get('q') ?? '', kind: params.get('kind') ?? '', state: params.get('state') ?? '', folder: params.get('folder') ?? '', mine: params.get('mine') === 'true' ? 'true' : '' };
  const setFilter = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
    setLimitPages(1);
  };
  const [search, setSearch] = useState(filters.q);
  useEffect(() => {
    const t = setTimeout(() => search !== filters.q && setFilter('q', search), 300);
    return () => clearTimeout(t);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useQuery({ queryKey: ['vault', 'summary'], queryFn: () => get('/vault/summary') });
  const folders = useQuery({ queryKey: ['vault', 'folders'], queryFn: () => get('/vault/folders') });
  const pages = useQuery({
    queryKey: ['vault', 'files', filters, limitPages],
    queryFn: async () => {
      const all = [];
      let total = 0;
      for (let page = 1; page <= limitPages; page += 1) {
        const data = await get(`/vault/files${queryString({ ...filters, page })}`);
        all.push(...data.rows);
        total = data.total;
      }
      return { rows: all, total };
    },
    placeholderData: (previous) => previous,
  });

  const chooseView = (v) => {
    setView(v);
    try { localStorage.setItem('vault-view', v); } catch { /* not kept */ }
  };
  const onDrop = (event) => {
    event.preventDefault();
    setDragging(false);
    if (can('vault.write') && event.dataTransfer.files.length) setUploading([...event.dataTransfer.files]);
  };

  const s = summary.data;
  return (
    <div
      onDragOver={(e) => { if (can('vault.write')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={onDrop}
      className="relative"
    >
      <PageHeader
        title="Drawing vault"
        subtitle={s ? `${s.total} files · ${s.states.RELEASED ?? 0} released · ${s.states.REVIEW ?? 0} in review${s.mine ? ` · ${s.mine} locked by you` : ''}` : 'Every drawing and model, every version'}
        actions={(
          <div className="flex gap-2">
            {can('vault.admin') && <Link to="/vault/admin"><Button><Icon name="gear" size={16} />Access and set-up</Button></Link>}
            {can('vault.write') && <UploadButton onFiles={setUploading} />}
          </div>
        )}
      />
      {s && <p className="-mt-2 mb-3 text-sm text-steel">{accessText(s)}</p>}
      <div className="mb-3 flex gap-1 border-b border-line" role="tablist">
        {[['files', 'Files'], ['pushes', 'Pushes'], ['tasks', `Tasks${s?.openTasks ? ` (${s.openTasks})` : ''}`]].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setFilter('tab', key === 'files' ? '' : key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-accent font-semibold text-accent' : 'border-transparent text-steel hover:text-ink'}`}>{label}</button>
        ))}
      </div>
      {tab === 'pushes' && <PushHistory />}
      {tab === 'tasks' && <TaskList />}
      {tab === 'files' && (<>

      {s?.blocked > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
          <Icon name="alert" size={18} />
          <span>{s.blocked} released {s.blocked === 1 ? 'file was' : 'files were'} saved again after release. The vault kept the released copy. Open the file and start a new revision if the change is wanted.</span>
        </div>
      )}
      {s && s.total === 0 && <HowItWorks admin={can('vault.admin')} />}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-60">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-steel"><Icon name="search" size={16} /></span>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by number, name, folder or item" className="pl-9" aria-label="Search the vault" />
        </div>
        <Select value={filters.state} onChange={(e) => setFilter('state', e.target.value)} className="w-auto" aria-label="State">
          <option value="">Any state</option>
          {Object.entries(STATE).map(([key, v]) => <option key={key} value={key}>{v.label}</option>)}
        </Select>
        <div className="flex rounded-lg border border-line-strong p-0.5" role="group" aria-label="View">
          {[['grid', 'grid'], ['list', 'list']].map(([v, icon]) => (
            <button key={v} type="button" onClick={() => chooseView(v)} aria-pressed={view === v} className={`rounded-md px-2 py-1 ${view === v ? 'bg-accent-soft text-accent' : 'text-steel'}`} aria-label={`${v} view`}>
              <Icon name={icon} size={16} />
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.key || 'all'} type="button" onClick={() => setFilter('kind', f.key)} aria-pressed={filters.kind === f.key}
            className={`rounded-full border px-3 py-1 text-sm ${filters.kind === f.key ? 'border-accent bg-accent text-white' : 'border-line-strong bg-card text-ink hover:bg-paper'}`}>
            {f.label}
          </button>
        ))}
        {can('vault.write') && (
          <button type="button" onClick={() => setFilter('mine', filters.mine ? '' : 'true')} aria-pressed={Boolean(filters.mine)}
            className={`rounded-full border px-3 py-1 text-sm ${filters.mine ? 'border-accent bg-accent text-white' : 'border-line-strong bg-card text-ink hover:bg-paper'}`}>
            Locked by me
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
        <FolderTree folders={folders.data ?? []} current={filters.folder} onPick={(f) => setFilter('folder', f)} />
        <div className="min-w-0">
          {pages.isLoading && <Spinner />}
          <ErrorBox error={pages.error} />
          {pages.data && pages.data.rows.length === 0 && <Card><Empty>{filters.q || filters.kind || filters.state || filters.folder || filters.mine ? 'No files match.' : 'The vault is empty.'}</Empty></Card>}
          {pages.data && pages.data.rows.length > 0 && (view === 'grid' ? <FileGrid rows={pages.data.rows} /> : <FileList rows={pages.data.rows} />)}
          {pages.data && pages.data.rows.length < pages.data.total && (
            <div className="mt-3 text-center"><Button onClick={() => setLimitPages((n) => n + 1)}>Show more ({pages.data.total - pages.data.rows.length} left)</Button></div>
          )}
        </div>
      </div>
      </>)}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-card px-8 py-6 text-center text-accent shadow-xl">
            <Icon name="upload" size={28} />
            <p className="mt-2 font-semibold">Drop to push to {filters.folder || 'the vault'}</p>
          </div>
        </div>
      )}
      {uploading && <UploadDialog files={uploading} folder={filters.folder} onClose={() => setUploading(null)} />}
    </div>
  );
}

function UploadButton({ onFiles }) {
  const input = useRef(null);
  return (
    <>
      <input ref={input} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files.length) onFiles([...e.target.files]); e.target.value = ''; }} />
      <Button variant="primary" onClick={() => input.current.click()}><Icon name="upload" size={16} />Push files</Button>
    </>
  );
}

function FolderTree({ folders, current, onPick }) {
  // Every folder and the folders above it, so the tree has its branches even when empty.
  const all = useMemo(() => {
    const counts = new Map();
    for (const { folder, count } of folders) {
      const parts = folder ? folder.split('/') : [];
      for (let i = 1; i <= parts.length; i += 1) {
        const key = parts.slice(0, i).join('/');
        counts.set(key, (counts.get(key) ?? 0) + count);
      }
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, count]) => ({ folder, count, depth: folder.split('/').length - 1, name: folder.split('/').pop() }));
  }, [folders]);
  const total = folders.reduce((sum, f) => sum + f.count, 0);
  const row = (key, label, count, depth, active) => (
    <button key={key || 'root'} type="button" onClick={() => onPick(key)} aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm ${active ? 'bg-accent-soft font-medium text-accent' : 'text-ink hover:bg-paper'}`}
      style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}>
      <Icon name="folder" size={15} className="shrink-0 text-steel" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs text-steel">{count}</span>
    </button>
  );
  return (
    <>
      <div className="md:hidden">
        <Select value={current} onChange={(e) => onPick(e.target.value)} aria-label="Folder">
          <option value="">All folders ({total})</option>
          {all.map((f) => <option key={f.folder} value={f.folder}>{`${'– '.repeat(f.depth)}${f.name} (${f.count})`}</option>)}
        </Select>
      </div>
      <nav aria-label="Folders" className="hidden max-h-[70vh] overflow-auto rounded-xl border border-line bg-card p-2 md:block">
        {row('', 'All folders', total, 0, !current)}
        {all.map((f) => row(f.folder, f.name, f.count, f.depth + 1, current === f.folder))}
      </nav>
    </>
  );
}

function FileGrid({ rows }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {rows.map((file) => (
        <li key={file.id}>
          <Link to={`/vault/${file.id}`} className="group block overflow-hidden rounded-xl border border-line bg-card transition-shadow hover:shadow-md">
            <div className="relative aspect-[4/3] border-b border-line">
              <Thumb file={file} />
              {file.checkedOut?.byId && <span className="absolute right-1.5 top-1.5 rounded-full bg-warn px-2 py-0.5 text-[11px] font-medium text-white" title={`Checked out by ${file.checkedOut.byName}`}>{file.checkedOut.byName.split(' ')[0]}</span>}
              {file.blockedChange?.at && <span className="absolute left-1.5 top-1.5 rounded-full bg-danger px-2 py-0.5 text-[11px] font-medium text-white">Changed after release</span>}
            </div>
            <div className="space-y-1 p-2.5">
              <p className="truncate text-sm font-semibold group-hover:text-accent" title={file.name}>{file.name}</p>
              <p className="truncate text-xs text-steel" title={file.folder}>{file.title || file.folder || 'Top level'}</p>
              <div className="flex flex-wrap items-center gap-1"><StateBadge state={file.state} /><Rev file={file} /></div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function FileList({ rows }) {
  const navigate = useNavigate();
  return (
    <Card>
      <Table
        rows={rows}
        onRowClick={(row) => navigate(`/vault/${row.id}`)}
        columns={[
          { key: 'name', label: 'File', render: (f) => <span className="font-medium">{f.name}{f.checkedOut?.byId && <span className="ml-1 text-xs text-warn">· {f.checkedOut.byName}</span>}</span> },
          { key: 'folder', label: 'Folder' },
          { key: 'kind', label: 'Type', render: (f) => KIND[f.kind]?.short ?? f.kind },
          { key: 'state', label: 'State', render: (f) => <StateBadge state={f.state} /> },
          { key: 'revision', label: 'Rev', render: (f) => f.revision || '–' },
          { key: 'version', label: 'Ver', align: 'right' },
          { key: 'lastChangedAt', label: 'Changed', render: (f) => formatDateTime(f.lastChangedAt) },
        ]}
      />
    </Card>
  );
}

// Push: a message, then each file with the version it was changed from. A file someone
// else pushed after your pull is refused, and you pull before trying again.
export function UploadDialog({ files, folder, onClose, known = null }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState(folder);
  const [message, setMessage] = useState('');
  const [fromLatest, setFromLatest] = useState(false);
  const [unlock, setUnlock] = useState(true);
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(false);
  const done = Object.keys(results).length === files.length && Object.values(results).every((r) => r.ok);
  const start = async () => {
    setBusy(true);
    setResults({});
    try {
      const { pushId } = await post('/vault/pushes', { message });
      for (const file of files) {
        const path = known ? known.path : [target.trim().replace(/^\/+|\/+$/g, ''), file.name].filter(Boolean).join('/');
        try {
          // Is it already in the vault? Then say which version this change started from.
          let existing = known;
          if (!existing) {
            const found = await get(`/vault/files${queryString({ q: file.name, folder: target.trim() })}`);
            existing = found.rows.find((row) => row.path.toLowerCase() === path.toLowerCase()) ?? null;
          }
          let base;
          if (existing) {
            base = pulledVersion(existing.id) ?? (fromLatest ? existing.version : undefined);
            if (base === undefined) {
              setResults((r) => ({ ...r, [file.name]: { ok: false, text: `Already in the vault at version ${existing.version}, and not pulled in this browser. Pull it first, or tick "changes to the latest versions".` } }));
              continue;
            }
          }
          const data = await sendRaw(`/vault/push${queryString({ pushId, path, base, unlock: unlock ? 'true' : undefined })}`, file);
          rememberPull(data.file.id, data.file.version);
          setResults((r) => ({ ...r, [file.name]: { ok: true, text: { ADDED: 'Added as version 1', CHANGED: `Pushed as version ${data.file.version}`, UNCHANGED: 'Same as the vault copy, nothing to push' }[data.status], id: data.file.id } }));
        } catch (error) {
          setResults((r) => ({ ...r, [file.name]: { ok: false, text: error.message } }));
        }
      }
    } catch (error) {
      setResults(Object.fromEntries(files.map((f) => [f.name, { ok: false, text: error.message }])));
    }
    setBusy(false);
    queryClient.invalidateQueries({ queryKey: ['vault'] });
  };
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" role="dialog" aria-modal="true" aria-label="Push to the vault">
      <div className="max-h-[90vh] w-full overflow-auto rounded-t-2xl bg-card p-4 shadow-xl md:max-w-lg md:rounded-2xl">
        <h2 className="text-base font-semibold">Push {files.length} {files.length === 1 ? 'file' : 'files'}</h2>
        <p className="mt-1 text-sm text-steel">Each file becomes the next version of the file with the same name in that folder. If someone pushed after you pulled, it is turned away so nothing is overwritten.</p>
        <div className="mt-3 space-y-3">
          <Field label="What changed" hint="Everyone sees this in the push history, like a commit message.">
            <TextArea value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy || done} placeholder="Hole pitch changed to 75 mm for the 4-head manifold" />
          </Field>
          {!known && (
            <Field label="Folder in the vault" hint="For example Projects/FM-60. Leave empty for the top level.">
              <Input value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy || done} />
            </Field>
          )}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={fromLatest} onChange={(e) => setFromLatest(e.target.checked)} disabled={busy || done} />These are changes to the latest versions in the vault (for files not pulled in this browser)</label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={unlock} onChange={(e) => setUnlock(e.target.checked)} disabled={busy || done} />Unlock files I had locked, after pushing</label>
          <ul className="divide-y divide-line rounded-lg border border-line text-sm">
            {files.map((file) => {
              const r = results[file.name];
              return (
                <li key={file.name} className="flex items-start gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{file.name}</span>
                    <span className={`block text-xs ${r ? (r.ok ? 'text-ok' : 'text-danger') : 'text-steel'}`}>{r ? r.text : `${formatBytes(file.size)}${busy ? ' · waiting' : ''}`}</span>
                  </span>
                  {r?.id && <Link to={`/vault/${r.id}`} onClick={onClose} className="text-xs text-accent underline">Open</Link>}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && <Button variant="primary" onClick={start} disabled={busy || !message.trim()}>{busy ? 'Pushing…' : 'Push'}</Button>}
        </div>
      </div>
    </div>
  );
}

function PushHistory() {
  const query = useQuery({ queryKey: ['vault', 'pushes'], queryFn: () => get('/vault/pushes') });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  if (query.data.length === 0) return <Card><Empty>No pushes yet.</Empty></Card>;
  return (
    <Card>
      <ol className="divide-y divide-line">
        {query.data.map((push) => (
          <li key={push.id} className="px-4 py-3 text-sm">
            <p className="font-medium">{push.message}</p>
            <p className="text-xs text-steel">{push.byName} · {formatDateTime(push.createdAt)} · from the {push.via === 'PC' ? 'PC' : 'browser'}</p>
            <ul className="mt-1 space-y-0.5">
              {push.files.map((f) => (
                <li key={`${f.fileId}-${f.version}`} className="text-xs">
                  <Link to={`/vault/${f.fileId}`} className="text-accent underline">{f.path}</Link>
                  <span className="text-steel"> · {f.status === 'ADDED' ? 'added' : f.status === 'UNCHANGED' ? 'no change' : `version ${f.version}`}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const TASK_STATE = { OPEN: ['Open', 'info'], SUBMITTED: ['Handed in', 'warn'], DONE: ['Done', 'ok'], CANCELLED: ['Cancelled', 'neutral'] };

function TaskList() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['vault', 'tasks'], queryFn: () => get('/vault/tasks') });
  const move = useMutation({
    mutationFn: ({ id, status, answer }) => patch(`/vault/tasks/${id}`, { status, ...(answer ? { answer } : {}) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['vault'] }),
  });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  if (query.data.length === 0) return <Card><Empty>No vault tasks for you. The maintainer gives tasks that let you push to a folder for a while.</Empty></Card>;
  const maintainer = user.role === 'ADMIN';
  return (
    <Card>
      <ErrorBox error={move.error} />
      <ul className="divide-y divide-line">
        {query.data.map((t) => (
          <li key={t.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{t.title}</span>
              <Badge value={TASK_STATE[t.status][0]} tone={TASK_STATE[t.status][1]} />
            </div>
            <p className="text-xs text-steel">{maintainer ? `${t.assigneeName} · ` : ''}{t.dueDate ? `Due ${t.dueDate} · ` : ''}May push to: {t.paths.join(', ')}</p>
            {t.note && <p>{t.note}</p>}
            {t.answer && <p className="text-xs text-steel">Answer: {t.answer}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {t.status === 'OPEN' && String(t.assigneeId) === String(user.id) && <Button onClick={() => { const answer = window.prompt('Anything to tell the maintainer? (optional)') ?? null; if (answer !== null) move.mutate({ id: t.id, status: 'SUBMITTED', answer }); }}>Hand in</Button>}
              {maintainer && t.status === 'SUBMITTED' && <Button variant="primary" onClick={() => move.mutate({ id: t.id, status: 'DONE' })}>Accept as done</Button>}
              {maintainer && (t.status === 'SUBMITTED' || t.status === 'DONE' || t.status === 'CANCELLED') && <Button onClick={() => move.mutate({ id: t.id, status: 'OPEN' })}>Reopen</Button>}
              {maintainer && t.status !== 'CANCELLED' && t.status !== 'DONE' && <Button variant="danger" onClick={() => move.mutate({ id: t.id, status: 'CANCELLED' })}>Cancel</Button>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function HowItWorks({ admin }) {
  return (
    <Card className="mb-4">
      <div className="grid gap-4 p-4 text-sm md:grid-cols-3">
        {[
          ['folder', 'Pull and push, like git', 'Pull to get files, push to send your changes with a message. If someone pushed after your pull, Forge says so instead of overwriting.'],
          ['clock', 'Every push is kept', 'Each push makes a new version. Old versions can always be pulled. Nothing is ever deleted.'],
          ['shield', 'Released means locked', 'After review a file is released as revision A, B, C. Released files become read-only, and the item in Forge shows the revision.'],
        ].map(([icon, title, text]) => (
          <div key={title} className="flex gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent"><Icon name={icon} size={18} /></span>
            <div><p className="font-semibold">{title}</p><p className="mt-0.5 text-steel">{text}</p></div>
          </div>
        ))}
      </div>
      {admin && <p className="border-t border-line px-4 py-2.5 text-sm">Start in <Link to="/vault/admin" className="text-accent underline">Access and set-up</Link>: decide who can pull and push, then make the Forge Vault file for each designer's PC.</p>}
    </Card>
  );
}

// ---------- One file ----------
const ACTIONS = {
  lock: { label: 'Lock', hint: 'Tells everyone you are changing this file, and stops others pushing it.' },
  unlock: { label: 'Unlock' },
  submit: { label: 'Send for review', note: 'Note for the reviewer (optional)' },
  release: { label: 'Approve and release', note: 'Release note (optional)', hint: 'The file gets its next revision letter and becomes read-only.' },
  reject: { label: 'Send back', note: 'What needs changing', required: true, tone: 'danger' },
  'new-revision': { label: 'Start new revision', note: 'Reason, such as the change note number (optional)', hint: 'The file can be changed again. The released revision stays in the history.' },
  obsolete: { label: 'Make obsolete', note: 'Why it is no longer used', required: true, tone: 'danger' },
};

export function VaultFilePage() {
  const { id } = useParams();
  const { can, user } = useAuth();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [shown, setShown] = useState(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const pushInput = useRef(null);
  const [pushing, setPushing] = useState(null);
  const detail = useQuery({ queryKey: ['vault', 'file', id], queryFn: () => get(`/vault/files/${id}`) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['vault'] });
  const act = useMutation({
    mutationFn: ({ action, body }) => post(`/vault/files/${id}/${action}`, body),
    onSuccess: () => { setDialog(null); refresh(); },
  });
  const saveTitle = useMutation({
    mutationFn: () => patch(`/vault/files/${id}`, { title }),
    onSuccess: () => { setEditing(false); refresh(); },
  });

  if (detail.isLoading) return <Spinner />;
  if (detail.error) return <ErrorBox error={detail.error} />;
  const { file, versions, usedIn, family, level } = detail.data;
  const pulled = pulledVersion(file.id);
  const mineOut = file.checkedOut?.byId && String(file.checkedOut.byId) === String(user.id);
  const othersOut = file.checkedOut?.byId && !mineOut;
  const write = can('vault.write');
  const release = can('vault.release');
  const canPush = write && level === 'PUSH';
  const available = [
    canPush && file.state === 'WIP' && !file.checkedOut?.byId && 'lock',
    write && file.checkedOut?.byId && (mineOut || can('vault.admin')) && 'unlock',
    canPush && file.state === 'WIP' && !othersOut && file.version > 0 && 'submit',
    release && file.state === 'REVIEW' && 'release',
    release && file.state === 'REVIEW' && 'reject',
    release && file.state === 'RELEASED' && 'new-revision',
    release && file.state !== 'OBSOLETE' && 'obsolete',
  ].filter(Boolean);
  const run = (action) => (ACTIONS[action].note ? setDialog(action) : act.mutate({ action, body: {} }));
  const showing = shown ?? file.version;

  return (
    <>
      <PageHeader
        back={{ to: `/vault${file.folder ? queryString({ folder: file.folder }) : ''}`, label: file.folder || 'Drawing vault' }}
        title={file.name}
        subtitle={file.title || KIND[file.kind]?.label}
        actions={(
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => pullFile(file).then(refresh)}><Icon name="download" size={16} />Pull</Button>
            {canPush && file.state === 'WIP' && !othersOut && (
              <>
                <input ref={pushInput} type="file" className="hidden" onChange={(e) => { if (e.target.files[0]) setPushing([e.target.files[0]]); e.target.value = ''; }} />
                <Button onClick={() => pushInput.current.click()}><Icon name="upload" size={16} />Push a new version</Button>
              </>
            )}
          </div>
        )}
      />
      <p className="-mt-2 mb-3 text-sm text-steel">
        {level === 'PUSH' ? 'You can pull and push this file.' : 'You can pull this file. The maintainer decides who can push.'}
        {pulled ? ` You last pulled version ${pulled} here${pulled < file.version ? `; version ${file.version} is newer, pull again before changing it` : ''}.` : ''}
      </p>

      {file.blockedChange?.at && (
        <div className="mb-3 rounded-xl border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          This file was saved again on {formatDateTime(file.blockedChange.at)}{file.blockedChange.byName ? ` (${file.blockedChange.byName})` : ''}, after it was {file.state.toLowerCase()}. The vault kept the {file.state.toLowerCase()} copy. {file.state === 'RELEASED' && release ? 'Start a new revision to accept the change.' : ''}
        </div>
      )}
      {othersOut && <div className="mb-3 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">{file.checkedOut.byName} is changing this file (locked {formatDateTime(file.checkedOut.at)}). Nobody else can push it until it is unlocked.</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card>
            <div className="aspect-[4/3] overflow-hidden rounded-t-xl">
              <Thumb key={showing} file={file} version={shown} large />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-steel">
              <span>{shown && shown !== file.version ? `Showing version ${shown}` : 'Latest version'}{!file.hasPreview && !shown ? ' · no picture inside this file. Download it to open in SOLIDWORKS, AutoCAD or eDrawings.' : ''}</span>
              {shown && shown !== file.version && <button type="button" className="text-accent underline" onClick={() => setShown(null)}>Back to latest</button>}
            </div>
          </Card>

          {available.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {available.map((action) => (
                <Button key={action} variant={action === 'release' ? 'primary' : ACTIONS[action].tone === 'danger' ? 'danger' : 'default'} onClick={() => run(action)} disabled={act.isPending}>
                  {ACTIONS[action].label}
                </Button>
              ))}
            </div>
          )}
          <ErrorBox error={act.error} />

          <Card title={`Versions (${versions.length})`}>
            <Table
              rows={versions}
              columns={[
                { key: 'version', label: 'Ver', render: (v) => <span className="font-mono">v{v.version}</span> },
                { key: 'revision', label: 'Rev', render: (v) => (v.revision ? <Badge value={`Rev ${v.revision}`} tone="ok" /> : '–') },
                { key: 'createdAt', label: 'Saved', render: (v) => formatDateTime(v.createdAt) },
                { key: 'byName', label: 'By', render: (v) => <span>{v.byName || '–'}<span className="block text-xs text-steel">{SOURCE[v.source]}</span></span> },
                { key: 'note', label: 'Note' },
                { key: 'sizeBytes', label: 'Size', align: 'right', render: (v) => formatBytes(v.sizeBytes) },
                {
                  key: 'actions', label: '', render: (v) => (
                    <span className="flex justify-end gap-2 whitespace-nowrap">
                      {v.previewGridId && <button type="button" className="text-xs text-accent underline" onClick={() => setShown(v.version)}>Picture</button>}
                      <button type="button" className="text-xs text-accent underline" onClick={() => pullFile(file, v.version)}>Pull</button>
                    </span>
                  ),
                },
              ]}
            />
          </Card>

          <Card title="History">
            <ol className="divide-y divide-line">
              {[...file.history].reverse().map((h, i) => (
                <li key={i} className="px-4 py-2 text-sm">
                  <span className="font-medium">{h.action}</span>
                  <span className="text-steel"> · {h.byName || 'Forge'} · {formatDateTime(h.at)}</span>
                  {h.note && <p className="text-steel">{h.note}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="About this file">
            <dl className="divide-y divide-line text-sm">
              {[
                ['State', <StateBadge key="s" state={file.state} />],
                ['Revision', file.revision || 'Not released yet'],
                ['Version', file.version],
                ['Drawing number', file.number],
                ['Item', file.itemId ? <Link key="i" className="text-accent underline" to={`/items/${file.itemId}`}>{file.itemCode}</Link> : <span key="i" className="text-steel">No item has this drawing number</span>],
                ['Type', KIND[file.kind]?.label],
                ['Size', formatBytes(file.sizeBytes)],
                ['Folder', file.folder || 'Top level'],
                ['Last saved', `${formatDateTime(file.lastChangedAt)}${file.lastChangedBy ? ` by ${file.lastChangedBy}` : ''}`],
                ...(file.diskPath ? [['On the drive', <span key="d" className="break-all">{file.diskPath}{file.missingOnDisk && <span className="block text-warn">No longer in that folder. The vault still has every version.</span>}</span>]] : []),
              ].map(([label, value]) => (
                <div key={label} className="flex gap-3 px-4 py-2">
                  <dt className="w-28 shrink-0 text-steel">{label}</dt>
                  <dd className="min-w-0 flex-1">{value}</dd>
                </div>
              ))}
              <div className="flex gap-3 px-4 py-2">
                <dt className="w-28 shrink-0 text-steel">Description</dt>
                <dd className="min-w-0 flex-1">
                  {editing ? (
                    <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); saveTitle.mutate(); }}>
                      <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
                      <Button type="submit" variant="primary" disabled={saveTitle.isPending}>Save</Button>
                    </form>
                  ) : (
                    <span>{file.title || <span className="text-steel">None</span>} {write && <button type="button" className="ml-1 text-xs text-accent underline" onClick={() => { setTitle(file.title); setEditing(true); }}>Edit</button>}</span>
                  )}
                </dd>
              </div>
            </dl>
          </Card>

          {family.length > 0 && (
            <Card title="Same drawing number">
              <ul className="divide-y divide-line text-sm">
                {family.map((f) => (
                  <li key={f.id}><Link to={`/vault/${f.id}`} className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-paper"><span className="truncate">{f.name}</span><StateBadge state={f.state} /></Link></li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Used in bills of material">
            {usedIn.length === 0 ? <Empty>No bill of material lists drawing {file.number}.</Empty> : (
              <ul className="divide-y divide-line text-sm">
                {usedIn.map((b) => (
                  <li key={b.id}><Link to={`/boms/${b.id}`} className="flex items-center justify-between gap-2 px-4 py-2 hover:bg-paper"><span className="truncate">{b.itemCode} {b.itemName} · rev {b.revision}</span><Badge value={b.status} /></Link></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {pushing && <UploadDialog files={pushing} folder={file.folder} known={{ id: file.id, path: file.path, version: file.version }} onClose={() => { setPushing(null); refresh(); }} />}
      {dialog && (
        <ActionDialog
          title={ACTIONS[dialog].label}
          hint={ACTIONS[dialog].hint}
          fields={[{ key: 'note', label: ACTIONS[dialog].note, type: 'textarea', required: Boolean(ACTIONS[dialog].required) }]}
          confirmLabel={ACTIONS[dialog].label}
          tone={ACTIONS[dialog].tone === 'danger' ? 'danger' : 'primary'}
          onConfirm={(values) => act.mutate({ action: dialog, body: { note: values.note ?? '' } })}
          onClose={() => { setDialog(null); act.reset(); }}
          error={act.error}
          isPending={act.isPending}
        />
      )}
    </>
  );
}

// ---------- The maintainer's page ----------
const LEVEL = { PULL: 'Pull only', PUSH: 'Pull and push' };

export function VaultAdminPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'access';
  if (!can('vault.admin')) return <ErrorBox error={{ message: 'Only the maintainer manages vault access.' }} />;
  const tabs = [['access', 'Who can pull and push'], ['tasks', 'Tasks'], ['pcs', "Designers' PCs"], ['import', 'Import from a folder']];
  return (
    <>
      <PageHeader back={{ to: '/vault', label: 'Drawing vault' }} title="Vault access and set-up" subtitle="You decide who may pull (see and download) and who may push (send new versions), folder by folder." />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-line" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setParams(key === 'access' ? {} : { tab: key }, { replace: true })}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-accent font-semibold text-accent' : 'border-transparent text-steel hover:text-ink'}`}>{label}</button>
        ))}
      </div>
      {tab === 'access' && <AccessRules />}
      {tab === 'tasks' && <TaskAdmin />}
      {tab === 'pcs' && <DesignerPcs />}
      {tab === 'import' && <ImportFolders />}
    </>
  );
}

const usePeople = () => useQuery({ queryKey: ['vault', 'people'], queryFn: () => get('/vault/people') });

function FolderPicker({ value, onChange, placeholder = 'Whole vault' }) {
  const folders = useQuery({ queryKey: ['vault', 'folders'], queryFn: () => get('/vault/folders') });
  const all = [...new Set((folders.data ?? []).flatMap(({ folder }) => folder.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'))).filter(Boolean))].sort();
  return (
    <>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} list="vault-folders" />
      <datalist id="vault-folders">{all.map((f) => <option key={f} value={f} />)}</datalist>
    </>
  );
}

function AccessRules() {
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['vault', 'rules'], queryFn: () => get('/vault/rules') });
  const people = usePeople();
  const [form, setForm] = useState({ who: 'role:ENGINEERING', folder: '', level: 'PUSH' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['vault'] });
  const add = useMutation({
    mutationFn: () => {
      const [kind, value] = form.who.split(':');
      return post('/vault/rules', { ...(kind === 'role' ? { role: value } : { userId: value }), folder: form.folder.trim(), level: form.level });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id) => del(`/vault/rules/${id}`), onSuccess: refresh });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card title="Rules">
        {rules.isLoading && <Spinner />}
        {rules.data?.length === 0 && <Empty>No rules yet, so only you can see the vault. Add one for each team.</Empty>}
        <ul className="divide-y divide-line">
          {(rules.data ?? []).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.userName || `Everyone in ${roleLabel(r.role)}`}</span>
                <span className="text-steel"> · {r.folder || 'the whole vault'}</span>
              </span>
              <Badge value={LEVEL[r.level]} tone={r.level === 'PUSH' ? 'ok' : 'info'} />
              <Button variant="ghost" onClick={() => remove.mutate(r.id)} aria-label="Remove rule"><Icon name="close" size={16} /></Button>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-4 py-2 text-xs text-steel">A rule for a folder covers everything inside it. A person gets the most a rule or an open task gives them. You, the maintainer, can always pull and push.</p>
      </Card>
      <Card title="Add a rule">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Who">
            <Select value={form.who} onChange={(e) => setForm({ ...form, who: e.target.value })}>
              <optgroup label="A whole role">
                {ROLE_KEYS.filter((r) => r !== 'ADMIN' && r !== 'PORTAL').map((r) => <option key={r} value={`role:${r}`}>Everyone in {roleLabel(r)}</option>)}
              </optgroup>
              <optgroup label="One person">
                {(people.data ?? []).map((p) => <option key={p.id} value={`user:${p.id}`}>{p.name} ({roleLabel(p.role)})</option>)}
              </optgroup>
            </Select>
          </Field>
          <Field label="Folder" hint="Empty means the whole vault"><FolderPicker value={form.folder} onChange={(folder) => setForm({ ...form, folder })} /></Field>
          <Field label="May">
            <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
              <option value="PULL">Pull only: see and download</option>
              <option value="PUSH">Pull and push: also send new versions and lock</option>
            </Select>
          </Field>
          <ErrorBox error={add.error ?? remove.error} />
          <Button type="submit" variant="primary" disabled={add.isPending}>Add rule</Button>
        </form>
      </Card>
    </div>
  );
}

function TaskAdmin() {
  const queryClient = useQueryClient();
  const people = usePeople();
  const [form, setForm] = useState({ title: '', note: '', assigneeId: '', paths: '', dueDate: '' });
  const add = useMutation({
    mutationFn: () => post('/vault/tasks', { title: form.title, note: form.note, assigneeId: form.assigneeId, paths: form.paths.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean), dueDate: form.dueDate }),
    onSuccess: () => { setForm({ title: '', note: '', assigneeId: '', paths: '', dueDate: '' }); queryClient.invalidateQueries({ queryKey: ['vault'] }); },
  });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <TaskList />
      <Card title="Give a task">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="What to do"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="Update LF4 frame for the 3 m conveyor" /></Field>
          <Field label="To">
            <Select value={form.assigneeId} onChange={(e) => setForm({ ...form, assigneeId: e.target.value })} required>
              <option value="">Choose</option>
              {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({roleLabel(p.role)})</option>)}
            </Select>
          </Field>
          <Field label="Folders or files they may push to" hint="One per line. Their push right ends when they hand the task in."><TextArea value={form.paths} onChange={(e) => setForm({ ...form, paths: e.target.value })} required placeholder="Projects/NKP-LF4/Frame" /></Field>
          <Field label="Due"><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
          <Field label="Notes"><TextArea value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <ErrorBox error={add.error} />
          <Button type="submit" variant="primary" disabled={add.isPending}>Give task</Button>
        </form>
      </Card>
    </div>
  );
}

function DesignerPcs() {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ['vault', 'agents'], queryFn: () => get('/vault/agents') });
  const people = usePeople();
  const [form, setForm] = useState({ name: '', userId: '', pcFolder: 'C:\\Forge Vault', vaultFolder: '' });
  const [made, setMade] = useState(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['vault'] });
  const addAgent = useMutation({
    mutationFn: () => post('/vault/agents', { ...form, serverUrl: window.location.origin }),
    onSuccess: (data) => {
      const fileName = `Forge-Vault-${data.agent.name.replace(/[^\w-]+/g, '-')}.ps1`;
      // Windows PowerShell 5 reads a script without a byte-order mark as the local code page.
      const url = URL.createObjectURL(new Blob(['\ufeff', data.script.replace(/\r?\n/g, '\r\n')], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMade({ name: data.agent.name, fileName, folder: form.pcFolder, person: data.agent.userName });
      setForm({ ...form, name: '', userId: '' });
      refresh();
    },
  });
  const toggleAgent = useMutation({ mutationFn: (a) => patch(`/vault/agents/${a.id}`, { isActive: !a.isActive }), onSuccess: refresh });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card title="Designers' PCs">
        <p className="px-4 pt-3 text-sm text-steel">
          Each designer gets a <b>Forge Vault</b> folder at the top of File Explorer, the way a PDM vault shows, so it is in SOLIDWORKS and AutoCAD Open and Save windows.
          Nothing moves by itself: they <b>Pull</b> to get files and <b>Push</b> to send changes, from the right-click menu, the tray icon or the Forge tab in SOLIDWORKS.
          A PC works as its person: it pulls and pushes only where you allowed that person.
        </p>
        <ol className="mx-4 mt-2 list-decimal space-y-1 pl-5 text-sm text-steel">
          <li>Make the PC's file here. Copy it to that PC, right-click it, then choose <b>Run with PowerShell</b>.</li>
          <li>For badges on files and the <b>Forge tab in SOLIDWORKS</b>, also run the PC kit there: unzip it, double-click Install.cmd.</li>
        </ol>
        <div className="mx-4 mt-2"><Button onClick={() => downloadBlob('/vault/pc-kit', 'ForgeVault-PC-Kit.zip')}><Icon name="download" size={16} />Download the PC kit</Button></div>
        {made && (
          <div className="mx-4 mt-3 rounded-lg border border-ok/40 bg-ok-soft px-3 py-2 text-sm text-ok">
            <b>{made.fileName}</b> has downloaded. It holds this PC's key, shown only once. Put it on {made.name} and run it there. {made.person} will find Forge Vault at <code>{made.folder}</code>.
          </div>
        )}
        <ul className="mt-2 divide-y divide-line">
          {(agents.data ?? []).map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span className="font-semibold">{a.name}</span>{!a.isActive && <span className="ml-1 text-xs text-danger">(switched off)</span>}
                <span className="block text-xs text-steel">{a.userName || 'No person'} · {a.lastSeenAt ? `last heard from ${formatDateTime(a.lastSeenAt)}` : 'not heard from yet'} · {a.filesSent} pushed · key …{a.keyHint}</span>
              </span>
              <Button variant={a.isActive ? 'danger' : 'default'} onClick={() => toggleAgent.mutate(a)}>{a.isActive ? 'Switch off' : 'Switch on'}</Button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Add a PC">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); addAgent.mutate(); }}>
          <Field label="Name of the PC"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="Ravi's PC" /></Field>
          <Field label="Who uses it" hint="It pulls and pushes as this person, with their access">
            <Select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
              <option value="">Choose</option>
              {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} ({roleLabel(p.role)})</option>)}
            </Select>
          </Field>
          <Field label="Forge Vault folder on that PC" hint="Made if it does not exist"><Input value={form.pcFolder} onChange={(e) => setForm({ ...form, pcFolder: e.target.value })} required /></Field>
          <Field label="Only this part of the vault" hint="Leave empty for everything the person may pull"><FolderPicker value={form.vaultFolder} onChange={(vaultFolder) => setForm({ ...form, vaultFolder })} placeholder="Everything they may pull" /></Field>
          <ErrorBox error={addAgent.error ?? toggleAgent.error} />
          <Button type="submit" variant="primary" disabled={addAgent.isPending}><Icon name="download" size={16} />Make the PC's file</Button>
        </form>
      </Card>
    </div>
  );
}

function ImportFolders() {
  const queryClient = useQueryClient();
  const watches = useQuery({ queryKey: ['vault', 'watches'], queryFn: () => get('/vault/watches') });
  const [form, setForm] = useState({ name: 'Old design drive', dir: '', vaultFolder: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['vault'] });
  const add = useMutation({ mutationFn: () => post('/vault/watches', form), onSuccess: () => { setForm({ name: '', dir: '', vaultFolder: '' }); refresh(); } });
  const scan = useMutation({ mutationFn: (id) => post(`/vault/watches/${id}/scan`), onSuccess: refresh });
  const change = useMutation({ mutationFn: ({ id, body }) => patch(`/vault/watches/${id}`, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id) => del(`/vault/watches/${id}`), onSuccess: refresh });
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card title="Folders on the server">
        <p className="px-4 pt-3 text-sm text-steel">For bringing existing drawings in, such as an old design drive. Press <b>Read now</b> to import: new files are added, changed ones become new versions. Nothing is read by itself unless you switch on <b>every minute</b>.</p>
        <ul className="divide-y divide-line">
          {(watches.data ?? []).map((w) => (
            <li key={w.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{w.name}</span>
                <span className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={() => scan.mutate(w.id)} disabled={scan.isPending}>{scan.isPending && scan.variables === w.id ? 'Reading…' : 'Read now'}</Button>
                  <Button onClick={() => change.mutate({ id: w.id, body: { auto: !w.auto } })}>{w.auto ? 'Stop reading every minute' : 'Read every minute'}</Button>
                  <Button variant="danger" onClick={() => window.confirm(`Forget ${w.dir}? Files already in the vault stay.`) && remove.mutate(w.id)}>Remove</Button>
                </span>
              </div>
              <p className="break-all font-mono text-xs">{w.dir}{w.vaultFolder ? `  →  ${w.vaultFolder}/` : ''}</p>
              <p className="text-xs text-steel">
                {w.auto ? 'Read every minute. ' : ''}{w.lastScanAt ? `Last read ${formatDateTime(w.lastScanAt)}: ${w.lastResult.added} new, ${w.lastResult.changed} changed, ${w.lastResult.unchanged} unchanged${w.lastResult.blocked ? `, ${w.lastResult.blocked} turned away (released)` : ''}` : 'Not read yet'}
              </p>
              {w.lastResult?.errors?.map((e) => <p key={e} className="text-xs text-danger">{e}</p>)}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Add a folder">
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field>
          <Field label="Folder on the server"><Input value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })} required placeholder="D:\CAD" /></Field>
          <Field label="Into this vault folder" hint="Optional, such as Projects"><Input value={form.vaultFolder} onChange={(e) => setForm({ ...form, vaultFolder: e.target.value })} /></Field>
          <ErrorBox error={add.error ?? scan.error ?? remove.error ?? change.error} />
          <Button type="submit" variant="primary" disabled={add.isPending}>Add folder</Button>
        </form>
      </Card>
    </div>
  );
}
