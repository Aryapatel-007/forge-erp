// Runs any declared report, and lets a person build their own from any document type.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, queryString } from '../api/client.js';
import { Button, Card, ErrorBox, Field, PageHeader, Select, Spinner, Table } from '../components/ui.jsx';
import { useMeta } from '../context/Meta.jsx';
import { formatByType, configFromMeta } from '../config/useResource.js';
import { FormField, initialValues, toPayload } from './generic/fields.jsx';
import { humanise } from '../utils/format.js';

const NUMERIC = new Set(['money', 'smoney', 'qty', 'sqty', 'pct', 'int']);

function csvDownload(name, columns, rows) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[=+\-@]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [columns.map((c) => cell(c.label)).join(','), ...rows.map((row) => columns.map((c) => cell(formatByType(c.type, row[c.key]))).join(','))];
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const tableColumns = (columns) => columns.map((c) => ({
  key: c.key,
  label: c.label,
  align: NUMERIC.has(c.type) ? 'right' : undefined,
  wrap: c.type === 'text',
  render: (row) => formatByType(c.type, row[c.key]),
}));

function Bars({ columns, rows }) {
  const value = columns.find((c) => c.type === 'money' || c.type === 'int' || c.type === 'qty');
  const label = columns.find((c) => c.type === 'text');
  if (!value || !label || rows.length < 2 || rows.length > 24) return null;
  const max = Math.max(...rows.map((r) => Math.abs(r[value.key] ?? 0)), 1);
  return (
    <Card title={`${value.label} by ${label.label.toLowerCase()}`}>
      <ul className="space-y-1.5 p-4">
        {rows.map((row, index) => (
          <li key={`${row[label.key]}${index}`} className="grid grid-cols-[minmax(0,1fr)_2fr_auto] items-center gap-2 text-xs">
            <span className="truncate">{row[label.key] ? humanise(row[label.key]) : '(blank)'}</span>
            <span className="h-3 rounded-sm bg-paper"><span className="block h-3 rounded-sm bg-accent" style={{ width: `${Math.round((Math.abs(row[value.key] ?? 0) / max) * 100)}%` }} /></span>
            <span className="num">{formatByType(value.type, row[value.key])}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ReportRunner() {
  const { key } = useParams();
  const meta = useMeta();
  const report = meta.reports.find((r) => r.key === key);
  const fields = (report?.filters ?? []).map((f) => configFromMeta({ name: 'x', label: 'x', fields: [f], tables: [], list: [], labelFields: [], actions: [], can: {} }).fields[0]).map((f) => ({ ...f, required: false, sendNull: false }));
  const [values, setValues] = useState(() => initialValues(fields));
  const [params, setParams] = useState({});
  const [localError, setLocalError] = useState(null);
  const needsInput = (report?.filters ?? []).some((f) => f.required);
  const [hasRun, setHasRun] = useState(!needsInput);
  const query = useQuery({ queryKey: ['report-run', key, params], queryFn: () => get(`/r/${key}${queryString(params)}`), enabled: Boolean(report) && hasRun });

  if (!report) return <ErrorBox error={{ message: 'That report does not exist, or you cannot see it.' }} />;
  const run = (event) => {
    event.preventDefault();
    setLocalError(null);
    try {
      setParams(toPayload(fields, values));
      setHasRun(true);
    } catch (error) {
      setLocalError(error);
    }
  };
  return (
    <>
      <PageHeader title={report.title} back={{ to: '/reports', label: 'All reports' }} />
      <div className="space-y-4">
        {fields.length > 0 && (
          <form onSubmit={run}>
            <Card className="p-4">
              <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-4">
                {fields.map((field) => <FormField key={field.key} field={{ ...field, wide: false }} values={values} setValue={(k, v) => setValues({ ...values, [k]: v })} />)}
                <Button type="submit" variant="primary">Run</Button>
              </div>
            </Card>
          </form>
        )}
        <ErrorBox error={localError ?? query.error} />
        {query.isLoading && hasRun && <Spinner />}
        {query.data && (
          <>
            <Bars columns={query.data.columns} rows={query.data.rows} />
            <Card title={`${query.data.rows.length} row(s)`} actions={query.data.rows.length ? <Button variant="ghost" onClick={() => csvDownload(key, query.data.columns, query.data.rows)}>Download CSV</Button> : null}>
              <Table
                columns={tableColumns(query.data.columns)}
                rows={query.data.rows}
                rowKey={(_row) => undefined}
                empty="Nothing to show."
                totals={Object.keys(query.data.totals).length ? Object.fromEntries(Object.entries(query.data.totals).map(([k, v]) => [k, formatByType(query.data.columns.find((c) => c.key === k)?.type, v)])) : undefined}
              />
            </Card>
          </>
        )}
      </div>
    </>
  );
}

export function ReportBuilder() {
  const meta = useMeta();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [doctype, setDoctype] = useState('');
  const [columns, setColumns] = useState([]);
  const [groupBy, setGroupBy] = useState('');
  const [sums, setSums] = useState([]);
  const type = meta.doctypes.find((d) => d.name === doctype);
  const saved = useQuery({ queryKey: ['saved-reports'], queryFn: () => get('/saved-reports') });
  const run = useMutation({ mutationFn: (body) => post('/report-builder', body) });
  const save = useMutation({ mutationFn: (body) => post('/saved-reports', body), onSuccess: () => client.invalidateQueries({ queryKey: ['saved-reports'] }) });
  const numeric = type?.fields.filter((f) => NUMERIC.has(f.type)) ?? [];
  const toggle = (list, setList, key) => setList(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const load = (row) => {
    setDoctype(row.doctype);
    setColumns(row.columns);
    setGroupBy(row.groupBy ?? '');
    setSums(row.sums);
    run.mutate({ doctype: row.doctype, columns: row.columns, groupBy: row.groupBy || null, sums: row.sums });
  };
  const body = { doctype, columns, groupBy: groupBy || null, sums };
  return (
    <>
      <PageHeader title="Build a report" subtitle="Pick a document type and what to show. Group it to add things up." actions={<Button onClick={() => navigate('/reports')}>All reports</Button>} />
      <div className="space-y-4">
        {saved.data?.length > 0 && (
          <Card title="Saved">
            <ul className="flex flex-wrap gap-2 p-4">{saved.data.map((row) => <li key={row.id}><Button onClick={() => load(row)}>{row.name}</Button></li>)}</ul>
          </Card>
        )}
        <Card className="space-y-3 p-4">
          <Field label="Document type" className="max-w-md">
            <Select value={doctype} onChange={(e) => { setDoctype(e.target.value); setColumns([]); setGroupBy(''); setSums([]); run.reset(); }}>
              <option value="">Choose</option>
              {meta.doctypes.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
            </Select>
          </Field>
          {type && (
            <>
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-steel">Columns</legend>
                <div className="flex flex-wrap gap-3">
                  {type.fields.map((f) => <label key={f.key} className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="size-4" checked={columns.includes(f.key)} onChange={() => toggle(columns, setColumns, f.key)} />{f.label}</label>)}
                </div>
              </fieldset>
              <Field label="Group by" className="max-w-md">
                <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  <option value="">No grouping</option>
                  {[...type.fields.filter((f) => ['select', 'link', 'date', 'text'].includes(f.type)).map((f) => [f.key, f.label]), ...(type.submittable ? [['status', 'Status']] : [])].map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </Select>
              </Field>
              {groupBy && numeric.length > 0 && (
                <fieldset>
                  <legend className="mb-1 text-xs font-medium text-steel">Add up</legend>
                  <div className="flex flex-wrap gap-3">
                    {numeric.map((f) => <label key={f.key} className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="size-4" checked={sums.includes(f.key)} onChange={() => toggle(sums, setSums, f.key)} />{f.label}</label>)}
                  </div>
                </fieldset>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(body)}>Run</Button>
                <Button
                  onClick={() => {
                    const name = window.prompt('Name this report');
                    if (name) save.mutate({ ...body, name, isShared: true });
                  }}
                >
                  Save
                </Button>
              </div>
            </>
          )}
          <ErrorBox error={run.error ?? save.error} />
        </Card>
        {run.data && (
          <Card title={`${run.data.rows.length} row(s)`} actions={run.data.rows.length ? <Button variant="ghost" onClick={() => csvDownload(doctype, run.data.columns, run.data.rows)}>Download CSV</Button> : null}>
            <Table columns={tableColumns(run.data.columns)} rows={run.data.rows} rowKey={(row) => row.id ?? row.group} />
          </Card>
        )}
      </div>
    </>
  );
}
