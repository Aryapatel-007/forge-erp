import { useState } from 'react';
import { Button, ErrorBox } from '../../components/ui.jsx';
import { FormField, initialValues, toPayload } from './fields.jsx';

// A small form over the page, for an action that needs a few answers first.
export function ActionDialog({ title, hint, fields, confirmLabel = 'Confirm', tone = 'primary', onConfirm, onClose, error, isPending }) {
  const [values, setValues] = useState(() => initialValues(fields));
  const [localError, setLocalError] = useState(null);
  const submit = (event) => {
    event.preventDefault();
    event.stopPropagation();
    setLocalError(null);
    try {
      onConfirm(toPayload(fields, values));
    } catch (problem) {
      setLocalError(problem);
    }
  };
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <form onSubmit={submit} className="max-h-[90vh] w-full overflow-auto rounded-t-2xl bg-card p-4 shadow-xl md:max-w-lg md:rounded-2xl">
        <h2 className="text-base font-semibold">{title}</h2>
        {hint && <p className="mt-1 text-sm text-steel">{hint}</p>}
        <div className="mt-3 space-y-3">
          {fields.map((field) => (
            <FormField key={field.key} field={field} values={values} setValue={(key, value) => setValues((current) => ({ ...current, [key]: value }))} />
          ))}
        </div>
        <div className="mt-3"><ErrorBox error={localError ?? error} /></div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Back</Button>
          <Button type="submit" variant={tone} disabled={isPending}>{isPending ? 'Working…' : confirmLabel}</Button>
        </div>
      </form>
    </div>
  );
}
