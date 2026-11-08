import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { get, queryString } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Spinner, Stat, Table } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { useMeta } from '../context/Meta.jsx';
import { buildApps } from '../config/apps.js';
import { RefPicker } from '../components/RefPicker.jsx';
import { formatBps, formatDate, formatPaise, formatQty, todayIso } from '../utils/format.js';

const money = (key, label) => ({ key, label, align: 'right', render: (r) => formatPaise(r[key]) });
const qty = (key, label) => ({ key, label, align: 'right', render: (r) => formatQty(r[key]) });
const fyStart = () => {
  const today = todayIso();
  const year = Number(today.slice(0, 4));
  return `${Number(today.slice(5, 7)) >= 4 ? year : year - 1}-04-01`;
};
const totalsFrom = (object, keys) => Object.fromEntries(keys.map((key) => [key, formatPaise(object[key])]));

// Exports exactly what is on screen, so a download can never disagree with the page.
function downloadCsv(name, columns, rows) {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const text = (column, row) => {
    if (!column.render) return row[column.key];
    const out = column.render(row);
    return typeof out === 'object' ? (row[column.key] ?? '') : out;
  };
  const lines = [columns.map((c) => cell(c.label)).join(','), ...rows.map((row) => columns.map((c) => cell(text(c, row))).join(','))];
  const url = URL.createObjectURL(new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function Section({ title, columns, rows, totals, name, rowKey, onRow }) {
  return (
    <Card title={title} actions={rows?.length ? <Button variant="ghost" onClick={() => downloadCsv(name ?? title, columns, rows)}>Download CSV</Button> : null}>
      <Table columns={columns} rows={rows} totals={totals} rowKey={rowKey} onRowClick={onRow} />
    </Card>
  );
}

const dateRange = (range, setRange) => (
  <div className="flex flex-wrap gap-2">
    <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
    <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
  </div>
);

function useReport(path, params, enabled = true) {
  return useQuery({ queryKey: ['report', path, params], queryFn: () => get(`/reports/${path}${queryString(params)}`), enabled });
}

const Wrap = ({ query, children }) => {
  if (query.isLoading) return <Spinner />;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (!query.data) return null;
  return children(query.data);
};

const Balanced = ({ ok }) => <Badge value={ok ? 'Balanced' : 'NOT BALANCED'} tone={ok ? 'ok' : 'danger'} />;

function TrialBalance() {
  const [range, setRange] = useState({ from: fyStart(), to: todayIso() });
  const query = useReport('trial-balance', range);
  const columns = [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account', wrap: true }, money('openingDebitPaise', 'Opening Dr'), money('openingCreditPaise', 'Opening Cr'), money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), money('closingDebitPaise', 'Closing Dr'), money('closingCreditPaise', 'Closing Cr')];
  return (
    <>
      {dateRange(range, setRange)}
      <Wrap query={query}>{(d) => (
        <>
          <Balanced ok={d.balanced} />
          <Section title="Trial balance" name="trial-balance" columns={columns} rows={d.rows} rowKey={(r) => r.code} totals={totalsFrom(d.totals, Object.keys(d.totals))} />
        </>
      )}</Wrap>
    </>
  );
}

function ProfitAndLoss() {
  const [range, setRange] = useState({ from: fyStart(), to: todayIso() });
  const query = useReport('profit-and-loss', range);
  const columns = [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account', wrap: true }, { key: 'group', label: 'Group' }, money('amountPaise', 'Amount')];
  return (
    <>
      {dateRange(range, setRange)}
      <Wrap query={query}>{(d) => (
        <>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Income" value={formatPaise(d.incomePaise)} />
            <Stat label="Expenses" value={formatPaise(d.expensePaise)} />
            <Stat label="Profit" value={formatPaise(d.profitPaise)} tone={d.profitPaise < 0 ? 'danger' : undefined} />
          </div>
          <Section title="Income" columns={columns} rows={d.income} rowKey={(r) => r.code} totals={{ amountPaise: formatPaise(d.incomePaise) }} />
          <Section title="Expenses" columns={columns} rows={d.expenses} rowKey={(r) => r.code} totals={{ amountPaise: formatPaise(d.expensePaise) }} />
        </>
      )}</Wrap>
    </>
  );
}

function BalanceSheet() {
  const [asOf, setAsOf] = useState(todayIso());
  const query = useReport('balance-sheet', { asOf });
  const columns = [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Account', wrap: true }, { key: 'group', label: 'Group' }, money('amountPaise', 'Amount')];
  return (
    <>
      <Field label="As of" className="max-w-48"><Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
      <Wrap query={query}>{(d) => (
        <>
          <Balanced ok={d.balanced} />
          <Section title="Assets" columns={columns} rows={d.assets} rowKey={(r) => r.code} totals={{ amountPaise: formatPaise(d.assetsPaise) }} />
          <Section title="Liabilities" columns={columns} rows={d.liabilities} rowKey={(r) => r.code} totals={{ amountPaise: formatPaise(d.liabilitiesPaise) }} />
          <Section title="Equity" columns={columns} rows={d.equity} rowKey={(r) => r.code} totals={{ amountPaise: formatPaise(d.equityPaise) }} />
        </>
      )}</Wrap>
    </>
  );
}

function Ledger() {
  const [code, setCode] = useState('1120');
  const [range, setRange] = useState({ from: fyStart(), to: todayIso() });
  const query = useReport('ledger', { code, ...range }, Boolean(code));
  const columns = [{ key: 'postingDate', label: 'Date', render: (r) => formatDate(r.postingDate) }, { key: 'voucherNo', label: 'Voucher' }, { key: 'narration', label: 'Narration', wrap: true }, money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), money('balancePaise', 'Balance')];
  return (
    <>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Account" className="w-72"><RefPicker endpoint="/accounts" valueKey="code" labelOf={(r) => `${r.code} · ${r.name}`} value={code} onChange={setCode} /></Field>
        {dateRange(range, setRange)}
      </div>
      <Wrap query={query}>{(d) => (
        <>
          <div className="grid grid-cols-2 gap-3"><Stat label="Opening" value={formatPaise(d.openingPaise)} /><Stat label="Closing" value={formatPaise(d.closingPaise)} /></div>
          {d.truncated && <ErrorBox error={{ message: 'Only the first 5,000 entries are shown. Narrow the dates.' }} />}
          <Section title={`${d.account.code} · ${d.account.name}`} name={`ledger-${d.account.code}`} columns={columns} rows={d.rows} />
        </>
      )}</Wrap>
    </>
  );
}

function Ageing({ kind }) {
  const query = useReport('ageing', { kind });
  const columns = [{ key: 'partyName', label: 'Party', wrap: true }, money('d0to30Paise', '0 to 30 days'), money('d31to60Paise', '31 to 60'), money('d61to90Paise', '61 to 90'), money('over90Paise', 'Over 90'), money('outstandingPaise', 'Unpaid'), money('advancePaise', 'Advance held')];
  return <Wrap query={query}>{(d) => <Section title={kind === 'RECEIVABLE' ? 'What customers owe' : 'What we owe suppliers'} name={`ageing-${kind}`} columns={columns} rows={d.rows} rowKey={(r) => r.partyId} totals={totalsFrom(d.totals, Object.keys(d.totals))} />}</Wrap>;
}

function Stock() {
  const query = useReport('stock-balance', {});
  const columns = [{ key: 'itemCode', label: 'Code' }, { key: 'itemName', label: 'Item', wrap: true }, { key: 'warehouseName', label: 'Warehouse' }, { key: 'lot', label: 'Heat or batch' }, { key: 'serialNo', label: 'Set aside for' }, qty('qtyMilli', 'Qty'), { key: 'uom', label: 'Unit' }, money('valuePaise', 'Value')];
  return <Wrap query={query}>{(d) => <Section title="Stock on hand" name="stock" columns={columns} rows={d.rows} totals={{ valuePaise: formatPaise(d.totals.valuePaise) }} />}</Wrap>;
}

function StockLedger() {
  const [itemId, setItemId] = useState('');
  const query = useReport('stock-ledger', { itemId }, Boolean(itemId));
  const columns = [{ key: 'postingDate', label: 'Date', render: (r) => formatDate(r.postingDate) }, { key: 'voucherNo', label: 'Voucher' }, { key: 'warehouseName', label: 'Warehouse' }, { key: 'lot', label: 'Heat or batch' }, qty('qtyMilli', 'Qty'), money('valuePaise', 'Value'), qty('balanceQtyMilli', 'Balance'), money('balanceValuePaise', 'Balance value')];
  return (
    <>
      <Field label="Item" className="max-w-md"><RefPicker endpoint="/items" labelOf={(r) => `${r.code} · ${r.name}`} value={itemId} onChange={setItemId} /></Field>
      {itemId && <Wrap query={query}>{(d) => <Section title="Stock ledger" columns={columns} rows={d.rows} />}</Wrap>}
    </>
  );
}

function LotTrace() {
  const [text, setText] = useState('');
  const [lot, setLot] = useState('');
  const query = useReport('trace-lot', { lot }, Boolean(lot));
  return (
    <>
      <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setLot(text.trim()); }}>
        <Field label="Heat or batch no."><Input value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <Button type="submit" variant="primary">Trace</Button>
      </form>
      {lot && <Wrap query={query}>{(d) => (
        <>
          <Section title="Received from" rowKey={(r) => r.grnNo + r.itemCode} columns={[{ key: 'grnNo', label: 'Receipt' }, { key: 'partyName', label: 'Supplier' }, { key: 'postingDate', label: 'Date', render: (r) => formatDate(r.postingDate) }, { key: 'itemCode', label: 'Item' }, qty('qtyMilli', 'Qty'), { key: 'certRef', label: 'Certificate' }]} rows={d.receivedFrom} />
          <Section title="Used in machines" rowKey={(r) => r.issueNo + r.itemCode} columns={[{ key: 'serialNo', label: 'Machine' }, { key: 'issueNo', label: 'Issue' }, { key: 'postingDate', label: 'Date', render: (r) => formatDate(r.postingDate) }, { key: 'itemCode', label: 'Item' }, qty('qtyMilli', 'Qty')]} rows={d.usedIn} />
        </>
      )}</Wrap>}
    </>
  );
}

function JobWork() {
  const query = useReport('job-work', {});
  const columns = [{ key: 'docNo', label: 'Challan' }, { key: 'partyName', label: 'Job worker', wrap: true }, { key: 'process', label: 'Process' }, { key: 'itemCode', label: 'Item' }, qty('pendingMilli', 'Still out'), { key: 'sentOn', label: 'Sent', render: (r) => formatDate(r.sentOn) }, { key: 'returnBy', label: 'Return by', render: (r) => formatDate(r.returnBy) }, { key: 'daysLeft', label: 'Days left', align: 'right', render: (r) => <span className={r.isOverdue ? 'font-semibold text-danger' : ''}>{r.daysLeft}</span> }];
  return <Wrap query={query}>{(d) => <Section title="Goods at job workers (GST rule 45)" name="job-work" columns={columns} rows={d.rows} />}</Wrap>;
}

const gstColumns = [{ key: 'docNo', label: 'Invoice' }, { key: 'postingDate', label: 'Date', render: (r) => formatDate(r.postingDate) }, { key: 'partyName', label: 'Party', wrap: true }, { key: 'partyGstin', label: 'GSTIN' }, { key: 'placeOfSupply', label: 'Place' }, money('taxablePaise', 'Taxable'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST'), money('totalPaise', 'Total')];

const hsnColumns = [{ key: 'hsn', label: 'HSN' }, { key: 'gstRateBps', label: 'Rate', align: 'right', render: (r) => formatBps(r.gstRateBps) }, { key: 'uom', label: 'Unit' }, qty('qtyMilli', 'Qty'), money('taxablePaise', 'Taxable'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST')];
const noteColumns = [{ key: 'docNo', label: 'Note' }, { key: 'invoiceNo', label: 'Invoice' }, { key: 'partyName', label: 'Party', wrap: true }, { key: 'partyGstin', label: 'GSTIN' }, { key: 'reason', label: 'Reason', wrap: true }, money('taxablePaise', 'Taxable'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST')];

function Gstr1() {
  const [range, setRange] = useState({ from: `${todayIso().slice(0, 7)}-01`, to: todayIso() });
  const query = useReport('gstr1', range);
  const rowKey = (r) => r.docNo;
  const hsnKey = (r) => `${r.hsn}${r.gstRateBps}`;
  return (
    <>
      {dateRange(range, setRange)}
      <Wrap query={query}>{(d) => (
        <>
          <p className="text-sm text-steel">Working papers to check before you file. The figures here are not uploaded anywhere.</p>
          <Section title="4: Registered buyers (B2B)" name="gstr1-b2b" rowKey={rowKey} columns={gstColumns} rows={d.b2b} />
          <Section title="5: Large sales to unregistered buyers (B2CL)" name="gstr1-b2cl" rowKey={rowKey} columns={gstColumns} rows={d.b2cl} />
          <Section title="6: Exports" name="gstr1-exports" rowKey={rowKey} columns={[...gstColumns, { key: 'withPayment', label: 'With IGST', render: (r) => (r.withPayment ? 'Yes' : 'No') }, { key: 'shippingBillNo', label: 'Shipping bill' }, { key: 'lutNumber', label: 'LUT' }]} rows={d.exports} />
          <Section title="6: SEZ supplies" name="gstr1-sez" rowKey={rowKey} columns={gstColumns} rows={d.sez} />
          <Section title="7: Other sales to unregistered buyers (B2CS)" name="gstr1-b2cs" rowKey={(r) => `${r.placeOfSupply}${r.gstRateBps}`} columns={[{ key: 'placeOfSupply', label: 'Place' }, { key: 'gstRateBps', label: 'Rate', align: 'right', render: (r) => formatBps(r.gstRateBps) }, money('taxablePaise', 'Taxable'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST'), money('igstPaise', 'IGST')]} rows={d.b2cs} />
          <Section title="8: Nil-rated, exempt and non-GST" name="gstr1-nil" rowKey={(r) => r.heading} columns={[{ key: 'heading', label: 'Supply', wrap: true }, money('nilPaise', 'Nil-rated'), money('exemptPaise', 'Exempt'), money('nonGstPaise', 'Non-GST')]} rows={d.nil} />
          <Section title="9B: Credit notes, registered" name="gstr1-cdnr" rowKey={rowKey} columns={noteColumns} rows={d.cdnr} />
          <Section title="9B: Credit notes, unregistered" name="gstr1-cdnur" rowKey={rowKey} columns={noteColumns} rows={d.cdnur} />
          <Section title="12: HSN summary, registered buyers" name="gstr1-hsn-b2b" rowKey={hsnKey} columns={hsnColumns} rows={d.hsnB2b} />
          <Section title="12: HSN summary, others" name="gstr1-hsn-b2c" rowKey={hsnKey} columns={hsnColumns} rows={d.hsnB2c} />
          <Card title="13: Documents issued">
            <p className="p-4 text-sm">Invoices: {d.documents.issued} issued, {d.documents.cancelled} cancelled{d.documents.firstNo ? `, ${d.documents.firstNo} to ${d.documents.lastNo}` : ''}.<br />Credit notes: {d.creditNoteDocuments.issued} issued, {d.creditNoteDocuments.cancelled} cancelled{d.creditNoteDocuments.firstNo ? `, ${d.creditNoteDocuments.firstNo} to ${d.creditNoteDocuments.lastNo}` : ''}.</p>
          </Card>
        </>
      )}</Wrap>
    </>
  );
}

function Gstr3b() {
  const [range, setRange] = useState({ from: `${todayIso().slice(0, 7)}-01`, to: todayIso() });
  const query = useReport('gstr3b', range);
  const columns = [{ key: 'label', label: 'Table', wrap: true }, money('taxablePaise', 'Taxable'), money('igstPaise', 'IGST'), money('cgstPaise', 'CGST'), money('sgstPaise', 'SGST')];
  const zero = { taxablePaise: 0, igstPaise: 0, cgstPaise: 0, sgstPaise: 0 };
  return (
    <>
      {dateRange(range, setRange)}
      <Wrap query={query}>{(d) => (
        <>
          <p className="text-sm text-steel">Working papers to check before you file. Your CA should confirm the table mapping.</p>
          <Section
            title="3.1: Outward supplies and reverse charge"
            name="gstr3b-31"
            rowKey={(r) => r.label}
            columns={columns}
            rows={[
              { label: '(a) Taxable outward supplies', ...d.outward },
              { label: '(b) Zero-rated: exports and SEZ', ...d.zeroRated },
              { label: '(c) Nil-rated and exempt', ...zero, taxablePaise: d.nilExemptPaise },
              { label: '(d) Inward supplies on reverse charge', ...d.reverseCharge },
              { label: '(e) Non-GST', ...zero, taxablePaise: d.nonGstPaise },
            ]}
          />
          <Section title="3.2: Inter-state sales to unregistered buyers" name="gstr3b-32" rowKey={(r) => r.placeOfSupply} columns={[{ key: 'placeOfSupply', label: 'Place' }, money('taxablePaise', 'Taxable'), money('igstPaise', 'IGST')]} rows={d.unregisteredByState} />
          <Section
            title="4: Input tax credit"
            name="gstr3b-4"
            rowKey={(r) => r.label}
            columns={columns.filter((c) => c.key !== 'taxablePaise')}
            rows={[
              { label: '4(A)(1) Import of goods', ...zero, ...d.itcImports },
              { label: '4(A)(3) Inward on reverse charge', ...zero, ...d.itcReverseCharge },
              { label: '4(A)(5) All other', ...zero, ...d.itcOther },
              { label: '4(B)(1) Reversed: blocked', ...zero, ...d.itcBlocked },
              { label: '4(C) Net credit available', ...zero, ...d.itc },
            ]}
          />
          <Card title="5: Exempt inward supplies"><p className="num p-4 text-sm">{formatPaise(d.inwardExemptPaise)}</p></Card>
          <Section
            title="6: Payment"
            name="gstr3b-6"
            rowKey={(r) => r.label}
            columns={[{ key: 'label', label: 'How', wrap: true }, money('igst', 'IGST'), money('cgst', 'CGST'), money('sgst', 'SGST')]}
            rows={[
              { label: 'Credit used, by the head it came from', ...d.setOff.used },
              { label: 'Paid in cash', ...d.setOff.cash },
              { label: 'Credit carried forward', ...d.setOff.creditLeft },
              { label: 'Reverse charge, always in cash', igst: d.reverseChargeCash.igstPaise, cgst: d.reverseChargeCash.cgstPaise, sgst: d.reverseChargeCash.sgstPaise },
            ]}
          />
        </>
      )}</Wrap>
    </>
  );
}

function Integrity() {
  const query = useReport('integrity', {});
  return (
    <Wrap query={query}>{(d) => (
      <Card title={d.ok ? 'All checks pass' : 'A check has failed'} actions={<Button onClick={() => query.refetch()}>Run again</Button>}>
        <ul className="divide-y divide-line">
          {d.checks.map((check) => (
            <li key={check.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span><strong>{check.id}</strong> {check.name}<br /><span className="text-steel">{check.message}</span></span>
              <Badge value={check.ok ? 'Pass' : 'Fail'} tone={check.ok ? 'ok' : 'danger'} />
            </li>
          ))}
        </ul>
      </Card>
    )}</Wrap>
  );
}

const REPORTS = {
  stock: { title: 'Stock on hand', perm: 'reports.operations', view: Stock },
  'stock-ledger': { title: 'Stock ledger', perm: 'reports.operations', view: StockLedger },
  'lot-trace': { title: 'Trace a heat or batch', perm: 'reports.operations', view: LotTrace },
  'job-work': { title: 'Goods at job workers', perm: 'reports.operations', view: JobWork },
  'trial-balance': { title: 'Trial balance', perm: 'reports.finance', view: TrialBalance },
  'profit-and-loss': { title: 'Profit and loss', perm: 'reports.finance', view: ProfitAndLoss },
  'balance-sheet': { title: 'Balance sheet', perm: 'reports.finance', view: BalanceSheet },
  ledger: { title: 'Account ledger', perm: 'reports.finance', view: Ledger },
  receivable: { title: 'What customers owe', perm: 'reports.finance', view: () => <Ageing kind="RECEIVABLE" /> },
  payable: { title: 'What we owe suppliers', perm: 'reports.finance', view: () => <Ageing kind="PAYABLE" /> },
  gstr1: { title: 'GSTR-1 working', perm: 'reports.finance', view: Gstr1 },
  gstr3b: { title: 'GSTR-3B working', perm: 'reports.finance', view: Gstr3b },
  integrity: { title: 'Integrity checks', perm: 'reports.finance', view: Integrity },
};

// Every report, by the area it belongs to, with one box to find any of them.
export function ReportsIndex() {
  const { can } = useAuth();
  const meta = useMeta();
  const [q, setQ] = useState('');
  const apps = buildApps(can, meta).filter((app) => app.reports.length > 0);
  const word = q.trim().toLowerCase();
  return (
    <>
      <PageHeader title="Reports" actions={<Link to="/report-builder"><Button variant="primary">Build a report</Button></Link>} />
      <Input aria-label="Find a report" placeholder="Find a report" className="mb-4 max-w-sm" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="space-y-4">
        {apps.map((app) => {
          const rows = app.reports.filter((r) => !word || r.label.toLowerCase().includes(word));
          if (rows.length === 0) return null;
          return (
            <Card key={app.key} title={app.label}>
              <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                {rows.map((r) => <li key={r.to} className="border-b border-line"><Link to={r.to} className="block px-4 py-2.5 text-sm hover:bg-paper">{r.label}</Link></li>)}
              </ul>
            </Card>
          );
        })}
      </div>
    </>
  );
}

export function ReportPage() {
  const { report } = useParams();
  const { can } = useAuth();
  const config = REPORTS[report];
  if (!config) return <ErrorBox error={{ message: 'That report does not exist.' }} />;
  if (!can(config.perm)) return <ErrorBox error={{ message: 'You do not have permission to see this.' }} />;
  const View = config.view;
  return (
    <>
      <PageHeader title={config.title} back={{ to: '/reports', label: 'All reports' }} />
      <div className="space-y-4"><View /></div>
    </>
  );
}

