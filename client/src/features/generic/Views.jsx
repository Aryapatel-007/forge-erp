// Other ways to look at a list. Each works for any document type that has the fields for it,
// so a new type gets them without writing a screen.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getList, post, queryString } from '../../api/client.js';
import { Icon } from '../../components/icons.jsx';
import { Badge, Button, Card, ErrorBox, Select, Spinner } from '../../components/ui.jsx';
import { formatDate, humanise, todayIso } from '../../utils/format.js';

const FETCH_LIMIT = 200;

const useRows = (config, key, params = {}) => useQuery({
  queryKey: ['view-rows', config.name, key, params],
  queryFn: () => getList(`${config.endpoint}${queryString({ ...params, limit: FETCH_LIMIT })}`),
});

const titleOf = (config, row) => config.titleOf?.(row) ?? row.docNo ?? row.id;
const dateFields = (meta) => meta.fields.filter((f) => f.type === 'date');

const CapNote = ({ total }) => (total > FETCH_LIMIT ? <p className="px-4 py-2 text-xs text-warn">Showing the latest {FETCH_LIMIT} of {total}. Use the list to reach the rest.</p> : null);

export function availableViews(meta) {
  if (!meta) return [];
  const views = [];
  const selects = meta.fields.filter((f) => f.type === 'select');
  if (selects.length > 0 || meta.submittable) views.push(['kanban', 'Board']);
  if (meta.dateField || dateFields(meta).length > 0) views.push(['calendar', 'Calendar']);
  if (meta.parentKey) views.push(['tree', 'Tree']);
  if (dateFields(meta).length >= 2) views.push(['gantt', 'Timeline']);
  return views;
}

const VIEW_ICONS = { list: 'list', kanban: 'board', calendar: 'calendar', tree: 'tree', gantt: 'timeline' };

export function ViewSwitch({ meta, view, onChange }) {
  const views = availableViews(meta);
  if (views.length === 0) return null;
  return (
    <div className="inline-flex rounded-lg border border-line-strong bg-card p-0.5" role="group" aria-label="View">
      {[['list', 'List'], ...views].map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-pressed={view === key}
          className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-sm ${view === key ? 'bg-accent-soft font-medium text-accent' : 'text-steel hover:text-ink'}`}
          onClick={() => onChange(key)}
        >
          <Icon name={VIEW_ICONS[key]} size={15} />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Board ---------- */

export function KanbanView({ config, meta, resource, canWrite }) {
  const queryClient = useQueryClient();
  const options = meta.fields.filter((f) => f.type === 'select');
  const initial = options.find((f) => ['state', 'status', 'stage'].includes(f.key)) ?? options[0];
  const [fieldKey, setFieldKey] = useState(initial?.key ?? 'status');
  const field = options.find((f) => f.key === fieldKey);
  const columns = field ? field.options : ['DRAFT', 'SUBMITTED', 'CANCELLED'];
  const rows = useRows(config, 'kanban');
  const move = useMutation({
    mutationFn: ({ id, value }) => (config.move ? config.move(id, value) : post(`${config.endpoint}/${id}/set`, { field: fieldKey, value })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['view-rows', config.name] }),
  });
  const canMove = canWrite && field && !field.computed;
  const sourceColumn = (row) => row[fieldKey] ?? columns[0];
  const others = config.columns.filter((c) => c.key !== 'docNo' && c.key !== fieldKey && c.key !== 'status').slice(0, 2);

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 text-sm">
        <label htmlFor="board-by">Group by</label>
        <Select id="board-by" className="w-auto" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
          {options.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          {options.length === 0 && <option value="status">Status</option>}
        </Select>
        {field?.computed && <span className="text-xs text-steel">This one changes by the document's own actions.</span>}
      </div>
      {rows.isLoading && <Spinner />}
      <div className="p-3"><ErrorBox error={rows.error ?? move.error} /></div>
      <div className="flex gap-3 overflow-x-auto px-3 pb-3">
        {columns.map((column) => {
          const here = (rows.data?.data ?? []).filter((row) => sourceColumn(row) === column);
          return (
            <section
              key={column}
              aria-label={humanise(column)}
              className="w-64 shrink-0 rounded-lg bg-paper p-2"
              onDragOver={(e) => { if (canMove) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain'); if (canMove && id) move.mutate({ id, value: column }); }}
            >
              <h3 className="mb-2 flex justify-between px-1 text-xs font-semibold text-steel"><span>{humanise(column)}</span><span>{here.length}</span></h3>
              <ul className="space-y-2">
                {here.map((row) => (
                  <li key={row.id} draggable={canMove} onDragStart={(e) => e.dataTransfer.setData('text/plain', row.id)} className="rounded border border-line bg-card p-2 text-sm">
                    <Link to={`/${resource}/${row.id}`} className="font-medium underline-offset-2 hover:underline">{titleOf(config, row)}</Link>
                    {others.map((c) => <div key={c.key} className="truncate text-xs text-steel">{c.render ? c.render(row) : row[c.key]}</div>)}
                    {meta.submittable && fieldKey !== 'status' && <div className="mt-1"><Badge value={row.status} /></div>}
                    {canMove && (
                      <Select aria-label={`Move ${titleOf(config, row)}`} className="mt-2 text-xs" value={column} disabled={move.isPending} onChange={(e) => move.mutate({ id: row.id, value: e.target.value })}>
                        {columns.map((c) => <option key={c} value={c}>{humanise(c)}</option>)}
                      </Select>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <CapNote total={rows.data?.meta?.total ?? 0} />
    </Card>
  );
}

/* ---------- Calendar ---------- */

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');

function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  return { offset, days: Array.from({ length: days }, (_, i) => `${year}-${pad(month + 1)}-${pad(i + 1)}`) };
}

export function CalendarView({ config, meta, resource }) {
  const candidates = [...(meta.submittable ? [{ key: 'postingDate', label: 'Date' }] : []), ...dateFields(meta)];
  const [fieldKey, setFieldKey] = useState(meta.dateField ?? candidates[0]?.key);
  const today = todayIso();
  const [cursor, setCursor] = useState({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 });
  const { offset, days } = monthGrid(cursor.year, cursor.month);
  // The server can only narrow by its main date, so any other date is filtered here.
  const params = fieldKey === meta.dateField ? { from: days[0], to: days.at(-1) } : {};
  const rows = useRows(config, `calendar-${fieldKey}`, params);
  const shift = (by) => setCursor(({ year, month }) => {
    const next = new Date(Date.UTC(year, month + by, 1));
    return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
  });
  const dayOf = (row) => String(row[fieldKey] ?? '').slice(0, 10);
  const title = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(cursor.year, cursor.month, 1)));

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 text-sm">
        <Button onClick={() => shift(-1)}>Previous</Button>
        <strong className="min-w-36 text-center">{title}</strong>
        <Button onClick={() => shift(1)}>Next</Button>
        {candidates.length > 1 && (
          <Select aria-label="Which date" className="w-auto" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
            {candidates.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </Select>
        )}
      </div>
      {rows.isLoading && <Spinner />}
      <div className="p-3"><ErrorBox error={rows.error} /></div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[640px] grid-cols-7 border-l border-t border-line text-xs">
          {WEEK.map((d) => <div key={d} className="border-b border-r border-line bg-paper p-1 font-semibold">{d}</div>)}
          {Array.from({ length: offset }, (_, i) => <div key={`blank-${i}`} className="border-b border-r border-line" />)}
          {days.map((day) => (
            <div key={day} className={`min-h-20 border-b border-r border-line p-1 ${day === today ? 'bg-accent-soft' : ''}`}>
              <div className="text-steel">{Number(day.slice(8))}</div>
              {(rows.data?.data ?? []).filter((row) => dayOf(row) === day).map((row) => (
                <Link key={row.id} to={`/${resource}/${row.id}`} className="mt-0.5 block truncate rounded bg-paper px-1 hover:underline">{titleOf(config, row)}</Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <CapNote total={rows.data?.meta?.total ?? 0} />
    </Card>
  );
}

/* ---------- Tree ---------- */

function TreeBranch({ node, childrenOf, resource, config, depth }) {
  const kids = childrenOf.get(node.id) ?? [];
  const [isOpen, setIsOpen] = useState(depth < 1);
  return (
    <li>
      <div className="flex items-center gap-1 border-b border-line py-1.5 text-sm" style={{ paddingLeft: `${depth * 18 + 8}px` }}>
        {kids.length > 0
          ? <button type="button" className="w-5 text-steel" aria-expanded={isOpen} aria-label={isOpen ? 'Collapse' : 'Expand'} onClick={() => setIsOpen(!isOpen)}>{isOpen ? '−' : '+'}</button>
          : <span className="w-5" />}
        <Link to={`/${resource}/${node.id}`} className="hover:underline">{titleOf(config, node)}</Link>
        {kids.length > 0 && <span className="text-xs text-steel">({kids.length})</span>}
      </div>
      {isOpen && kids.length > 0 && (
        <ul>{kids.map((kid) => <TreeBranch key={kid.id} node={kid} childrenOf={childrenOf} resource={resource} config={config} depth={depth + 1} />)}</ul>
      )}
    </li>
  );
}

export function TreeView({ config, meta, resource }) {
  const rows = useRows(config, 'tree', { sort: meta.labelFields?.[0], dir: 'asc' });
  const all = rows.data?.data ?? [];
  const ids = new Set(all.map((r) => r.id));
  const childrenOf = new Map();
  const roots = [];
  for (const row of all) {
    const parent = row[meta.parentKey];
    // A parent that was not fetched should not hide its children.
    if (parent && ids.has(String(parent))) {
      if (!childrenOf.has(String(parent))) childrenOf.set(String(parent), []);
      childrenOf.get(String(parent)).push(row);
    } else roots.push(row);
  }
  return (
    <Card>
      {rows.isLoading && <Spinner />}
      <div className="p-3 empty:hidden"><ErrorBox error={rows.error} /></div>
      {rows.data && all.length === 0 && <p className="p-4 text-sm text-steel">Nothing here yet.</p>}
      <ul>{roots.map((node) => <TreeBranch key={node.id} node={node} childrenOf={childrenOf} resource={resource} config={config} depth={0} />)}</ul>
      <CapNote total={rows.data?.meta?.total ?? 0} />
    </Card>
  );
}

/* ---------- Timeline ---------- */

const dayNumber = (date) => Math.floor(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86400000);
const startLike = /start|from|begin/i;
const endLike = /end|to$|toDate|due|target|until|finish/i;

function DatesEditor({ row, starts, ends, onSave, onClose, isPending }) {
  const [from, setFrom] = useState(row[starts.key] ?? '');
  const [to, setTo] = useState(row[ends.key] ?? '');
  const isBackwards = from && to && to < from;
  return (
    <form className="mt-1 flex flex-wrap items-end gap-2 rounded bg-paper p-2" onSubmit={(e) => { e.preventDefault(); if (!isBackwards) onSave(from, to); }}>
      {!starts.computed && <label className="text-xs">{starts.label}<input type="date" className="ml-1 rounded border border-line bg-card px-1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>}
      {!ends.computed && <label className="text-xs">{ends.label}<input type="date" className="ml-1 rounded border border-line bg-card px-1" value={to} onChange={(e) => setTo(e.target.value)} /></label>}
      {isBackwards && <span className="text-xs text-danger">It ends before it starts.</span>}
      <Button type="submit" variant="primary" disabled={isPending || isBackwards}>Save</Button>
      <Button onClick={onClose}>Close</Button>
    </form>
  );
}

export function GanttView({ config, meta, resource, canWrite }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const fields = dateFields(meta);
  const [startKey, setStartKey] = useState((fields.find((f) => startLike.test(f.key)) ?? fields[0])?.key);
  const [endKey, setEndKey] = useState((fields.find((f) => endLike.test(f.key) && f.key !== startKey) ?? fields[1])?.key);
  const navigate = useNavigate();
  const rows = useRows(config, 'gantt');
  const dated = (rows.data?.data ?? [])
    .map((row) => ({ row, start: row[startKey] ?? row[endKey], end: row[endKey] ?? row[startKey] }))
    .filter((r) => r.start && r.end)
    .sort((a, b) => a.start.localeCompare(b.start));
  const today = todayIso();
  const first = dated.length ? Math.min(...dated.map((r) => dayNumber(r.start))) : 0;
  const last = dated.length ? Math.max(...dated.map((r) => dayNumber(r.end))) : 0;
  const span = Math.max(1, last - first + 1);
  const percent = (day) => ((day - first) / span) * 100;
  const todayAt = percent(dayNumber(today));
  const progressKey = meta.fields.find((f) => /percent|progress/i.test(f.key))?.key;
  const undated = (rows.data?.data ?? []).length - dated.length;
  const starts = fields.find((f) => f.key === startKey);
  const ends = fields.find((f) => f.key === endKey);
  // Core documents have their own rules about dates, so only engine documents move here.
  const canMove = canWrite && config.isEngine && !meta.submittable && !(starts?.computed && ends?.computed);
  const saveDates = useMutation({
    mutationFn: async ({ id, row, from, to }) => {
      if (!starts.computed && from && from !== row[startKey]) await post(`${config.endpoint}/${id}/set`, { field: startKey, value: from });
      if (!ends.computed && to && to !== row[endKey]) await post(`${config.endpoint}/${id}/set`, { field: endKey, value: to });
    },
    onSuccess: () => { setEditing(null); queryClient.invalidateQueries({ queryKey: ['view-rows', config.name] }); },
  });

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 text-sm">
        <Select aria-label="Starts" className="w-auto" value={startKey} onChange={(e) => setStartKey(e.target.value)}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
        <span>to</span>
        <Select aria-label="Ends" className="w-auto" value={endKey} onChange={(e) => setEndKey(e.target.value)}>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</Select>
      </div>
      {rows.isLoading && <Spinner />}
      <div className="p-3 empty:hidden"><ErrorBox error={rows.error ?? saveDates.error} /></div>
      {rows.data && dated.length === 0 && <p className="p-4 text-sm text-steel">Nothing here has these dates yet.</p>}
      <div className="overflow-x-auto">
        <div className="min-w-[640px] p-3">
          {dated.length > 0 && <div className="mb-2 flex justify-between text-xs text-steel"><span>{formatDate(dated[0].start)}</span><span>{span} days</span></div>}
          <ul className="space-y-1">
            {dated.map(({ row, start, end }) => {
              const left = percent(dayNumber(start));
              const width = Math.max(1, ((dayNumber(end) - dayNumber(start) + 1) / span) * 100);
              const done = progressKey ? Math.min(100, (row[progressKey] ?? 0) / (meta.fields.find((f) => f.key === progressKey).type === 'pct' ? 100 : 1)) : 0;
              return (
                <li key={row.id} className="text-xs">
                  <div className="flex items-center gap-2">
                  <button type="button" className="w-40 shrink-0 truncate text-left hover:underline" onClick={() => navigate(`/${resource}/${row.id}`)}>{titleOf(config, row)}</button>
                  <div className="relative h-5 flex-1 rounded bg-paper">
                    {todayAt >= 0 && todayAt <= 100 && <div className="absolute inset-y-0 z-10 w-px bg-danger" style={{ left: `${todayAt}%` }} />}
                    <div
                      className="absolute inset-y-0.5 overflow-hidden rounded bg-accent-soft"
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${formatDate(start)} to ${formatDate(end)}`}
                    >
                      <div className="h-full bg-accent" style={{ width: `${done}%` }} />
                    </div>
                  </div>
                  {canMove && <button type="button" className="shrink-0 text-steel underline" onClick={() => setEditing(editing === row.id ? null : row.id)}>Dates</button>}
                  </div>
                  {editing === row.id && <DatesEditor row={row} starts={starts} ends={ends} isPending={saveDates.isPending} onClose={() => setEditing(null)} onSave={(from, to) => saveDates.mutate({ id: row.id, row, from, to })} />}
                </li>
              );
            })}
          </ul>
          {undated > 0 && <p className="mt-2 text-xs text-steel">{undated} without these dates are not shown.</p>}
        </div>
      </div>
      <CapNote total={rows.data?.meta?.total ?? 0} />
    </Card>
  );
}

