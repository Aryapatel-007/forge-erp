import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { get, getList, patch, post } from '../api/client.js';
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Spinner } from '../components/ui.jsx';
import { useAuth } from '../context/Auth.jsx';
import { formatDate, formatQty, parseScaled, unscale } from '../utils/format.js';
import { Letterhead } from './generic/PrintPage.jsx';

export function FatPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const protocol = useQuery({ queryKey: ['doc', 'fat', id], queryFn: () => get(`/fat/${id}`) });
  const gauges = useQuery({ queryKey: ['gauges-active'], queryFn: () => getList('/gauges?isActive=true&limit=200') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => get('/admin/settings') });
  const [form, setForm] = useState(null);
  const [localError, setLocalError] = useState(null);

  useEffect(() => {
    if (!protocol.data) return;
    const p = protocol.data;
    setForm({
      witnessName: p.witnessName,
      witnessCompany: p.witnessCompany,
      testedByName: p.testedByName,
      gaugeIds: p.gaugeIds,
      results: Object.fromEntries(p.results.map((r) => [r.id, { observed: unscale(r.observedMilli, 3), observedText: r.observedText, result: r.result }])),
    });
  }, [protocol.data]);

  const buildPayload = () => ({
    witnessName: form.witnessName,
    witnessCompany: form.witnessCompany,
    testedByName: form.testedByName,
    gaugeIds: form.gaugeIds,
    results: Object.entries(form.results).map(([rowId, row]) => {
      const observedMilli = parseScaled(row.observed, 3, { allowNegative: true });
      if (row.observed !== '' && observedMilli === null) throw new Error(`"${row.observed}" is not a number.`);
      return { id: rowId, observedMilli, observedText: row.observedText, result: row.result };
    }),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['doc', 'fat', id] });
    queryClient.invalidateQueries({ queryKey: ['list', 'fat'] });
  };
  const save = useMutation({ mutationFn: (body) => patch(`/fat/${id}`, body), onSuccess: refresh });
  const close = useMutation({
    mutationFn: async (body) => {
      await patch(`/fat/${id}`, body);
      return post(`/fat/${id}/close`);
    },
    onSuccess: refresh,
  });

  if (protocol.isLoading) return <Spinner />;
  if (protocol.isError) return <ErrorBox error={protocol.error} />;
  const p = protocol.data;
  const isDraft = p.status === 'DRAFT';
  const editable = isDraft && can('fat.write');
  if (!form) return <Spinner />;

  const run = (mutation) => {
    setLocalError(null);
    mutation.reset();
    try {
      mutation.mutate(buildPayload());
    } catch (error) {
      setLocalError(error);
    }
  };
  const setRow = (rowId, key, value) => setForm({ ...form, results: { ...form.results, [rowId]: { ...form.results[rowId], [key]: value } } });

  return (
    <>
      <PageHeader
        back={{ to: '/fat', label: 'FAT protocols' }}
        title={p.docNo ?? `FAT for ${p.serialNo}`}
        subtitle={<><Badge value={p.status} /> <span className="ml-1">{p.serialNo}, attempt {p.attempt}, {formatDate(p.postingDate)}</span></>}
        actions={(
          <>
            <Button onClick={() => navigate(`/builds/${p.buildId}`)}>Open machine</Button>
            <Button onClick={() => window.print()}>Print</Button>
            {editable && <Button disabled={save.isPending} onClick={() => run(save)}>Save</Button>}
            {editable && <Button variant="primary" disabled={close.isPending} onClick={() => run(close)}>Close protocol</Button>}
          </>
        )}
      />
      {settings.data && <div className="mb-3 hidden print:block"><Letterhead settings={settings.data} title="Factory acceptance test" number={`${p.docNo ?? 'Draft'} · ${p.serialNo}`} /></div>}
      <div className="space-y-4">
        <ErrorBox error={localError ?? save.error ?? close.error} />
        <Card className="p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label="Witness *"><Input disabled={!editable} value={form.witnessName} onChange={(e) => setForm({ ...form, witnessName: e.target.value })} /></Field>
            <Field label="Witness company"><Input disabled={!editable} value={form.witnessCompany} onChange={(e) => setForm({ ...form, witnessCompany: e.target.value })} /></Field>
            <Field label="Tested by"><Input disabled={!editable} value={form.testedByName} onChange={(e) => setForm({ ...form, testedByName: e.target.value })} /></Field>
          </div>
          <fieldset className="mt-3">
            <legend className="mb-1 text-xs font-medium text-steel">Instruments used * (each must be in calibration)</legend>
            <div className="flex flex-wrap gap-3">
              {(gauges.data?.data ?? []).map((gauge) => (
                <label key={gauge.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="size-5"
                    disabled={!editable}
                    checked={form.gaugeIds.includes(gauge.id)}
                    onChange={(e) => setForm({ ...form, gaugeIds: e.target.checked ? [...form.gaugeIds, gauge.id] : form.gaugeIds.filter((g) => g !== gauge.id) })}
                  />
                  {gauge.code} · {gauge.name}{gauge.dueOn ? `, due ${formatDate(gauge.dueOn)}` : ''}
                </label>
              ))}
            </div>
          </fieldset>
        </Card>
        <Card title="Checks">
          <ul className="divide-y divide-line">
            {p.results.map((row) => {
              const state = form.results[row.id];
              const hasLimits = row.minMilli !== null || row.maxMilli !== null;
              return (
                <li key={row.id} className="grid grid-cols-2 items-start gap-3 p-3 md:grid-cols-6">
                  <div className="col-span-2 md:col-span-3">
                    <div className="text-sm font-medium">{row.parameter}{row.isCritical && <span className="ml-1 text-xs text-danger">critical</span>}</div>
                    <div className="text-xs text-steel">{row.acceptance}{hasLimits && ` (${row.minMilli !== null ? formatQty(row.minMilli) : ''} to ${row.maxMilli !== null ? formatQty(row.maxMilli) : ''} ${row.unit})`}</div>
                  </div>
                  <Field label={hasLimits ? `Measured, ${row.unit}` : 'Observed'}>
                    {hasLimits
                      ? <Input className="num" inputMode="decimal" disabled={!editable} value={state.observed} onChange={(e) => setRow(row.id, 'observed', e.target.value)} />
                      : <Input disabled={!editable} value={state.observedText} onChange={(e) => setRow(row.id, 'observedText', e.target.value)} />}
                  </Field>
                  <Field label="Result">
                    <Select disabled={!editable} value={state.result} onChange={(e) => setRow(row.id, 'result', e.target.value)}>
                      <option value="">Choose</option>
                      <option value="PASS">Pass</option>
                      <option value="FAIL">Fail</option>
                      {!row.isCritical && <option value="NA">Not applicable</option>}
                    </Select>
                  </Field>
                </li>
              );
            })}
          </ul>
        </Card>
        <div className="mt-12 hidden justify-between text-xs print:flex">
          <div className="border-t border-ink pt-1">Tested by: {p.testedByName}</div>
          <div className="border-t border-ink pt-1">Witness: {p.witnessName}, {p.witnessCompany}</div>
        </div>
      </div>
    </>
  );
}
