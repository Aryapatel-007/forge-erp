// Every machine order's journey through the company, the way pharma machine builders run
// orders: order and kick-off, design approved by the customer, materials, build, FAT,
// dispatch, and installation with SAT and IQ/OQ. Each step belongs to a department.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { get, post } from '../api/client.js';
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Spinner, Stat, useToast } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';
import { useAuth } from '../context/Auth.jsx';
import { DEPARTMENTS } from '../config/departments.js';
import { roleLabel } from '../config/roles.js';
import { formatDate } from '../utils/format.js';

const OVERSEERS = new Set(['ADMIN', 'MANAGEMENT', 'PROJECTS']);
const PHASE_STYLE = {
  DONE: 'bg-ok text-white border-ok',
  ACTIVE: 'bg-accent-soft text-accent border-accent',
  LATE: 'bg-danger-soft text-danger border-danger',
  WAITING: 'bg-paper text-steel border-line',
};
const deptTint = (role) => DEPARTMENTS[role]?.tint ?? '#5f6b7a';
const deptName = (role) => DEPARTMENTS[role]?.title ?? roleLabel(role);

export function DeptChip({ role }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line px-2 py-0.5 text-xs">
      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: deptTint(role) }} />
      {deptName(role)}
    </span>
  );
}

// The seven phases as a strip: done, in hand, late or waiting.
export function PhaseStrip({ phases, compact = false }) {
  return (
    <ol className="flex w-full gap-1" aria-label="Phases">
      {phases.map((p) => (
        <li key={p.key} title={`${p.label}: ${p.done} of ${p.total} done`}
          className={`min-w-0 flex-1 rounded-md border text-center ${PHASE_STYLE[p.state]} ${compact ? 'h-2' : 'px-1 py-1 text-[11px] font-medium'}`}>
          {!compact && <span className="block truncate">{p.label}</span>}
          <span className="sr-only">{p.label}: {p.state.toLowerCase()}</span>
        </li>
      ))}
    </ol>
  );
}

const Bar = ({ value, max, tone }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-paper">
    <div className={`h-full rounded-full ${tone}`} style={{ width: `${max ? Math.round((value / max) * 100) : 0}%` }} />
  </div>
);

/* ---------- The board ---------- */

export function OrdersBoard() {
  const [closed, setClosed] = useState(false);
  const [q, setQ] = useState('');
  const [show, setShow] = useState('all');
  const query = useQuery({ queryKey: ['journey', 'board', closed], queryFn: () => get(`/journey/board${closed ? '?closed=true' : ''}`), refetchInterval: 60000 });
  const all = query.data ?? [];
  const rows = all
    .filter((j) => !q || `${j.build.serialNo} ${j.build.partyName} ${j.build.itemName} ${j.build.salesOrderNo}`.toLowerCase().includes(q.toLowerCase()))
    .filter((j) => (show === 'late' ? j.late > 0 : show === 'ok' ? j.late === 0 : true));
  const late = all.filter((j) => j.late > 0).length;
  const dueSoon = all.reduce((n, j) => n + j.steps.filter((s) => s.status === 'DUE').length, 0);
  const finished = all.filter((j) => j.done === j.total).length;
  return (
    <>
      <PageHeader title="Orders" subtitle="Every machine order from order to handover: where it is, who has it now, what is late." />
      {query.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Orders shown" value={all.length} />
          <Stat label="With late steps" value={late} tone={late ? 'danger' : undefined} />
          <Stat label="Steps due this week" value={dueSoon} tone={dueSoon ? 'warn' : undefined} />
          <Stat label="Finished" value={finished} />
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an order, customer or machine" className="max-w-sm" aria-label="Find" />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
          {[['all', 'All'], ['late', `Late${late ? ` (${late})` : ''}`], ['ok', 'On track']].map(([key, label]) => (
            <button key={key} type="button" aria-pressed={show === key} onClick={() => setShow(key)}
              className={`rounded-full border px-3 py-1 text-sm ${show === key ? 'border-accent bg-accent text-white' : 'border-line-strong bg-card text-ink hover:bg-paper'}`}>{label}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />Show finished orders</label>
      </div>
      {query.isLoading && <Spinner />}
      <ErrorBox error={query.error} />
      {query.data && rows.length === 0 && <Card><Empty>{all.length ? 'No orders match.' : 'No machine orders in progress.'}</Empty></Card>}
      <div className="space-y-3">
        {rows.map((j) => (
          <Link key={j.build.id} to={`/orders/${j.build.id}`} className="block rounded-xl border border-line bg-card p-4 transition-shadow hover:shadow-md">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{j.build.partyName || 'Stock machine'} <span className="font-normal text-steel">· {j.build.itemName}</span></p>
                <p className="text-xs text-steel">{j.build.serialNo}{j.build.salesOrderNo ? ` · order ${j.build.salesOrderNo}` : ''}{j.build.targetDate ? ` · dispatch by ${formatDate(j.build.targetDate)}` : ''}</p>
              </div>
              <div className="flex items-center gap-3">
                {j.late > 0 && <Badge value={`${j.late} late`} tone="danger" />}
                <div className="w-24 text-right">
                  <span className="num text-sm font-semibold">{Math.round((j.done / j.total) * 100)}%</span>
                  <span className="ml-1 text-xs text-steel">{j.done}/{j.total}</span>
                  <div className="mt-1"><Bar value={j.done} max={j.total} tone={j.late ? 'bg-danger' : 'bg-accent'} /></div>
                </div>
              </div>
            </div>
            <div className="mt-3"><PhaseStrip phases={j.phases} /></div>
            {j.current && (
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-steel">Now:</span>
                <span className="font-medium">{j.current.title}</span>
                <DeptChip role={j.current.role} />
                <span className={`text-xs ${j.current.status === 'LATE' ? 'text-danger' : 'text-steel'}`}>{j.current.status === 'LATE' ? `${j.current.lateDays} days late` : `planned ${formatDate(j.current.plannedDate)}`}</span>
              </p>
            )}
          </Link>
        ))}
      </div>
    </>
  );
}

/* ---------- One order ---------- */

export function JourneyPage() {
  const { buildId } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [unfolded, setUnfolded] = useState({});
  const query = useQuery({ queryKey: ['journey', buildId], queryFn: () => get(`/journey/${buildId}`) });
  const act = useMutation({
    mutationFn: ({ key, action }) => post(`/journey/${buildId}/steps/${key}`, { action, ...(note ? { note } : {}), ...(action === 'plan' ? { plannedDate: date } : {}) }),
    onSuccess: (data, vars) => {
      queryClient.setQueryData(['journey', buildId], data);
      queryClient.invalidateQueries({ queryKey: ['journey', 'board'] });
      queryClient.invalidateQueries({ queryKey: ['journey', 'mine'] });
      setOpen(null); setNote(''); setDate('');
      toast({ done: 'Step done', undo: 'Step reopened', skip: 'Marked not needed', plan: 'Date moved' }[vars.action]);
    },
  });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  const j = query.data;
  const mayAct = (step) => step.role === user.role || OVERSEERS.has(user.role);
  const pct = Math.round((j.done / j.total) * 100);

  return (
    <>
      <PageHeader
        back={{ to: '/orders', label: 'Orders' }}
        title={`${j.build.partyName || 'Stock machine'} · ${j.build.itemName}`}
        subtitle={`${j.build.serialNo}${j.build.salesOrderNo ? ` · order ${j.build.salesOrderNo}` : ''} · started ${formatDate(j.startedOn)}${j.build.targetDate ? ` · dispatch by ${formatDate(j.build.targetDate)}` : ''}`}
        actions={(
          <div className="flex gap-2">
            <Link to={`/builds/${j.build.id}`}><Button>The machine</Button></Link>
            {j.build.salesOrderId && <Link to={`/salesOrders/${j.build.salesOrderId}`}><Button>The order</Button></Link>}
          </div>
        )}
      />
      <Card className="mb-4">
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span><b className="num text-lg">{pct}%</b> <span className="text-steel">· {j.done} of {j.total} steps done</span>{j.late ? <span className="text-danger"> · {j.late} late</span> : <span className="text-ok"> · on track</span>}</span>
            {j.current && <span className="flex flex-wrap items-center gap-2">Next: <b>{j.current.title}</b><DeptChip role={j.current.role} /></span>}
          </div>
          <Bar value={j.done} max={j.total} tone={j.late ? 'bg-danger' : 'bg-accent'} />
          <PhaseStrip phases={j.phases} />
        </div>
      </Card>

      <div className="space-y-4">
        {j.phases.map((phase) => {
          const folded = phase.state === 'DONE' && !unfolded[phase.key];
          return (
            <Card
              key={phase.key}
              title={`${phase.label} · ${phase.done}/${phase.total}${phase.state === 'DONE' ? ' · done' : ''}`}
              actions={phase.state === 'DONE' ? <button type="button" className="text-xs text-accent underline" onClick={() => setUnfolded({ ...unfolded, [phase.key]: !unfolded[phase.key] })}>{folded ? 'Show steps' : 'Hide steps'}</button> : null}
            >
              {!folded && (
                <ol className="divide-y divide-line">
                  {j.steps.filter((s) => s.phase === phase.key).map((s) => {
                    const done = s.status === 'DONE' || s.status === 'SKIPPED';
                    return (
                      <li key={s.key} className="px-4 py-3">
                        <div className="flex flex-wrap items-start gap-3">
                          <span aria-hidden="true" className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${s.status === 'DONE' ? 'border-ok bg-ok text-white' : s.status === 'LATE' ? 'border-danger text-danger' : s.status === 'SKIPPED' ? 'border-line text-steel' : 'border-line-strong'}`}>
                            {s.status === 'DONE' && <Icon name="check" size={14} />}
                            {s.status === 'LATE' && <Icon name="alert" size={13} />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className={`text-sm font-medium ${s.status === 'SKIPPED' ? 'text-steel line-through' : ''}`}>{s.title}</p>
                            <p className="text-xs text-steel">{s.hint}</p>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                              <DeptChip role={s.role} />
                              {done
                                ? <span className="text-steel">{s.status === 'DONE' ? `Done ${formatDate(s.doneOn)} by ${s.doneByName}` : `Not needed: ${s.note}`}</span>
                                : <span className={s.status === 'LATE' ? 'text-danger' : 'text-steel'}>Planned {formatDate(s.plannedDate)}{s.lateDays ? `, ${s.lateDays} days late` : ''}</span>}
                              {!done && s.canAuto && <span className="text-steel">· ticks itself when recorded in Forge</span>}
                              {s.note && s.status === 'DONE' && <span className="text-steel">· {s.note}</span>}
                            </div>
                          </div>
                          {mayAct(s) && (
                            <div className="flex flex-wrap gap-2">
                              {!done && <Button variant="primary" onClick={() => setOpen(open === s.key ? null : s.key)}>Mark done</Button>}
                              {done && !s.auto && <Button variant="ghost" onClick={() => act.mutate({ key: s.key, action: 'undo' })}>Undo</Button>}
                              {!done && <Button variant="ghost" onClick={() => setOpen(open === `more:${s.key}` ? null : `more:${s.key}`)} aria-label="More"><Icon name="more" size={16} /></Button>}
                            </div>
                          )}
                        </div>
                        {open === s.key && (
                          <form className="ml-9 mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ key: s.key, action: 'done' }); }}>
                            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. GA rev 1 approved by Dr. Mehta" className="min-w-0 flex-1" autoFocus />
                            <Button type="submit" variant="primary" disabled={act.isPending}>Done</Button>
                          </form>
                        )}
                        {open === `more:${s.key}` && (
                          <div className="ml-9 mt-2 space-y-2">
                            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ key: s.key, action: 'plan' }); }}>
                              <span className="text-sm">Move planned date to</span>
                              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-auto" required />
                              <Button type="submit" disabled={act.isPending}>Move</Button>
                            </form>
                            <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); act.mutate({ key: s.key, action: 'skip' }); }}>
                              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why it does not apply to this order" className="min-w-0 flex-1" required />
                              <Button type="submit" disabled={act.isPending}>Not needed</Button>
                            </form>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </Card>
          );
        })}
      </div>
      <ErrorBox error={act.error} />
    </>
  );
}

/* ---------- On each department's home page, and in My work ---------- */

export function WaitingOnDepartment({ title = 'Order steps waiting on you' }) {
  const { can } = useAuth();
  const query = useQuery({ queryKey: ['journey', 'mine'], queryFn: () => get('/journey/mine'), enabled: can('builds.read'), refetchInterval: 120000 });
  if (!can('builds.read')) return null;
  const rows = query.data ?? [];
  return (
    <Card title={title} actions={<Link to="/orders" className="text-xs text-accent underline">All orders</Link>}>
      {query.isLoading && <Spinner />}
      {query.data && rows.length === 0 && <Empty>No order steps due for you in the next two weeks.</Empty>}
      <ul className="divide-y divide-line">
        {rows.slice(0, 8).map((s) => (
          <li key={`${s.build.id}-${s.key}`}>
            <Link to={`/orders/${s.build.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-paper">
              <span className={`w-20 shrink-0 text-xs ${s.status === 'LATE' ? 'font-semibold text-danger' : 'text-steel'}`}>{s.status === 'LATE' ? `${s.lateDays}d late` : formatDate(s.plannedDate)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.title}</span>
                <span className="block truncate text-xs text-steel">{s.build.partyName || 'Stock'} · {s.build.serialNo}</span>
              </span>
              <Icon name="chevronRight" size={15} className="text-steel" />
            </Link>
          </li>
        ))}
      </ul>
      {rows.length > 8 && <p className="border-t border-line px-4 py-2 text-xs text-steel">And {rows.length - 8} more.</p>}
    </Card>
  );
}
