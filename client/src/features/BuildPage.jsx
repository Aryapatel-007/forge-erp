import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, getList, post, queryString } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner, Stat, StatusSteps, Table } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatBps, formatDate, formatDateTime, formatPaise, formatQty, humanise, todayIso } from '../utils/format.js';
import { ActionDialog } from './generic/ActionDialog.jsx';
import { Summary } from './generic/DetailPage.jsx';

const BUILD_PATH = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT', 'READY', 'DISPATCHED', 'INSTALLED', 'CLOSED'];

const MANUAL = ['PLANNED', 'PROCUREMENT', 'FABRICATION', 'ASSEMBLY', 'FAT'];
const qty = (key, label) => ({ key, label, align: 'right', render: (row) => formatQty(row[key]) });

export function BuildPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);

  const build = useQuery({ queryKey: ['doc', 'builds', id], queryFn: () => get(`/builds/${id}`) });
  const shortages = useQuery({ queryKey: ['shortages', id], queryFn: () => get(`/builds/${id}/shortages`) });
  const cost = useQuery({ queryKey: ['cost', id], queryFn: () => get(`/builds/${id}/cost-sheet`), enabled: can('reports.finance') });
  const fats = useQuery({ queryKey: ['build-fat', id], queryFn: () => getList(`/fat${queryString({ buildId: id })}`), enabled: can('fat.read') });
  const ncrs = useQuery({ queryKey: ['build-ncr', id], queryFn: () => getList(`/ncrs${queryString({ buildId: id })}`), enabled: can('ncrs.read') });

  const refresh = () => {
    for (const key of [['doc', 'builds', id], ['shortages', id], ['cost', id], ['build-fat', id], ['build-ncr', id], ['dashboard']]) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const act = useMutation({
    mutationFn: ({ path, body }) => post(`/builds/${id}/${path}`, body),
    onSuccess: (result, variables) => {
      refresh();
      setDialog(null);
      if (variables.path === 'fat') navigate(`/fat/${result.id}`);
    },
  });

  if (build.isLoading) return <Spinner />;
  if (build.isError) return <ErrorBox error={build.error} />;
  const b = build.data;
  const isOpen = MANUAL.includes(b.stage);
  const open = (spec) => { act.reset(); setDialog(spec); };

  const actions = (
    <>
      {isOpen && can('issues.write') && <Link to={`/materialIssues/new?buildId=${id}`}><Button>Issue material</Button></Link>}
      {isOpen && can('time.write') && <Link to="/timeBookings/new"><Button>Book labour</Button></Link>}
      {isOpen && can('builds.write') && (
        <Button onClick={() => open({
          title: 'Change stage',
          fields: [
            { key: 'stage', label: 'Stage', type: 'select', required: true, default: b.stage, options: MANUAL.map((value) => ({ value, label: humanise(value) })) },
            { key: 'note', label: 'Note', type: 'textarea' },
          ],
          confirmLabel: 'Change stage',
          run: (body) => act.mutate({ path: 'stage', body }),
        })}
        >Change stage</Button>
      )}
      {isOpen && b.fatStatus !== 'PASSED' && can('fat.write') && (
        <Button onClick={() => open({
          title: 'Start a FAT',
          hint: 'The checklist comes from the BOM revision this machine was built to.',
          fields: [{ key: 'witnessName', label: 'Witness', type: 'text' }, { key: 'witnessCompany', label: 'Witness company', type: 'text', default: b.partyName }],
          confirmLabel: 'Start FAT',
          run: (body) => act.mutate({ path: 'fat', body }),
        })}
        >Start FAT</Button>
      )}
      {isOpen && b.fatStatus === 'PASSED' && can('builds.complete') && (
        <Button variant="primary" onClick={() => open({
          title: 'Finish this machine',
          hint: 'Moves all its cost into finished goods. It then cannot take more cost.',
          fields: [{ key: 'allowUnissued', label: 'Finish even if some BOM parts were not issued', type: 'check' }, { key: 'reason', label: 'If so, why?', type: 'textarea' }],
          confirmLabel: 'Finish machine',
          run: (body) => act.mutate({ path: 'complete', body }),
        })}
        >Finish machine</Button>
      )}
      {b.stage === 'READY' && can('salesInvoices.write') && (
        <Link to="/salesInvoices/new"><Button variant="primary">Invoice and dispatch</Button></Link>
      )}
      {b.stage === 'DISPATCHED' && can('builds.install') && (
        <Button variant="primary" onClick={() => open({
          title: 'Record installation',
          hint: 'The warranty runs from this date.',
          fields: [{ key: 'installedOn', label: 'Installed on', type: 'date', required: true, default: todayIso() }, { key: 'installedBy', label: 'Engineer', type: 'text', required: true }, { key: 'installationRef', label: 'SAT, IQ and OQ reference', type: 'text' }],
          confirmLabel: 'Record installation',
          run: (body) => act.mutate({ path: 'install', body }),
        })}
        >Record installation</Button>
      )}
      {['DISPATCHED', 'INSTALLED'].includes(b.stage) && can('service.write') && <Link to={`/tickets/new?buildId=${id}`}><Button>Service ticket</Button></Link>}
    </>
  );

  return (
    <>
      <PageHeader
        back={{ to: '/builds', label: 'Machine builds' }}
        title={b.serialNo}
        subtitle={(
          <>
            <div>{b.itemName}{b.partyName ? ` · ${b.partyName}` : ''}</div>
            <div className="mt-1.5"><StatusSteps steps={BUILD_PATH} current={b.stage} /></div>
          </>
        )}
        actions={actions}
      />
      <Link to={`/orders/${b.id}`} className="mb-4 flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm text-accent hover:shadow-md">
        <span className="min-w-0 flex-1"><b>Order journey</b> · every step from kick-off to handover, and which department has it now</span>
        <span aria-hidden="true">→</span>
      </Link>
      <div className="space-y-4">
        <ErrorBox error={!dialog ? act.error : null} />
        <Card>
          <Summary
            doc={b}
            items={[
              { key: 'partyName', label: 'Customer' }, { key: 'salesOrderNo', label: 'Order' }, { key: 'bomRevision', label: 'BOM revision' }, { key: 'targetDate', label: 'Due', format: formatDate }, { key: 'fatStatus', label: 'FAT', format: humanise }, { key: 'dispatchedOn', label: 'Dispatched', format: formatDate }, { key: 'installedOn', label: 'Installed', format: formatDate }, { key: 'installedBy', label: 'Engineer' }, { key: 'warrantyUntil', label: 'Warranty to', format: formatDate }, { key: 'installationRef', label: 'SAT, IQ and OQ ref.' },
            ]}
          />
        </Card>
        {cost.data && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Order value" value={formatPaise(cost.data.budgetPaise)} />
            <Stat label="Material" value={formatPaise(cost.data.materialCostPaise)} />
            <Stat label="Labour" value={formatPaise(cost.data.labourCostPaise)} />
            <Stat label="Job work and other" value={formatPaise(cost.data.otherCostPaise)} />
            <Stat label={`Margin${cost.data.marginBps !== null ? ` (${formatBps(cost.data.marginBps)})` : ''}`} value={formatPaise(cost.data.marginPaise)} tone={cost.data.marginPaise < 0 ? 'danger' : undefined} />
          </div>
        )}
        <Card
          title={shortages.data ? `Material: ${shortages.data.shortLines} part(s) short` : 'Material'}
          actions={isOpen && can('purchaseOrders.write') && <Link to="/purchaseOrders/new"><Button>Raise PO</Button></Link>}
        >
          {shortages.isLoading && <Spinner />}
          <ErrorBox error={shortages.error} />
          {shortages.data && (
            <Table
              rowKey={(r) => r.itemId}
              rows={shortages.data.rows}
              columns={[
                { key: 'itemName', label: 'Part', wrap: true, render: (r) => `${r.itemCode} · ${r.itemName}` },
                { key: 'uom', label: 'Unit' },
                qty('requiredMilli', 'Needed'), qty('issuedMilli', 'Issued'), qty('peggedMilli', 'Set aside'), qty('quarantineMilli', 'In QC'), qty('atJobWorkMilli', 'Job work'), qty('onOrderMilli', 'On order'), qty('freeMilli', 'Free'),
                { key: 'shortMilli', label: 'Short', align: 'right', render: (r) => <span className={r.shortMilli > 0 ? 'font-semibold text-danger' : ''}>{formatQty(r.shortMilli)}</span> },
              ]}
            />
          )}
        </Card>
        {fats.data?.data.length > 0 && (
          <Card title="FAT protocols">
            <Table rows={fats.data.data} onRowClick={(r) => navigate(`/fat/${r.id}`)} columns={[{ key: 'docNo', label: 'Number', render: (r) => r.docNo ?? 'Open' }, { key: 'attempt', label: 'Attempt' }, { key: 'witnessName', label: 'Witness' }, { key: 'status', label: 'Result', render: (r) => <Badge value={r.status} /> }]} />
          </Card>
        )}
        {ncrs.data?.data.length > 0 && (
          <Card title="Non-conformance">
            <Table rows={ncrs.data.data} onRowClick={(r) => navigate(`/ncrs/${r.id}`)} columns={[{ key: 'docNo', label: 'Number' }, { key: 'description', label: 'What went wrong', wrap: true }, { key: 'status', label: 'Status', render: (r) => <Badge value={r.status} /> }]} />
          </Card>
        )}
        <Card title="History">
          <ol className="divide-y divide-line">
            {[...b.stageHistory].reverse().map((row) => (
              <li key={row.id ?? `${row.at}-${row.stage}`} className="flex flex-wrap justify-between gap-2 px-4 py-2 text-sm">
                <span><Badge value={row.stage} /> {row.note}</span>
                <span className="text-steel">{row.byName}, {formatDateTime(row.at)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      {dialog && <ActionDialog {...dialog} error={act.error} isPending={act.isPending} onConfirm={dialog.run} onClose={() => setDialog(null)} />}
    </>
  );
}
