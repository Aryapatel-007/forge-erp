import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { get, patch, post } from '../../api/client.js';
import { Button, Card, ErrorBox, PageHeader, Spinner } from '../../components/ui.jsx';
import { useAllowed, useResource } from '../../config/useResource.js';
import { NotFoundPage } from '../../components/NotFoundPage.jsx';
import { FormField, initialValues, LinesEditor, toFormValue, toPayload } from './fields.jsx';

const noteInvoice = async (search) => {
  const kind = search.get('kind');
  const invoiceId = search.get('invoiceId');
  if (!invoiceId) return null;
  const invoice = await get(`${kind === 'DEBIT' ? '/purchase-invoices' : '/sales-invoices'}/${invoiceId}`);
  return {
    kind,
    invoiceId,
    reason: '',
    lines: invoice.lines.map((line) => ({
      invoiceLineId: line.id,
      _label: `${invoice.docNo}: ${line.itemCode} · ${line.itemName}`,
      taxableMinor: kind === 'DEBIT' ? line.taxablePaise : line.taxableMinor,
      qtyMilli: line.qtyMilli,
      returnGoods: false,
    })),
  };
};

export function FormPage() {
  const { resource, id } = useParams();
  const [search] = useSearchParams();
  const config = useResource(resource);
  const allowed = useAllowed(config);
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(null);
  const [localError, setLocalError] = useState(null);

  const fields = useMemo(() => (config?.fields ?? []).filter((field) => (isEdit ? !field.createOnly : !field.editOnly)), [config, isEdit]);

  const existing = useQuery({ queryKey: ['doc', resource, id], queryFn: () => get(`${config.endpoint}/${id}`), enabled: isEdit && Boolean(config) });
  const prefillId = config?.prefill ? search.get(config.prefill.param) : null;
  const prefill = useQuery({ queryKey: ['prefill', resource, prefillId], queryFn: () => get(`${config.prefill.endpoint}/${prefillId}`), enabled: Boolean(prefillId) });
  const note = useQuery({ queryKey: ['note-prefill', search.toString()], queryFn: () => noteInvoice(search), enabled: Boolean(config?.prefillNote) && !isEdit });

  useEffect(() => {
    if (!config || values) return;
    if (isEdit) {
      if (existing.data) setValues(initialValues(fields, existing.data));
      return;
    }
    if (prefillId) {
      if (prefill.data) setValues(initialValues(fields, config.prefill.map(prefill.data)));
      return;
    }
    if (config.prefillNote) {
      if (note.isSuccess) setValues(initialValues(fields, note.data ?? {}));
      return;
    }
    const fromQuery = {};
    for (const key of config.fromQuery ?? []) {
      const value = search.get(key);
      if (value) fromQuery[key] = key === 'fxRate4' ? Number(value) : value;
    }
    setValues(initialValues(fields, fromQuery));
  }, [config, isEdit, existing.data, prefillId, prefill.data, note.isSuccess, note.data, fields, search, values]);

  const save = useMutation({
    mutationFn: async (payload) => (isEdit ? patch(`${config.endpoint}/${id}`, payload) : post(config.endpoint, payload)),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: ['list', resource] });
      queryClient.invalidateQueries({ queryKey: ['doc', resource, saved.id] });
      navigate(`/${resource}/${saved.id}`, { replace: true });
    },
  });

  if (!config) return <NotFoundPage />;
  if (!allowed('write')) return <ErrorBox error={{ message: 'You do not have permission to do this.' }} />;

  const setValue = (key, value) => setValues((current) => ({ ...current, [key]: value }));

  // Picking the source document fills in its lines.
  const pickSource = (field, row) => {
    if (!field.prefillOnPick || !config.prefill) return;
    const mapped = config.prefill.map(row);
    const lines = fields.find((f) => f.key === 'lines');
    setValues((current) => ({ ...current, [field.key]: row.id, lines: toFormValue(lines, mapped.lines) }));
  };

  const submit = (event) => {
    event.preventDefault();
    setLocalError(null);
    save.reset();
    try {
      const payload = toPayload(fields, values, { forEdit: isEdit });
      for (const key of config.omitOnEdit ?? []) if (isEdit) delete payload[key];
      save.mutate(payload);
    } catch (error) {
      setLocalError(error);
    }
  };

  const isLoading = !values;
  const loadError = existing.error ?? prefill.error ?? note.error;

  return (
    <>
      <PageHeader title={`${isEdit ? 'Edit' : 'New'} ${config.single.toLowerCase()}`} back={isEdit ? { to: `/${resource}/${id}`, label: 'Back to the record' } : { to: `/${resource}`, label: config.title }} />
      {loadError && <ErrorBox error={loadError} />}
      {isLoading && !loadError && <Spinner />}
      {values && (
        <form onSubmit={submit} className="space-y-4 pb-16">
          <Card className="p-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {fields.filter((field) => field.type !== 'lines').map((field) => (
                <FormField key={field.key} field={field} values={values} setValue={setValue} onPick={(row) => pickSource(field, row)} />
              ))}
            </div>
          </Card>
          {fields.filter((field) => field.type === 'lines').map((field) => (
            <Card key={field.key} className="p-4">
              <LinesEditor field={field} rows={values[field.key] ?? []} parentValues={values} onChange={(rows) => setValue(field.key, rows)} />
            </Card>
          ))}
          <ErrorBox error={localError ?? save.error} />
          <div className="sticky bottom-14 z-20 -mx-3 flex justify-end gap-2 border-t border-line bg-card/95 px-3 py-2 backdrop-blur md:bottom-0 md:-mx-5 md:px-5">
            <Link to={isEdit ? `/${resource}/${id}` : `/${resource}`}><Button>Discard</Button></Link>
            <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? 'Saving…' : config.kind === 'document' && !config.noSubmit ? 'Save draft' : 'Save'}</Button>
          </div>
        </form>
      )}
    </>
  );
}
