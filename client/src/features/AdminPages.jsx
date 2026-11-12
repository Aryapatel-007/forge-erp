import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, getList, patch, post, queryString } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Spinner, Stat, Table, useToast } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatDateTime } from '../utils/format.js';
import { FormField, initialValues, toPayload } from './generic/fields.jsx';
import { ActionDialog } from './generic/ActionDialog.jsx';
import { ROLE_INFO, ROLE_KEYS, roleLabel } from '../config/roles.js';
import { Link } from 'react-router-dom';

const SETTINGS_FIELDS = [
  { key: 'legalName', label: 'Legal name', type: 'text', required: true, wide: true },
  { key: 'gstin', label: 'GSTIN', type: 'text' },
  { key: 'pan', label: 'PAN', type: 'text' },
  { key: 'stateCode', label: 'GST state code', type: 'text', hint: 'Decides CGST and SGST against IGST' },
  { key: 'address', label: 'Address', type: 'textarea', wide: true },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'bankDetails', label: 'Bank details for invoices', type: 'textarea', wide: true },
  { key: 'lutNumber', label: 'LUT number', type: 'text', hint: 'Needed for exports without IGST' },
  { key: 'poApprovalLimitPaise', label: 'PO needs approval from', type: 'money' },
  { key: 'labourRatePaise', label: 'Labour rate per hour', type: 'money' },
  { key: 'warrantyMonths', label: 'Warranty, months', type: 'integer' },
  { key: 'jobWorkInputDays', label: 'Job work return, inputs, days', type: 'integer' },
  { key: 'jobWorkCapitalDays', label: 'Job work return, capital goods, days', type: 'integer' },
  { key: 'roundOffInvoices', label: 'Round rupee invoices', type: 'check' },
  { key: 'siteShowPrices', label: 'Show sale prices on the website', type: 'check' },
  { key: 'blockExpiredBatches', label: 'Do not pick batches past their expiry', type: 'check' },
  { key: 'woDefaultOverBps', label: 'Work orders: over-production allowed %', type: 'bps' },
  { key: 'woDefaultBackflush', label: 'Work orders: issue materials on finishing', type: 'check' },
  { key: 'caReviewedOn', label: 'CA reviewed GST, TDS and payroll on', type: 'date' },
  { key: 'gstB2clLimitPaise', label: 'B2C large invoice limit', type: 'money', hint: 'Inter-state sales to unregistered buyers above this are listed one by one in GSTR-1' },
  { key: 'einvoiceRequired', label: 'E-invoicing applies to us', type: 'check' },
  { key: 'einvoiceReportDays', label: 'E-invoice reporting limit, days', type: 'integer', hint: '0 for no limit. Ask your CA which limit applies to your turnover.' },
  { key: 'booksLockedUpTo', label: 'Books locked up to', type: 'date', hint: 'Nothing can post on or before this date' },
];

const SETTING_GROUPS = [
  { title: 'Company', keys: ['legalName', 'gstin', 'pan', 'stateCode', 'address', 'email', 'phone', 'bankDetails'] },
  { title: 'GST and invoicing', keys: ['lutNumber', 'roundOffInvoices', 'gstB2clLimitPaise', 'einvoiceRequired', 'einvoiceReportDays', 'caReviewedOn'] },
  { title: 'Approvals and costing', keys: ['poApprovalLimitPaise', 'labourRatePaise', 'warrantyMonths', 'jobWorkInputDays', 'jobWorkCapitalDays'] },
  { title: 'Stock and production', keys: ['blockExpiredBatches', 'woDefaultOverBps', 'woDefaultBackflush'] },
  { title: 'Website', keys: ['siteShowPrices'] },
  { title: 'Books', keys: ['booksLockedUpTo'] },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: () => get('/admin/settings') });
  const [values, setValues] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (query.data) setValues(initialValues(SETTINGS_FIELDS, query.data));
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body) => patch('/admin/settings', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
    },
  });

  if (query.isLoading || !values) return query.isError ? <ErrorBox error={query.error} /> : <Spinner />;

  const submit = (event) => {
    event.preventDefault();
    setLocalError(null);
    setSaved(false);
    try {
      const payload = toPayload(SETTINGS_FIELDS, values);
      if (!values.booksLockedUpTo) payload.booksLockedUpTo = null;
      save.mutate(payload);
    } catch (error) {
      setLocalError(error);
    }
  };

  return (
    <>
      <PageHeader title="Settings" />
      <form onSubmit={submit} className="space-y-4">
        {SETTING_GROUPS.map((group) => (
          <Card key={group.title} title={group.title}>
            <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
              {SETTINGS_FIELDS.filter((field) => group.keys.includes(field.key)).map((field) => <FormField key={field.key} field={field} values={values} setValue={(key, value) => setValues({ ...values, [key]: value })} />)}
            </div>
          </Card>
        ))}
        <ErrorBox error={localError ?? save.error} />
        {saved && <p role="status" className="text-sm text-ok">Saved.</p>}
        <Button type="submit" variant="primary" disabled={save.isPending}>Save settings</Button>
      </form>
    </>
  );
}

const ROLES = ROLE_KEYS;
const partyRef = { endpoint: '/parties', labelOf: (r) => `${r.code} · ${r.name}` };
const portalParty = { key: 'partyId', label: 'Customer or supplier', type: 'ref', ref: partyRef, showIf: (v) => v.role === 'PORTAL', hint: 'A portal sign-in sees only this party\'s own documents' };
const roleOptions = ROLES.map((value) => ({ value, label: roleLabel(value) }));

export function UsersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const query = useQuery({ queryKey: ['users'], queryFn: () => get('/admin/users') });
  const [dialog, setDialog] = useState(null);
  const run = useMutation({
    mutationFn: ({ id, body }) => (id ? patch(`/admin/users/${id}`, body) : post('/admin/users', body)),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast(vars.id ? 'Account saved' : 'Account made');
      setDialog(null);
    },
  });
  const openNew = () => {
    run.reset();
    setDialog({
      title: 'New account',
      confirmLabel: 'Create account',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'email', label: 'Email', type: 'text', required: true },
        { key: 'role', label: 'Role', type: 'select', required: true, options: roleOptions },
        portalParty,
        { key: 'password', label: 'Password', type: 'text', required: true, hint: 'At least 10 characters. Ask them to change it.' },
      ],
      run: (body) => run.mutate({ body }),
    });
  };
  const openEdit = (user) => {
    run.reset();
    setDialog({
      title: `Change ${user.name}`,
      confirmLabel: 'Save',
      fields: [
        { key: 'role', label: 'Role', type: 'select', required: true, default: user.role, options: roleOptions },
        { ...portalParty, default: user.partyId },
        { key: 'isActive', label: 'Can sign in', type: 'check', default: user.isActive },
        { key: 'password', label: 'New password', type: 'text', hint: 'Leave blank to keep theirs' },
      ],
      run: (body) => run.mutate({ id: user.id, body }),
    });
  };
  return (
    <>
      <PageHeader title="Accounts" subtitle="Everyone who signs in to Forge. Their role decides what they see; the same app for all." actions={<Button variant="primary" onClick={openNew}>New account</Button>} />
      {query.data && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Accounts" value={query.data.length} />
          <Stat label="Can sign in" value={query.data.filter((u) => u.isActive).length} />
          <Stat label="Switched off" value={query.data.filter((u) => !u.isActive).length} />
          <Stat label="Roles in use" value={new Set(query.data.map((u) => u.role)).size} />
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <Input aria-label="Find an account" placeholder="Find by name or email" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select aria-label="Role" className="w-auto" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
            <option value="">Every role</option>
            {ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </Select>
        </div>
        {query.isLoading && <Spinner />}
        <ErrorBox error={query.error} />
        {query.data && (
          <Table rows={query.data.filter((u) => (!roleFilter || u.role === roleFilter) && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase())))} empty="No account matches." onRowClick={openEdit} columns={[{ key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role', render: (r) => roleLabel(r.role) }, { key: 'isActive', label: 'Status', render: (r) => <Badge value={r.isActive ? 'Active' : 'Switched off'} tone={r.isActive ? 'ok' : 'neutral'} /> }]} />
        )}
      </Card>
      <Card title="The roles" className="mt-4" actions={<Link to="/maintainer/roles" className="text-sm text-accent underline">Choose what each role sees</Link>}>
        <dl className="divide-y divide-line text-sm">
          {ROLES.map((role) => (
            <div key={role} className="flex flex-wrap gap-x-3 px-4 py-2">
              <dt className="w-48 shrink-0 font-medium">{roleLabel(role)}</dt>
              <dd className="min-w-0 flex-1 text-steel">{ROLE_INFO[role].blurb}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {dialog && <ActionDialog {...dialog} error={run.error} isPending={run.isPending} onConfirm={dialog.run} onClose={() => setDialog(null)} />}
    </>
  );
}

export function AuditPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({ queryKey: ['audit', q, page], queryFn: () => getList(`/admin/audit${queryString({ q, page, limit: 50 })}`) });
  return (
    <>
      <PageHeader title="Audit trail" subtitle="Every entry is chained to the one before it, so a change after the fact shows up in the integrity checks." />
      <Card>
        <div className="border-b border-line p-3"><Input aria-label="Search" placeholder="Search action, number or person" className="max-w-sm" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></div>
        {query.isLoading && <Spinner />}
        <ErrorBox error={query.error} />
        {query.data && (
          <Table rows={query.data.data} columns={[{ key: 'seq', label: 'No.' }, { key: 'at', label: 'When', render: (r) => formatDateTime(r.at) }, { key: 'actorName', label: 'Who' }, { key: 'action', label: 'What' }, { key: 'entityNo', label: 'Document' }, { key: 'reason', label: 'Reason', wrap: true }]} />
        )}
        {query.data?.meta.total > 50 && (
          <div className="flex justify-end gap-2 border-t border-line p-3">
            <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</Button>
            <Button disabled={page * 50 >= query.data.meta.total} onClick={() => setPage(page + 1)}>Older</Button>
          </div>
        )}
      </Card>
    </>
  );
}

export function PasswordPage() {
  const { signOut } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const change = useMutation({ mutationFn: () => post('/auth/change-password', form), onSuccess: () => signOut() });
  return (
    <>
      <PageHeader title="Change password" subtitle="You will be asked to sign in again on every device." />
      <form className="max-w-sm space-y-3" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <Field label="Current password"><Input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={(e) => setForm({ ...form, currentPassword: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters"><Input type="password" autoComplete="new-password" required minLength={10} value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} /></Field>
        <ErrorBox error={change.error} />
        <Button type="submit" variant="primary" disabled={change.isPending}>Change password</Button>
      </form>
    </>
  );
}

