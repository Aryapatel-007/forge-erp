// What you open to. It answers three questions, in this order: what is waiting on me, how do
// things stand, and where do I go. Everything is shaped by the role of whoever signed in.
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from 'react-router-dom';
import { buildDepartment, departmentTable, DEPARTMENTS } from '../config/departments.js';
import { useMeta } from '../context/Meta.jsx';
import { get } from '../api/client.js';
import { AppTile, useApps, useDepartment } from '../components/Shell.jsx';
import { Icon } from '../components/icons.jsx';
import { Badge, Card, Empty, ErrorBox, PageHeader, Spinner, Stat } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatDate, formatPaise, humanise } from '../utils/format.js';
import { recentPages, starredPages } from '../utils/recents.js';
import { PhaseStrip, WaitingOnDepartment } from './OrderJourney.jsx';

const STAGES = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY', 'DISPATCHED'];
const toneText = { danger: 'text-danger', warn: 'text-warn', info: 'text-accent', neutral: 'text-steel' };
const toneOrder = { danger: 0, warn: 1, info: 2, neutral: 3 };

const useHome = () => useQuery({ queryKey: ['home'], queryFn: () => get('/views/home'), refetchInterval: 60000 });

function AttentionList({ tiles, emptyText = 'Nothing is waiting. Well done.' }) {
  const rows = tiles.filter((t) => t.kind === 'attention' && t.count > 0).sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone] || b.count - a.count);
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((row) => (
        <li key={row.key}>
          <Link to={row.to} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-paper">
            <span className={`num w-8 shrink-0 text-right text-base font-semibold ${toneText[row.tone]}`}>{row.count}</span>
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.valuePaise > 0 && <span className="num hidden shrink-0 text-xs text-steel sm:inline">{formatPaise(row.valuePaise)}</span>}
            <Icon name="chevronRight" size={15} className="text-steel" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AppGrid({ apps }) {
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {apps.map((app) => (
        <li key={app.key}>
          <Link to={`/app/${app.key}`} className="flex h-full flex-col items-center gap-1.5 rounded-xl border border-line bg-card px-1 py-3 text-center text-xs font-medium hover:border-line-strong">
            <AppTile app={app} />
            {app.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function PageLinks({ title, rows }) {
  if (rows.length === 0) return null;
  return (
    <Card title={title}>
      <ul className="divide-y divide-line">
        {rows.map((row) => (
          <li key={row.to}><Link to={row.to} className="block truncate px-4 py-2 text-sm hover:bg-paper">{row.label}</Link></li>
        ))}
      </ul>
    </Card>
  );
}

function greeting(name) {
  const hour = Number(new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()));
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(/\s+/)[0]}`;
}

// The company's machine orders, each as a strip of its seven phases.
function OrdersOverview() {
  const query = useQuery({ queryKey: ['journey', 'board', false], queryFn: () => get('/journey/board'), refetchInterval: 60000 });
  const rows = query.data ?? [];
  if (query.isLoading || rows.length === 0) return null;
  const late = rows.filter((j) => j.late > 0).length;
  return (
    <Card title={`Machine orders · ${rows.length} in progress${late ? ` · ${late} late` : ''}`} actions={<Link to="/orders" className="text-xs text-accent underline">All orders</Link>}>
      <ul className="divide-y divide-line">
        {rows.slice(0, 6).map((j) => (
          <li key={j.build.id}>
            <Link to={`/orders/${j.build.id}`} className="block space-y-1.5 px-4 py-2.5 hover:bg-paper">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate"><b>{j.build.partyName || 'Stock'}</b> <span className="text-steel">· {j.build.itemName}</span></span>
                <span className={`shrink-0 text-xs ${j.late ? 'text-danger' : 'text-steel'}`}>{j.late ? `${j.late} late` : `${j.done}/${j.total}`}</span>
              </div>
              <PhaseStrip phases={j.phases} compact />
              {j.current && <p className="truncate text-xs text-steel">Now: {j.current.title}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------- A department's page ---------- */

export function DepartmentPage({ dept, preview = false }) {
  const { user } = useAuth();
  const home = useHome();
  const byKey = new Map((home.data?.tiles ?? []).map((t) => [t.key, t]));
  const tiles = dept.tiles.map((key) => byKey.get(key)).filter(Boolean);
  const waiting = tiles.filter((t) => t.kind === 'attention');
  const figures = tiles.filter((t) => t.kind === 'metric');
  return (
    <>
      <PageHeader
        title={preview ? dept.title : greeting(user.name)}
        subtitle={preview ? `What someone in ${dept.title} sees when they sign in` : `${dept.title} · ${dept.blurb}`}
        leading={<AppTile app={dept} />}
        back={preview ? { to: '/departments', label: 'All departments' } : undefined}
      />
      <ErrorBox error={home.error} />
      {dept.tasks.length > 0 && (
        <section aria-label="Do now" className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {dept.tasks.map((task) => (
            <Link key={task.to} to={task.to} className="flex items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 text-sm font-medium hover:border-accent">
              <span aria-hidden="true" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white" style={{ background: dept.tint }}><Icon name="plus" size={17} /></span>
              {task.label}
            </Link>
          ))}
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {!preview && (
            <Card title="Waiting on you">
              {home.isLoading ? <Spinner /> : <AttentionList tiles={waiting} />}
            </Card>
          )}
          {!preview && <WaitingOnDepartment />}
          {figures.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{figures.map((t) => <Stat key={t.key} label={t.label} value={t.count} to={t.to} />)}</div>}
          <div className="grid items-start gap-4 md:grid-cols-2">
            {dept.sections.map((section) => <SectionCard key={section.title} section={section} />)}
            {dept.reports.length > 0 && <SectionCard section={{ title: 'Reports', items: dept.reports }} />}
          </div>
        </div>
        {!preview && (
          <aside className="space-y-4">
            <PageLinks title="Starred" rows={starredPages()} />
            <PageLinks title="Recent" rows={recentPages().slice(0, 6)} />
          </aside>
        )}
      </div>
    </>
  );
}

// Management and Admin: every department on one page, to see who sees what.
export function DepartmentsPage() {
  const meta = useMeta();
  const rows = departmentTable(meta);
  return (
    <>
      <PageHeader title="Departments" subtitle="What each department sees in Forge. Tap one to see its page as they do." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((dept) => (
          <Card key={dept.key}>
            <Link to={`/dept/${dept.key}`} className="flex items-center gap-3 border-b border-line px-4 py-3 hover:bg-paper">
              <AppTile app={dept} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{dept.title}</span>
                <span className="block truncate text-xs text-steel">{dept.blurb}</span>
              </span>
            </Link>
            <dl className="space-y-2 px-4 py-3 text-xs">
              <div><dt className="font-semibold text-steel">Do now</dt><dd>{dept.tasks.map((t) => t.label.replace(/^New /, '')).join(', ') || 'Nothing'}</dd></div>
              {dept.sections.map((s) => <div key={s.title}><dt className="font-semibold text-steel">{s.title}</dt><dd>{s.items.map((i) => i.label).join(', ')}</dd></div>)}
              <div><dt className="font-semibold text-steel">Reports</dt><dd>{dept.reports.map((r) => r.label).join(', ')}</dd></div>
            </dl>
          </Card>
        ))}
      </div>
      <p className="mt-4 text-xs text-steel">This decides what each department is shown. What anyone may read or change is checked separately, for every request, from Settings, Role permissions.</p>
    </>
  );
}

export function DepartmentPreview() {
  const { role } = useParams();
  const meta = useMeta();
  const dept = buildDepartment(role, () => true, meta);
  if (!dept) return <Navigate to="/departments" replace />;
  return <DepartmentPage dept={dept} preview />;
}

export function HomePage() {
  const dept = useDepartment();
  if (dept) return <DepartmentPage dept={dept} />;
  return <CompanyHome />;
}

function CompanyHome() {
  const { user } = useAuth();
  const apps = useApps();
  const home = useHome();
  const d = home.data;
  const metrics = (d?.tiles ?? []).filter((t) => t.kind === 'metric');
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle={d ? formatDate(d.today) : null} />
      <ErrorBox error={home.error} />
      {home.isLoading && <Spinner />}
      {d && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-4">
            {d.money && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{d.money.map((m) => <Stat key={m.key} label={m.label} value={formatPaise(m.valuePaise)} to={m.to} />)}</div>}
            <Card title="Waiting on someone" actions={d.me.todos > 0 ? <Link to="/my-work" className="text-xs text-accent underline">{d.me.todos} assigned to you</Link> : null}>
              <AttentionList tiles={d.tiles} />
            </Card>
            <OrdersOverview />
            {d.floor && (
              <Card title="Machines on the floor" actions={<Link to="/builds?view=kanban" className="text-xs text-accent underline">Board</Link>}>
                <div className="no-scrollbar flex overflow-x-auto">
                  {STAGES.map((stage) => (
                    <Link key={stage} to={`/builds?stage=${stage}`} className="min-w-[5.5rem] flex-1 border-r border-line p-3 text-center last:border-0 hover:bg-paper">
                      <div className="num text-xl font-semibold">{d.floor.stageCounts[stage] ?? 0}</div>
                      <div className="truncate text-xs text-steel">{humanise(stage)}</div>
                    </Link>
                  ))}
                </div>
                {d.floor.builds.length > 0 && (
                  <ul className="divide-y divide-line border-t border-line">
                    {d.floor.builds.slice(0, 5).map((row) => (
                      <li key={row.id}>
                        <Link to={`/builds/${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-sm hover:bg-paper">
                          <span className="font-medium">{row.serialNo}</span>
                          <span className="min-w-0 flex-1 truncate text-steel">{row.itemName}{row.partyName ? ` · ${row.partyName}` : ''}</span>
                          <span className="text-xs text-steel">{formatDate(row.targetDate)}</span>
                          <Badge value={row.stage} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
            {metrics.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{metrics.map((t) => <Stat key={t.key} label={t.label} value={t.count} to={t.to} />)}</div>}
          </div>
          <aside className="space-y-4">
            {user.role === 'ADMIN' && (
              <Link to="/maintainer" className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-accent hover:shadow-md">
                <span className="text-sm"><b>Maintainer</b><span className="block text-xs">Accounts, features on and off, what each role sees, vault access</span></span>
              </Link>
            )}
            <Card title="Departments" actions={<Link to="/departments" className="text-xs text-accent underline">Who sees what</Link>}>
              <ul className="divide-y divide-line">
                {Object.entries(DEPARTMENTS).map(([key, d]) => (
                  <li key={key}><Link to={`/dept/${key}`} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-paper"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ background: d.tint }} />{d.title}</Link></li>
                ))}
              </ul>
            </Card>
            <PageLinks title="Starred" rows={starredPages()} />
            <PageLinks title="Recent" rows={recentPages().slice(0, 6)} />
          </aside>
        </div>
      )}
      <h2 className="mb-2 mt-6 text-sm font-semibold">All areas</h2>
      <AppGrid apps={apps} />
    </>
  );
}

export function AppsPage() {
  const apps = useApps();
  const dept = useDepartment();
  if (dept) {
    return (
      <>
        <PageHeader title={`${dept.title} menu`} />
        <div className="grid items-start gap-4 md:grid-cols-2">
          {dept.sections.map((section) => <SectionCard key={section.title} section={section} />)}
          {dept.reports.length > 0 && <SectionCard section={{ title: 'Reports', items: dept.reports }} />}
        </div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="Apps" />
      <AppGrid apps={apps} />
    </>
  );
}

/* ---------- An area's home ---------- */

function SectionCard({ section }) {
  return (
    <Card title={section.title}>
      <ul className="divide-y divide-line">
        {section.items.map((item) => (
          <li key={item.to}>
            {item.external
              ? <a href={item.to} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-paper">{item.label}<Icon name="chevronRight" size={14} className="text-steel" /></a>
              : <Link to={item.to} className="flex items-center justify-between gap-2 px-4 py-2 text-sm hover:bg-paper">{item.label}<Icon name="chevronRight" size={14} className="text-steel" /></Link>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ProcessFlow({ steps }) {
  if (steps.length < 2) return null;
  return (
    <Card title="How the work flows">
      <ol className="no-scrollbar flex items-center gap-1 overflow-x-auto p-3">
        {steps.map((step, index) => (
          <li key={step.to} className="flex shrink-0 items-center gap-1">
            {index > 0 && <Icon name="chevronRight" size={15} className="text-steel" />}
            <Link to={step.to} className="whitespace-nowrap rounded-lg border border-line px-3 py-1.5 text-sm hover:border-accent hover:text-accent">{step.label}</Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

const LinkGrid = ({ rows }) => (
  <Card>
    <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
      {rows.map((row) => (
        <li key={row.to} className="border-b border-line"><Link to={row.to} className="block px-4 py-2.5 text-sm hover:bg-paper">{row.label}</Link></li>
      ))}
    </ul>
  </Card>
);

export function AppHomePage() {
  const { app: key, tab } = useParams();
  const apps = useApps();
  const app = apps.find((row) => row.key === key);
  const home = useHome();
  if (!app) return apps.length ? <Navigate to="/apps" replace /> : <Spinner />;

  if (tab === 'reports') {
    return (
      <>
        <PageHeader title={`${app.label} reports`} back={{ to: `/app/${key}`, label: app.label }} />
        {app.reports.length ? <LinkGrid rows={app.reports} /> : <Empty>No reports here.</Empty>}
      </>
    );
  }
  if (tab === 'setup') {
    return (
      <>
        <PageHeader title={`${app.label} setup`} subtitle="Lists and rules that rarely change" back={{ to: `/app/${key}`, label: app.label }} />
        {app.setup.length ? <LinkGrid rows={app.setup} /> : <Empty>Nothing to set up here.</Empty>}
      </>
    );
  }

  const tiles = (home.data?.tiles ?? []).filter((t) => t.app === key);
  const metrics = tiles.filter((t) => t.kind === 'metric');
  const attention = tiles.filter((t) => t.kind === 'attention');
  return (
    <>
      <PageHeader title={app.label} subtitle={app.blurb} leading={<AppTile app={app} />} />
      <div className="space-y-4">
        {metrics.length > 0 && <div className="grid grid-cols-2 gap-3 md:grid-cols-4">{metrics.map((t) => <Stat key={t.key} label={t.label} value={t.count} to={t.to} />)}</div>}
        {attention.some((t) => t.count > 0) && <Card title="Waiting on someone"><AttentionList tiles={attention} /></Card>}
        <ProcessFlow steps={app.process} />
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {app.sections.map((section) => <SectionCard key={section.title} section={section} />)}
          {app.reports.length > 0 && (
            <SectionCard section={{ title: 'Top reports', items: app.reports.slice(0, 6) }} />
          )}
        </div>
      </div>
    </>
  );
}
