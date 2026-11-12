import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, del, get, post, saveJson } from '../../api/client.js';
import { Icon } from '../../components/icons.jsx';
import { Badge, Button, Card, ErrorBox, MenuButton, MenuLink, MoreMenu, PageHeader, Spinner, StatusSteps, Table, Tabs, useToast } from '../../components/ui.jsx';
import { noteVisit } from '../../utils/recents.js';
import { useAuth } from '../../context/Auth.jsx';
import { useAllowed, useResource } from '../../config/useResource.js';
import { RecordExtras } from './RecordExtras.jsx';
import { NotFoundPage } from '../../components/NotFoundPage.jsx';
import { formatDateTime, formatMinor, formatPaise } from '../../utils/format.js';
import { ActionDialog } from './ActionDialog.jsx';

// The usual path of a document. Anything off the path, like cancelled, shows as a plain badge.
const CORE_STEPS = {
  quotations: ['DRAFT', 'SENT', 'WON'],
  salesOrders: ['DRAFT', 'CONFIRMED', 'CLOSED'],
  purchaseOrders: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED'],
  jobWork: ['DRAFT', 'SENT', 'PARTLY_RETURNED', 'RETURNED'],
  ncrs: ['OPEN', 'CLOSED'],
  tickets: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  boms: ['DRAFT', 'RELEASED'],
};
const OFF_PATH = new Set(['CANCELLED', 'STOPPED', 'LOST', 'REJECTED', 'FAILED', 'FAIL', 'ON_HOLD', 'DO_NOT_CONTACT']);

function stepsFor(resource, config, doc) {
  if (CORE_STEPS[resource]) return CORE_STEPS[resource];
  const value = doc.status ?? doc.state;
  if (!value) return null;
  const field = config.meta?.fields?.find((f) => f.type === 'select' && (f.key === 'state' || f.key === 'status'));
  if (field && field.options.includes(value)) return field.options.filter((option) => !OFF_PATH.has(option));
  if (config.submittable || config.kind === 'document') return ['DRAFT', 'SUBMITTED'];
  return null;
}

const withDoc = (columns, doc) => columns.map((column) => (column.render ? { ...column, render: (row) => column.render(row, doc) } : column));

export function Summary({ items, doc }) {
  const shown = items.filter((item) => doc[item.key] !== undefined && doc[item.key] !== null && doc[item.key] !== '');
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 md:grid-cols-4">
      {shown.map((item) => (
        <div key={item.key} className="min-w-0">
          <dt className="text-xs text-steel">{item.label}</dt>
          <dd className="whitespace-pre-wrap break-words text-sm">{doc._labels?.[item.labelKey] ?? (item.format ? item.format(doc[item.key]) : String(doc[item.key]))}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Totals({ items, doc }) {
  if (!items) return null;
  return (
    <dl className="ml-auto w-full max-w-xs space-y-1 p-4 text-sm">
      {items.filter((item) => doc[item.key] || item.strong).map((item) => (
        <div key={item.key} className={`flex justify-between gap-4 ${item.strong ? 'border-t border-line pt-1 font-semibold' : ''}`}>
          <dt>{item.label}</dt>
          <dd className="num">{item.minor ? formatMinor(doc[item.key], doc.currency) : (item.format ?? formatPaise)(doc[item.key])}</dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailPage() {
  const { resource, id } = useParams();
  const config = useResource(resource);
  const allowed = useAllowed(config);
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [tab, setTab] = useState(null);
  const toast = useToast();

  const query = useQuery({ queryKey: ['doc', resource, id], queryFn: () => get(`${config.endpoint}/${id}`), enabled: Boolean(config) });

  useEffect(() => { setTab(null); }, [resource, id]);
  useEffect(() => {
    if (config && query.data) noteVisit(`/${resource}/${id}`, config.titleOf?.(query.data) ?? query.data.docNo ?? config.single, 'record');
  }, [resource, id, query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['doc', resource, id] });
    queryClient.invalidateQueries({ queryKey: ['list', resource] });
    queryClient.invalidateQueries({ queryKey: ['home'] });
  };

  const run = useMutation({
    mutationFn: ({ method = 'POST', path, body }) => (method === 'POST'
      ? post(`${config.endpoint}/${id}${path ? `/${path}` : ''}`, body)
      : api(`${config.endpoint}/${id}`, { method, body }).then((r) => r.data)),
    onSuccess: (result, variables) => {
      refresh();
      setDialog(null);
      toast(variables.done ?? 'Done');
      if (variables.navigate) navigate(`/${variables.navigate}/${result.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`${config.endpoint}/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['list', resource] });
      toast('Deleted');
      navigate(`/${resource}`, { replace: true });
    },
  });

  if (!config) return <NotFoundPage />;
  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorBox error={query.error} />;
  const doc = query.data;
  const isDraft = doc.status === 'DRAFT';
  const writable = allowed('write');

  const open = (spec) => { run.reset(); setDialog(spec); };

  // Every action as data, so the next step can be a button and the rest can go under More.
  const actions = [];
  for (const action of config.actions ?? []) {
    if (!action.when(doc) || (action.perm && !can(action.perm))) continue;
    if (action.link) {
      actions.push({ key: action.label, label: action.label, primary: action.primary, to: action.link(doc) });
    } else if (action.save) {
      actions.push({ key: action.label, label: action.label, onClick: () => saveJson(...action.save(doc)).catch((error) => setSaveError(error)) });
    } else {
      actions.push({
        key: action.label,
        label: action.label,
        primary: action.primary,
        onClick: () => {
          if (action.form) {
            const raw = typeof action.form.fields === 'function' ? action.form.fields(doc) : action.form.fields;
            const fields = raw.map((field) => (field.optionsFrom ? { ...field, options: field.optionsFrom(doc) } : field));
            open({ title: action.form.title, hint: action.form.hint, fields, confirmLabel: action.label, run: (body) => run.mutate({ method: action.method, path: action.path, body, navigate: action.navigate }) });
          } else if (action.prompt) {
            open({ title: action.label, fields: [{ ...action.prompt, type: 'textarea', required: true }], confirmLabel: action.label, run: (body) => run.mutate({ path: action.path, body, navigate: action.navigate }) });
          } else {
            run.mutate({ path: action.path, body: {}, navigate: action.navigate });
          }
        },
      });
    }
  }
  if (isDraft && writable && !config.noSubmit) {
    actions.unshift({
      key: 'submit',
      label: config.submitLabel ?? 'Submit',
      primary: true,
      onClick: () => open({
        title: `${config.submitLabel ?? 'Submit'} this ${config.single.toLowerCase()}?`,
        hint: config.submitHint ?? 'Once submitted it cannot be edited, only cancelled.',
        fields: (config.submitPrompts ?? []).map((prompt) => ({ ...prompt, type: 'textarea', required: !prompt.optional })),
        confirmLabel: config.submitLabel ?? 'Submit',
        run: (body) => run.mutate({ path: 'submit', body, done: 'Submitted' }),
      }),
    });
  }
  const canEdit = (isDraft || config.alwaysEditable) && writable && !config.noEdit;
  const canDelete = (isDraft || config.alwaysEditable) && writable && !config.noDelete;
  const canCancel = !isDraft && doc.status !== 'CANCELLED' && writable && !config.noCancel;
  const askCancel = () => open({
    title: `Cancel ${doc.docNo}?`,
    hint: 'This posts a reversal dated today. The original stays on record.',
    fields: [{ key: 'reason', label: 'Why?', type: 'textarea', required: true }],
    confirmLabel: 'Cancel it',
    tone: 'danger',
    run: (body) => run.mutate({ path: 'cancel', body, done: 'Cancelled. A reversal was posted.' }),
  });

  // Up to two next steps stay in view. Anything else is one tap away.
  const primary = actions.filter((action) => action.primary).slice(0, 2);
  const secondary = actions.filter((action) => !primary.includes(action));
  const renderMain = (action) => (action.to
    ? <Link key={action.key} to={action.to}><Button variant="primary">{action.label}</Button></Link>
    : <Button key={action.key} variant="primary" disabled={run.isPending} onClick={action.onClick}>{action.label}</Button>);
  const hasMore = secondary.length > 0 || canDelete || canCancel;

  const title = config.titleOf?.(doc) ?? doc.docNo ?? `Draft ${config.single.toLowerCase()}`;
  const lineColumns = config.lineColumns ? withDoc(config.lineColumns, doc) : null;
  const statusValue = doc.status ?? doc.state ?? doc.stage;
  const steps = stepsFor(resource, config, doc);

  const tables = (config.extraTables ?? []).filter((t) => doc[t.key]?.length);
  const hasCustom = config.customFields?.some((f) => doc.custom?.[f.customKey] !== undefined);
  const hasTerms = config.noteKey && doc[config.noteKey];
  const tabs = [
    ...(lineColumns ? [{ key: 'lines', label: 'Lines', count: doc.lines?.length ?? 0 }] : []),
    ...tables.map((t) => ({ key: `table:${t.key}`, label: t.title, count: doc[t.key].length })),
    ...(hasTerms ? [{ key: 'terms', label: 'Terms' }] : []),
    ...(hasCustom ? [{ key: 'more', label: 'More' }] : []),
    { key: 'activity', label: 'Activity', className: 'lg:hidden' },
  ];
  // On a large screen activity sits beside the document, so it is never the open tab there.
  const firstContent = tabs[0]?.key;
  const shown = tab ?? firstContent;
  const contentTab = shown === 'activity' ? (tabs.length > 1 ? firstContent : null) : shown;
  const showTabs = tabs.length > 1;

  return (
    <>
      <PageHeader
        back={{ to: `/${resource}`, label: config.title }}
        title={title}
        subtitle={steps ? <div className="mt-1"><StatusSteps steps={steps} current={statusValue} /></div> : (statusValue ? <Badge value={statusValue} /> : null)}
        actions={(
          <>
            {canEdit && <Link to={`/${resource}/${id}/edit`}><Button><Icon name="edit" size={15} />Edit</Button></Link>}
            {config.printTitle && <Link to={`/print/${resource}/${id}`}><Button aria-label="Print"><Icon name="printer" size={15} /><span className="hidden sm:inline">Print</span></Button></Link>}
            {hasMore && (
              <MoreMenu>
                {(close) => (
                  <>
                    {secondary.map((action) => (action.to
                      ? <MenuLink key={action.key} to={action.to} onClick={close}>{action.label}</MenuLink>
                      : <MenuButton key={action.key} disabled={run.isPending} onClick={() => { close(); action.onClick(); }}>{action.label}</MenuButton>))}
                    {canCancel && <MenuButton danger onClick={() => { close(); askCancel(); }}>Cancel</MenuButton>}
                    {canDelete && <MenuButton danger disabled={remove.isPending} onClick={() => { close(); if (window.confirm('Delete this for good?')) remove.mutate(); }}>{isDraft ? 'Delete draft' : 'Delete'}</MenuButton>}
                  </>
                )}
              </MoreMenu>
            )}
            {primary.map(renderMain)}
          </>
        )}
      />
      <div className="space-y-4">
        <ErrorBox error={saveError ?? remove.error ?? (!dialog ? run.error : null)} />
        {doc.status === 'CANCELLED' && doc.cancelReason && <ErrorBox error={{ message: `Cancelled ${formatDateTime(doc.cancelledAt)}: ${doc.cancelReason}` }} />}
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="min-w-0 space-y-4">
            {config.summary && <Card><Summary items={config.summary} doc={doc} /></Card>}
            {showTabs && <Tabs tabs={tabs} active={shown} onChange={setTab} />}
            <div className={shown === 'activity' ? 'hidden lg:block' : ''}>
              {contentTab === 'lines' && lineColumns && (
                <Card>
                  <Table columns={lineColumns} rows={doc.lines} />
                  <Totals items={config.totals} doc={doc} />
                </Card>
              )}
              {tables.filter((t) => contentTab === `table:${t.key}`).map((table) => (
                <Card key={table.key}>
                  <Table columns={withDoc(table.columns, doc)} rows={doc[table.key]} rowKey={table.rowKey} />
                </Card>
              ))}
              {contentTab === 'terms' && <Card><p className="whitespace-pre-wrap p-4 text-sm">{doc[config.noteKey]}</p></Card>}
              {contentTab === 'more' && (
                <Card><dl className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">{config.customFields.filter((f) => doc.custom?.[f.customKey] !== undefined).map((f) => <div key={f.key}><dt className="text-xs text-steel">{f.label}</dt><dd className="text-sm">{String(doc.custom[f.customKey])}</dd></div>)}</dl></Card>
              )}
            </div>
          </div>
          <aside className={shown === 'activity' ? 'min-w-0' : 'hidden min-w-0 lg:block'}>
            <RecordExtras config={config} resource={resource} id={id} doc={doc} onChanged={refresh} />
          </aside>
        </div>
      </div>
      {dialog && (
        <ActionDialog {...dialog} error={run.error} isPending={run.isPending} onConfirm={dialog.run} onClose={() => setDialog(null)} />
      )}
    </>
  );
}
