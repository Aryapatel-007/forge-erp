// Changing how the system behaves without changing its code.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, downloadFile, get, post, queryString } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Spinner, Table } from '../components/ui.jsx';
import { useMeta } from '../context/Meta.jsx';
import { formatDateTime } from '../utils/format.js';

const DoctypeSelect = ({ value, onChange }) => {
  const meta = useMeta();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Choose</option>
      {meta.doctypes.map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
    </Select>
  );
};

export function CustomFieldsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['custom-fields'], queryFn: () => get('/admin/custom-fields') });
  const empty = { doctype: '', key: '', label: '', type: 'text', options: '', required: false };
  const [form, setForm] = useState(empty);
  const refresh = () => {
    client.invalidateQueries({ queryKey: ['custom-fields'] });
    client.invalidateQueries({ queryKey: ['meta'] });
  };
  const add = useMutation({
    mutationFn: () => post('/admin/custom-fields', { doctype: form.doctype, key: form.key, label: form.label, type: form.type, required: form.required, ...(form.type === 'select' ? { options: form.options.split(',').map((s) => s.trim()).filter(Boolean) } : {}) }),
    onSuccess: () => { setForm(empty); refresh(); },
  });
  const remove = useMutation({ mutationFn: (id) => del(`/admin/custom-fields/${id}`), onSuccess: refresh });
  return (
    <>
      <PageHeader title="Custom fields" subtitle="Add your own fields to any document type. They appear on its form and its record." />
      <div className="space-y-4">
        <form onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <Card className="p-4">
            <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
              <Field label="Document type"><DoctypeSelect value={form.doctype} onChange={(doctype) => setForm({ ...form, doctype })} /></Field>
              <Field label="Label"><Input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
              <Field label="Key" hint="Letters and digits, starting small, like machineTag"><Input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></Field>
              <Field label="Type">
                <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                  {['text', 'long', 'int', 'check', 'date', 'select', 'money', 'qty'].map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
              {form.type === 'select' && <Field label="Options, with commas"><Input value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} /></Field>}
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />Required</label>
              <Button type="submit" variant="primary" disabled={add.isPending}>Add field</Button>
            </div>
            <div className="mt-3"><ErrorBox error={add.error ?? remove.error} /></div>
          </Card>
        </form>
        <Card>
          {query.isLoading && <Spinner />}
          <ErrorBox error={query.error} />
          {query.data && <Table rows={query.data} empty="No custom fields yet." columns={[{ key: 'doctype', label: 'Document' }, { key: 'label', label: 'Label' }, { key: 'key', label: 'Key' }, { key: 'type', label: 'Type' }, { key: 'x', label: '', render: (r) => <Button variant="ghost" onClick={() => remove.mutate(r.id)}>Remove</Button> }]} />}
        </Card>
      </div>
    </>
  );
}

export function RolePermissionsPage() {
  const [doctype, setDoctype] = useState('');
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['role-perms', doctype], queryFn: () => get(`/admin/role-permissions${queryString({ doctype })}`), enabled: Boolean(doctype) });
  const save = useMutation({ mutationFn: (row) => post('/admin/role-permissions', { doctype, ...row }), onSuccess: () => { client.invalidateQueries({ queryKey: ['role-perms', doctype] }); client.invalidateQueries({ queryKey: ['meta'] }); } });
  const flip = (row, key) => save.mutate({ role: row.role, read: row.read, write: row.write, submit: row.submit, cancel: row.cancel, [key]: !row[key] });
  const box = (key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1), render: (row) => <input type="checkbox" aria-label={`${row.role} ${key}`} className="size-5" checked={row[key]} disabled={row.role === 'ADMIN'} onChange={() => flip(row, key)} /> });
  return (
    <>
      <PageHeader title="Role permissions" subtitle="Who may read, write, submit and cancel each document type. Admin always can." />
      <div className="space-y-4">
        <Field label="Document type" className="max-w-md"><DoctypeSelect value={doctype} onChange={setDoctype} /></Field>
        <ErrorBox error={query.error ?? save.error} />
        {query.data && <Card><Table rowKey={(r) => r.role} rows={query.data} columns={[{ key: 'role', label: 'Role' }, box('read'), box('write'), box('submit'), box('cancel')]} /></Card>}
      </div>
    </>
  );
}

export function SystemPage() {
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => get('/admin/jobs') });
  const emails = useQuery({ queryKey: ['emails'], queryFn: () => get('/admin/email-queue') });
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => get('/views/backups') });
  const backupNow = useMutation({ mutationFn: () => post('/views/backups'), onSuccess: () => backups.refetch() });
  return (
    <>
      <PageHeader title="Background jobs and email" />
      <div className="space-y-4">
        <Card title="Jobs">
          <ErrorBox error={jobs.error} />
          <Table rows={jobs.data ?? []} empty="No job has run yet." columns={[{ key: 'id', label: 'Job' }, { key: 'lastRunAt', label: 'Last run', render: (r) => formatDateTime(r.lastRunAt) }, { key: 'lastResult', label: 'Result' }, { key: 'lastError', label: 'Error', wrap: true }, { key: 'nextRunAt', label: 'Next', render: (r) => formatDateTime(r.nextRunAt) }]} />
        </Card>
        <Card title="Backups" actions={<Button onClick={() => backupNow.mutate()} disabled={backupNow.isPending}>{backupNow.isPending ? 'Working…' : 'Back up now'}</Button>}>
          <ErrorBox error={backups.error ?? backupNow.error} />
          <Table
            rows={backups.data ?? []}
            empty="No backup yet."
            columns={[
              { key: 'createdAt', label: 'Taken', render: (r) => formatDateTime(r.createdAt) },
              { key: 'documents', label: 'Records', align: 'right' },
              { key: 'bytes', label: 'Size', align: 'right', render: (r) => `${(r.bytes / 1048576).toFixed(1)} MB` },
              { key: 'download', label: '', render: (r) => <Button variant="ghost" onClick={() => downloadFile(`/views/backups/${r.name}/download`, `${r.name}.jsonl.gz`)}>Download</Button> },
            ]}
          />
          <p className="p-4 text-xs text-steel">One runs by itself every day. They stay on this machine until you move them, so copy them elsewhere. A backup on the same disk does not survive losing that disk.</p>
        </Card>
        <Card title="Email queue">
          <ErrorBox error={emails.error} />
          <Table rows={emails.data ?? []} empty="Nothing queued." columns={[{ key: 'to', label: 'To' }, { key: 'subject', label: 'Subject', wrap: true }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} tone={r.status === 'SENT' ? 'ok' : r.status === 'FAILED' ? 'danger' : 'warn'} /> }, { key: 'createdAt', label: 'When', render: (r) => formatDateTime(r.createdAt) }]} />
          <p className="p-4 text-xs text-steel">Email only leaves if a mail server is set with SMTP_HOST on the server. Until then it waits here as "Not configured".</p>
        </Card>
      </div>
    </>
  );
}

export function ImportDialog({ config, onClose, onDone }) {
  const [csv, setCsv] = useState('');
  const [report, setReport] = useState(null);
  const run = useMutation({
    mutationFn: (dryRun) => post(`${config.endpoint}/import`, { csv, dryRun }),
    onSuccess: (result) => { setReport(result); if (!result.dryRun) onDone(); },
  });
  const headings = config.fields.filter((f) => f.type !== 'lines' && !f.customKey && f.key !== 'postingDate').map((f) => f.key).join(',');
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" role="dialog" aria-modal="true" aria-label="Import">
      <div className="max-h-[90vh] w-full overflow-auto rounded-t-lg bg-card p-4 md:max-w-2xl md:rounded-lg">
        <h2 className="text-base font-semibold">Import {config.title.toLowerCase()}</h2>
        <p className="mt-1 break-all text-xs text-steel">First row is the headings: {headings}. Money in rupees, percent as 18, links by their code or name.</p>
        <input aria-label="CSV file" type="file" accept=".csv,text/csv" className="mt-3 text-sm" onChange={async (e) => { if (e.target.files[0]) setCsv(await e.target.files[0].text()); setReport(null); }} />
        <ErrorBox error={run.error} />
        {report && (
          <div className="mt-3 text-sm">
            <p>{report.dryRun ? 'Checked' : 'Imported'} {report.ok} of {report.total}. {report.errorCount} problem(s).</p>
            <ul className="mt-1 max-h-48 list-disc overflow-auto pl-4 text-danger">{report.errors.map((e) => <li key={e.row}>Row {e.row}: {e.message}</li>)}</ul>
          </div>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button disabled={!csv || run.isPending} onClick={() => run.mutate(true)}>Check, save nothing</Button>
          <Button variant="primary" disabled={!csv || run.isPending || !report?.dryRun || report.errorCount > 0} onClick={() => run.mutate(false)}>Import</Button>
        </div>
      </div>
    </div>
  );
}
