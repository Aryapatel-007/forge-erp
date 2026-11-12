// The one list every kind of record uses: its title and main action, one row of search and
// filters, the views, and the results. Less common actions wait under More.
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { downloadFile, getList, post, queryString } from '../../api/client.js';
import { Icon } from '../../components/icons.jsx';
import { Badge, Button, Card, ErrorBox, Input, MenuButton, MoreMenu, PageHeader, Select, Spinner, Table, useToast } from '../../components/ui.jsx';
import { useAllowed, useResource } from '../../config/useResource.js';
import { NotFoundPage } from '../../components/NotFoundPage.jsx';
import { isStarred, noteVisit, toggleStar } from '../../utils/recents.js';
import { ImportDialog } from '../PlatformAdmin.jsx';
import { CalendarView, GanttView, KanbanView, TreeView, ViewSwitch } from './Views.jsx';

const PAGE_SIZE = 50;

export function ListPage({ resource: fixed }) {
  const params = useParams();
  const key = fixed ?? params.resource;
  const config = useResource(key);
  const allowed = useAllowed(config);
  const [isImporting, setIsImporting] = useState(false);
  const toast = useToast();
  const [bulkResult, setBulkResult] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [starred, setStarred] = useState(() => isStarred(`/${key}`));
  const { view: viewParam, ...fromUrl } = Object.fromEntries(new URLSearchParams(location.search));
  const view = viewParam ?? 'list';
  const setView = (next) => navigate({ search: next === 'list' ? '' : `?view=${next}` }, { replace: true });

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(q); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    setQ('');
    setFilters({});
    setPage(1);
    setBulkResult(null);
    setStarred(isStarred(`/${key}`));
  }, [key]);

  useEffect(() => {
    if (config) noteVisit(`/${key}`, config.title, 'list');
  }, [key, config?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useQuery({
    queryKey: ['list', key, search, filters, page, location.search],
    queryFn: () => getList(`${config.endpoint}${queryString({ ...fromUrl, ...filters, q: search, page, limit: PAGE_SIZE })}`),
    enabled: Boolean(config) && allowed('read') && view === 'list',
    placeholderData: keepPreviousData,
  });

  const draftsHere = (list.data?.data ?? []).filter((row) => row.status === 'DRAFT').map((row) => row.id);
  const submitDrafts = async () => {
    if (!window.confirm(`Submit ${draftsHere.length} drafts on this page? This posts them.`)) return;
    setBulkResult(null);
    try {
      const result = await post(`${config.endpoint}/bulk`, { action: 'submit', ids: draftsHere });
      setBulkResult(result);
      toast(`${result.done} submitted${result.failed ? `, ${result.failed} not` : ''}`, result.failed ? 'warn' : 'ok');
    } catch (error) {
      setBulkResult({ error });
    }
    list.refetch();
  };

  if (!config) return <NotFoundPage />;
  if (!allowed('read')) return <ErrorBox error={{ message: 'You do not have permission to see this.' }} />;

  const columns = config.columns.map((column) => (column.status ? { ...column, render: (row) => <Badge value={row[column.key]} /> } : column));
  const total = list.data?.meta?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const canImport = (config.isEngine || config.canImport) && allowed('write');
  const canBulk = config.isEngine && config.submittable && allowed('submit') && draftsHere.length > 0;
  const hasMore = config.isEngine || canImport || canBulk;
  const activeFilters = Object.values(filters).filter(Boolean).length + Object.keys(fromUrl).length;

  return (
    <>
      <PageHeader
        title={config.title}
        subtitle={view === 'list' && list.data ? `${total} ${total === 1 ? 'record' : 'records'}` : null}
        leading={(
          <button
            type="button"
            aria-label={starred ? 'Remove from starred' : 'Add to starred'}
            aria-pressed={starred}
            className={`rounded p-1 ${starred ? 'text-spark' : 'text-line-strong hover:text-steel'}`}
            onClick={() => setStarred(toggleStar(`/${key}`, config.title))}
          >
            <Icon name="star" filled={starred} />
          </button>
        )}
        actions={(
          <>
            {hasMore && (
              <MoreMenu>
                {(close) => (
                  <>
                    {config.isEngine && <MenuButton onClick={() => { close(); downloadFile(`${config.endpoint}/export`, `${config.name}.csv`); }}><Icon name="download" size={16} />Export CSV</MenuButton>}
                    {canImport && <MenuButton onClick={() => { close(); setIsImporting(true); }}><Icon name="upload" size={16} />Import CSV</MenuButton>}
                    {canBulk && <MenuButton onClick={() => { close(); submitDrafts(); }}><Icon name="check" size={16} />Submit drafts on this page</MenuButton>}
                  </>
                )}
              </MoreMenu>
            )}
            {!config.noCreate && allowed('write') && <Link to={`/${key}/new`}><Button variant="primary"><Icon name="plus" size={16} />New</Button></Link>}
          </>
        )}
      />
      {bulkResult?.error && <div className="mb-3"><ErrorBox error={bulkResult.error} /></div>}
      {bulkResult && !bulkResult.error && (
        <div role="status" className="mb-3 rounded-lg border border-line bg-card p-3 text-sm">
          {bulkResult.done} submitted, {bulkResult.failed} not.
          {bulkResult.failed > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-danger">{bulkResult.results.filter((r) => !r.ok).slice(0, 20).map((r) => <li key={r.id}>{r.message}</li>)}</ul>}
        </div>
      )}
      {config.meta && <div className="no-print mb-3"><ViewSwitch meta={config.meta} view={view} onChange={setView} /></div>}
      {view === 'kanban' && <KanbanView config={config} meta={config.meta} resource={key} canWrite={allowed('write')} />}
      {view === 'calendar' && <CalendarView config={config} meta={config.meta} resource={key} />}
      {view === 'tree' && <TreeView config={config} meta={config.meta} resource={key} />}
      {view === 'gantt' && <GanttView config={config} meta={config.meta} resource={key} canWrite={allowed('write')} />}
      {view === 'list' && (
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
            <div className="relative min-w-40 flex-1 md:max-w-xs">
              <Icon name="search" size={16} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-steel" />
              <Input aria-label={`Search ${config.title}`} placeholder="Search" className="pl-8" value={q} onChange={(event) => setQ(event.target.value)} />
            </div>
            {(config.filters ?? []).map((filter) => (
              <Select
                key={filter.key}
                aria-label={filter.label}
                className="w-auto max-w-44"
                value={filters[filter.key] ?? ''}
                onChange={(event) => { setFilters({ ...filters, [filter.key]: event.target.value }); setPage(1); }}
              >
                <option value="">{filter.label}: all</option>
                {filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </Select>
            ))}
            {activeFilters > 0 && (
              <Button variant="ghost" onClick={() => { setFilters({}); setPage(1); if (Object.keys(fromUrl).length) navigate({ search: '' }, { replace: true }); }}>Clear filters</Button>
            )}
          </div>
          {list.isLoading && <Spinner />}
          {list.isError && <div className="p-3"><ErrorBox error={list.error} /></div>}
          {list.data && (
            <Table columns={columns} rows={list.data.data} onRowClick={(row) => navigate(`/${key}/${row.id}`)} empty={search || activeFilters ? 'Nothing matches.' : `No ${config.title.toLowerCase()} yet.`} />
          )}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t border-line p-3 text-sm text-steel">
              <span>Page {page} of {lastPage}</span>
              <span className="flex gap-2">
                <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button disabled={page >= lastPage} onClick={() => setPage(page + 1)}>Next</Button>
              </span>
            </div>
          )}
        </Card>
      )}
      {isImporting && <ImportDialog config={config} onClose={() => setIsImporting(false)} onDone={() => list.refetch()} />}
    </>
  );
}
