import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { get } from '../../api/client.js';
import { Button, ErrorBox, Select, Spinner, Table } from '../../components/ui.jsx';
import { useResource } from '../../config/useResource.js';
import { NotFoundPage } from '../../components/NotFoundPage.jsx';
import { paiseInWords } from '../../utils/format.js';
import { Summary, Totals } from './DetailPage.jsx';

export function Letterhead({ settings, title, number, letterHead }) {
  return (
    <header className="flex items-start justify-between gap-4 border-b-2 border-ink pb-3">
      <div>
        <div className="text-lg font-bold">{settings.legalName}</div>
        {letterHead?.headerText
          ? <div className="whitespace-pre-wrap text-xs">{letterHead.headerText}</div>
          : (
            <>
              <div className="whitespace-pre-wrap text-xs">{settings.address}</div>
              <div className="text-xs">{settings.gstin && `GSTIN ${settings.gstin}`}{settings.pan && ` · PAN ${settings.pan}`}</div>
              <div className="text-xs">{settings.phone} {settings.email}</div>
            </>
          )}
      </div>
      <div className="text-right">
        <div className="text-base font-bold">{title}</div>
        <div className="num text-sm">{number}</div>
      </div>
    </header>
  );
}

// {{key}} in a text block is replaced by that field, always as plain text.
const fillText = (text, row, config) => String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
  const item = (config.summary ?? []).find((s) => s.key === key);
  const value = row._labels?.[key] ?? row[key];
  if (value === undefined || value === null) return '';
  return item?.format ? item.format(value, row) : String(value);
});

function FormatBlock({ block, row, config, columns, settings }) {
  const keys = String(block.fields ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  switch (block.kind) {
    case 'HEADING': return <h2 className="mt-3 px-4 text-base font-semibold">{fillText(block.text, row, config)}</h2>;
    case 'TEXT': return <p className="mt-2 whitespace-pre-wrap px-4 text-sm">{fillText(block.text, row, config)}</p>;
    case 'FIELDS': return <Summary items={keys.length ? (config.summary ?? []).filter((item) => keys.includes(item.key)) : config.summary ?? []} doc={row} />;
    case 'LINES': return columns.length > 0 ? <Table columns={keys.length ? columns.filter((c) => keys.includes(c.key)) : columns} rows={row.lines ?? []} /> : null;
    case 'TABLE': {
      const table = (config.extraTables ?? []).find((t) => t.key === block.tableKey);
      if (!table || !row[table.key]?.length) return null;
      return (
        <div className="mt-3">
          <h3 className="px-3 text-sm font-semibold">{block.text || table.title}</h3>
          <Table columns={table.columns.map((c) => (c.render ? { ...c, render: (r) => c.render(r, row) } : c))} rows={row[table.key]} rowKey={table.rowKey} />
        </div>
      );
    }
    case 'TOTALS': return <Totals items={config.totals} doc={row} />;
    case 'WORDS': return row.totalPaise ? <p className="px-4 text-sm"><strong>Amount in words:</strong> {paiseInWords(row.totalPaise)}</p> : null;
    case 'SIGNATURE':
      return (
        <div className="mt-12 flex justify-end px-4 text-xs">
          <div className="text-center">
            <div className="mb-10">For {settings.legalName}</div>
            <div className="border-t border-ink pt-1">{block.text || 'Authorised signatory'}</div>
          </div>
        </div>
      );
    case 'SPACER': return <div className="h-6" />;
    default: return null;
  }
}

export function PrintPage() {
  const { resource, id } = useParams();
  const config = useResource(resource);
  const navigate = useNavigate();
  const doc = useQuery({ queryKey: ['doc', resource, id], queryFn: () => get(`${config.endpoint}/${id}`), enabled: Boolean(config) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/admin/settings') });
  const options = useQuery({ queryKey: ['print-formats', resource], queryFn: () => get(`/views/print-formats/${resource}`), retry: false });
  const [chosen, setChosen] = useState(null);

  if (!config) return <NotFoundPage />;
  if (doc.isLoading || settings.isLoading) return <Spinner />;
  if (doc.error || settings.error) return <ErrorBox error={doc.error ?? settings.error} />;
  const row = doc.data;
  const columns = (config.lineColumns ?? []).map((column) => (column.render ? { ...column, render: (line) => column.render(line, row) } : column));
  const isDraft = row.status === 'DRAFT';
  const formats = options.data?.formats ?? [];
  const format = chosen === 'standard' ? null : formats.find((f) => f.id === chosen) ?? (chosen ? null : formats.find((f) => f.isDefault));
  const letterHeads = options.data?.letterHeads ?? [];
  const letterHead = letterHeads.find((l) => l.id === format?.letterHeadId) ?? letterHeads.find((l) => l.isDefault);

  return (
    <div className="no-translate mx-auto max-w-4xl bg-white p-6">
      <div className="no-print mb-4 flex gap-2">
        <Button variant="primary" onClick={() => window.print()}>Print</Button>
        <Button onClick={() => navigate(-1)}>Back</Button>
        {formats.length > 0 && (
          <Select aria-label="Print format" className="w-auto" value={format?.id ?? 'standard'} onChange={(e) => setChosen(e.target.value)}>
            <option value="standard">Standard</option>
            {formats.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </Select>
        )}
      </div>
      {isDraft && <p className="mb-2 text-center font-bold text-danger">DRAFT: NOT A VALID DOCUMENT</p>}
      {row.status === 'CANCELLED' && <p className="mb-2 text-center font-bold text-danger">CANCELLED</p>}
      {format?.hideLetterhead
        ? <div className="flex justify-end pb-3 pt-28 text-right"><div><div className="text-base font-bold">{config.printTitle}</div><div className="num text-sm">{row.docNo ?? 'Draft'}</div></div></div>
        : <Letterhead settings={settings.data} title={config.printTitle} number={row.docNo ?? 'Draft'} letterHead={letterHead} />}
      {resource === 'salesInvoices' && <p className="mt-1 text-right text-xs">Original for recipient</p>}
      {format?.blocks?.length > 0
        ? format.blocks.map((block, index) => <FormatBlock key={block.id ?? index} block={block} row={row} config={config} columns={columns} settings={settings.data} />)
        : <>
      <Summary items={config.summary ?? []} doc={row} />
      {row.isExport && row.lutNumber && <p className="px-4 text-xs">Supply meant for export under LUT without payment of IGST. LUT {row.lutNumber}.</p>}
      {columns.length > 0 && <Table columns={columns} rows={row.lines} />}
      {(config.extraTables ?? []).filter((t) => row[t.key]?.length).map((table) => (
        <div key={table.key} className="mt-3">
          <h3 className="px-3 text-sm font-semibold">{table.title}</h3>
          <Table columns={table.columns.map((c) => (c.render ? { ...c, render: (r) => c.render(r, row) } : c))} rows={row[table.key]} rowKey={table.rowKey} />
        </div>
      ))}
      <Totals items={config.totals} doc={row} />
      {config.showAmountInWords && row.currency === 'INR' && <p className="px-4 text-sm"><strong>Amount in words:</strong> {paiseInWords(row.totalPaise)}</p>}
      {config.noteKey && row[config.noteKey] && <p className="mt-3 whitespace-pre-wrap px-4 text-xs">{row[config.noteKey]}</p>}
      {resource === 'salesInvoices' && settings.data.bankDetails && <p className="mt-3 px-4 text-xs"><strong>Bank:</strong> {settings.data.bankDetails}</p>}
      <div className="mt-12 flex justify-end px-4 text-xs">
        <div className="text-center">
          <div className="mb-10">For {settings.data.legalName}</div>
          <div className="border-t border-ink pt-1">Authorised signatory</div>
        </div>
      </div>
      </>}
      {!format?.hideLetterhead && letterHead?.footerText && <p className="mt-6 whitespace-pre-wrap border-t border-line pt-2 text-center text-xs">{letterHead.footerText}</p>}
    </div>
  );
}
