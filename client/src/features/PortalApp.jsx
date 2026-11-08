// What a customer or supplier sees when they sign in. It shares nothing with the staff screens.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Spinner, Stat, Table, TextArea } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatDate, formatDateTime, formatMinor, formatPaise, humanise } from '../utils/format.js';

const money = (key, label) => ({ key, label, align: 'right', render: (r) => formatPaise(r[key]) });
const date = (key, label) => ({ key, label, render: (r) => formatDate(r[key]) });
const badge = (key, label) => ({ key, label, render: (r) => <Badge value={r[key]} /> });
const amount = { key: 'amountMinor', label: 'Amount', align: 'right', render: (r) => formatMinor(r.amountMinor, r.currency) };

const TABS = {
  invoices: { label: 'Invoices', path: '/portal/invoices', columns: [{ key: 'docNo', label: 'Invoice' }, date('postingDate', 'Date'), date('dueDate', 'Due'), money('totalPaise', 'Total'), money('outstandingPaise', 'Still due')], for: 'customer' },
  orders: { label: 'Orders', path: '/portal/orders', columns: [{ key: 'docNo', label: 'Order' }, date('postingDate', 'Date'), date('deliveryDate', 'Delivery'), amount, badge('status', 'Status')], for: 'customer' },
  quotations: { label: 'Quotations', path: '/portal/quotations', columns: [{ key: 'docNo', label: 'Quotation' }, date('postingDate', 'Date'), date('validUntil', 'Valid until'), amount, badge('status', 'Status')], for: 'customer' },
  machines: { label: 'Machines', path: '/portal/machines', columns: [{ key: 'serialNo', label: 'Serial no.' }, { key: 'itemName', label: 'Machine', wrap: true }, { key: 'stage', label: 'Stage', render: (r) => humanise(r.stage) }, date('targetDate', 'Target date')], for: 'customer' },
  purchaseOrders: { label: 'Purchase orders', path: '/portal/purchase-orders', columns: [{ key: 'docNo', label: 'PO' }, date('postingDate', 'Date'), amount, badge('status', 'Status')], for: 'supplier' },
  bills: { label: 'Your bills', path: '/portal/bills', columns: [{ key: 'docNo', label: 'Our ref.' }, date('postingDate', 'Date'), date('dueDate', 'Due'), money('totalPaise', 'Total'), money('outstandingPaise', 'Still to pay')], for: 'supplier' },
  payments: { label: 'Payments', path: '/portal/payments', columns: [{ key: 'docNo', label: 'Ref.' }, date('postingDate', 'Date'), { key: 'reference', label: 'Bank ref.' }, money('amountPaise', 'Amount')] },
  statement: { label: 'Statement', path: '/portal/statement', columns: [date('postingDate', 'Date'), { key: 'voucherNo', label: 'Reference' }, money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), money('balancePaise', 'Balance')] },
};

function PortalTable({ tab }) {
  const query = useQuery({ queryKey: ['portal', tab.path], queryFn: () => get(tab.path) });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <div className="p-3"><ErrorBox error={query.error} /></div>;
  return <Table columns={tab.columns} rows={query.data} empty="Nothing here yet." />;
}

function Tickets() {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const list = useQuery({ queryKey: ['portal', 'tickets'], queryFn: () => get('/portal/tickets') });
  const raise = useMutation({
    mutationFn: () => post('/portal/tickets', { subject, description }),
    onSuccess: () => { setSubject(''); setDescription(''); queryClient.invalidateQueries({ queryKey: ['portal', 'tickets'] }); },
  });
  return (
    <div className="space-y-4 p-4">
      <form className="max-w-lg space-y-3" onSubmit={(e) => { e.preventDefault(); raise.mutate(); }}>
        <Field label="What is the problem?"><Input required value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        <Field label="Details"><TextArea value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <ErrorBox error={raise.error} />
        <Button type="submit" variant="primary" disabled={raise.isPending}>{raise.isPending ? 'Sending…' : 'Raise a ticket'}</Button>
      </form>
      {list.isLoading && <Spinner />}
      <ErrorBox error={list.error} />
      {list.data && <Table rows={list.data} empty="No tickets yet." columns={[{ key: 'subject', label: 'Ticket', wrap: true }, { key: 'createdAt', label: 'Raised', render: (r) => formatDateTime(r.createdAt) }, badge('status', 'Status'), { key: 'resolution', label: 'Answer', wrap: true }]} />}
    </div>
  );
}

export function PortalApp() {
  const { user, signOut } = useAuth();
  const me = useQuery({ queryKey: ['portal', 'me'], queryFn: () => get('/portal/me') });
  const [active, setActive] = useState(null);
  if (me.isLoading) return <Spinner label="Starting" />;
  if (me.error) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <ErrorBox error={me.error} />
        <Button className="mt-4" onClick={signOut}>Sign out</Button>
      </main>
    );
  }
  const party = me.data;
  const tabs = Object.entries(TABS).filter(([, tab]) => !tab.for || (tab.for === 'customer' && party.isCustomer) || (tab.for === 'supplier' && party.isSupplier));
  const tabKey = active ?? tabs[0]?.[0] ?? 'tickets';
  return (
    <div className="min-h-full bg-paper">
      <header className="flex items-center justify-between gap-2 border-b border-line bg-card px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold">{party.name}</div>
          <div className="truncate text-xs text-steel">{user.name}</div>
        </div>
        <Button variant="ghost" onClick={signOut}>Sign out</Button>
      </header>
      <main className="mx-auto max-w-5xl space-y-4 p-3 md:p-5">
        <div className="grid grid-cols-2 gap-3">
          {party.isCustomer && <Stat label="You owe us" value={formatPaise(party.youOwePaise)} />}
          {party.isSupplier && <Stat label="We owe you" value={formatPaise(party.weOwePaise)} />}
        </div>
        <nav className="flex flex-wrap gap-1" aria-label="Sections">
          {tabs.map(([key, tab]) => <Button key={key} variant={tabKey === key ? 'primary' : 'default'} onClick={() => setActive(key)}>{tab.label}</Button>)}
          {party.isCustomer && <Button variant={tabKey === 'tickets' ? 'primary' : 'default'} onClick={() => setActive('tickets')}>Support</Button>}
        </nav>
        <Card>
          {tabKey === 'tickets' ? <Tickets /> : <PortalTable key={tabKey} tab={TABS[tabKey]} />}
        </Card>
      </main>
    </div>
  );
}
