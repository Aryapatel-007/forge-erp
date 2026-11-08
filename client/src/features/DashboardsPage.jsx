// Dashboards anyone with access can build from number cards and charts.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { get } from '../api/client.js';
import { Button, Card, ErrorBox, PageHeader, Spinner } from '../components/ui.jsx';
import { formatPaise, formatQty } from '../utils/format.js';

const showValue = (value, format) => {
  if (format === 'MONEY') return formatPaise(value);
  if (format === 'QTY') return formatQty(value);
  return new Intl.NumberFormat('en-IN').format(value ?? 0);
};

const PALETTE = ['var(--color-accent)', 'var(--color-warn)', 'var(--color-ok)', 'var(--color-danger)', 'var(--color-steel)'];

function BarChart({ points, format }) {
  const top = Math.max(1, ...points.map((p) => Math.abs(p.value)));
  return (
    <ul className="space-y-2 p-4">
      {points.map((point) => (
        <li key={point.label} className="text-xs">
          <div className="flex justify-between gap-2"><span className="truncate">{point.label}</span><span className="num shrink-0">{showValue(point.value, format)}</span></div>
          <div className="mt-0.5 h-2.5 rounded bg-paper"><div className="h-full rounded bg-accent" style={{ width: `${(Math.abs(point.value) / top) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function LineChart({ points, format }) {
  const width = 600;
  const height = 180;
  const margin = 12;
  const top = Math.max(1, ...points.map((p) => p.value));
  const low = Math.min(0, ...points.map((p) => p.value));
  const x = (i) => margin + (i * (width - margin * 2)) / Math.max(1, points.length - 1);
  const y = (v) => height - margin - ((v - low) * (height - margin * 2)) / Math.max(1, top - low);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ');
  return (
    <div className="p-4">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`Line chart of ${points.length} points`}>
        <line x1={margin} x2={width - margin} y1={y(0)} y2={y(0)} stroke="var(--color-line)" />
        <path d={path} fill="none" stroke="var(--color-accent)" strokeWidth="2" />
        {points.map((p, i) => <circle key={p.label} cx={x(i)} cy={y(p.value)} r="3" fill="var(--color-accent)"><title>{`${p.label}: ${showValue(p.value, format)}`}</title></circle>)}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-steel"><span>{points[0]?.label}</span><span>{points.at(-1)?.label}</span></div>
      <p className="num mt-1 text-right text-xs">Latest: {showValue(points.at(-1)?.value, format)}</p>
    </div>
  );
}

function PieChart({ points, format }) {
  const positive = points.filter((p) => p.value > 0);
  const total = positive.reduce((sum, p) => sum + p.value, 0);
  let start = 0;
  const arcs = positive.map((point, i) => {
    const size = total > 0 ? (point.value / total) * 360 : 0;
    const arc = `${PALETTE[i % PALETTE.length]} ${start}deg ${start + size}deg`;
    start += size;
    return arc;
  });
  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      <div role="img" aria-label="Pie chart" className="h-32 w-32 shrink-0 rounded-full" style={{ background: arcs.length ? `conic-gradient(${arcs.join(',')})` : 'var(--color-paper)' }} />
      <ul className="min-w-0 flex-1 space-y-1 text-xs">
        {positive.map((point, i) => (
          <li key={point.label} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
            <span className="min-w-0 flex-1 truncate">{point.label}</span>
            <span className="num shrink-0">{showValue(point.value, format)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CHARTS = { BAR: BarChart, LINE: LineChart, PIE: PieChart };

export function DashboardsPage() {
  const list = useQuery({ queryKey: ['dashboards'], queryFn: () => get('/views/dashboards') });
  return (
    <>
      <PageHeader
        title="Dashboards"
        subtitle="Built from number cards and charts"
        actions={(
          <>
            <Link to="/NumberCard"><Button>Number cards</Button></Link>
            <Link to="/DashboardChart"><Button>Charts</Button></Link>
            <Link to="/Dashboard/new"><Button variant="primary">New dashboard</Button></Link>
          </>
        )}
      />
      {list.isLoading && <Spinner />}
      <ErrorBox error={list.error} />
      {list.data?.length === 0 && <Card><p className="p-4 text-sm text-steel">No dashboard yet. Make a number card or chart, then a dashboard to hold them.</p></Card>}
      <ul className="grid gap-3 md:grid-cols-3">
        {(list.data ?? []).map((row) => (
          <li key={row.id}>
            <Link to={`/dash/${row.id}`} className="block rounded-lg border border-line bg-card p-4 hover:bg-paper">
              <div className="text-sm font-semibold">{row.name}</div>
              {row.description && <div className="mt-1 text-xs text-steel">{row.description}</div>}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function DashboardView() {
  const { id } = useParams();
  const query = useQuery({ queryKey: ['dashboard', id], queryFn: () => get(`/views/dashboards/${id}`), refetchInterval: 300000 });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  const { name, description, cards, charts } = query.data;
  return (
    <>
      <PageHeader title={name} subtitle={description} back={{ to: '/dash', label: 'Dashboards' }} actions={<Link to={`/Dashboard/${id}`}><Button>Change</Button></Link>} />
      {cards.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {cards.map((card) => (
            <div key={card.id} className="rounded-lg border border-line bg-card px-4 py-3">
              <div className="text-xs text-steel">{card.label}</div>
              {card.error ? <div className="mt-1 text-xs text-danger">{card.error}</div> : <div className="num mt-1 truncate text-lg font-semibold">{showValue(card.value, card.format)}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {charts.map((chart) => {
          const Chart = CHARTS[chart.chartType] ?? BarChart;
          return (
            <Card key={chart.id} title={chart.title}>
              {chart.error && <p className="p-4 text-sm text-danger">{chart.error}</p>}
              {chart.points?.length === 0 && <p className="p-4 text-sm text-steel">No data yet.</p>}
              {chart.points?.length > 0 && <Chart points={chart.points} format={chart.format} />}
            </Card>
          );
        })}
      </div>
    </>
  );
}
