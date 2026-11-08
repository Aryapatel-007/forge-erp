// What is still to do before a real company goes live, worked out from the data itself.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get } from '../api/client.js';
import { Card, ErrorBox, PageHeader, Spinner } from '../components/ui.jsx';

export function SetupGuide() {
  const query = useQuery({ queryKey: ['setup-status'], queryFn: () => get('/views/setup-status') });
  if (query.isLoading) return <Spinner />;
  if (query.error) return <ErrorBox error={query.error} />;
  const { steps, doneCount, total } = query.data;
  return (
    <>
      <PageHeader title="Going live" subtitle={`${doneCount} of ${total} done`} />
      <Card>
        <ol className="divide-y divide-line">
          {steps.map((step, index) => (
            <li key={step.key} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.done ? 'bg-ok-soft text-ok' : 'bg-paper text-steel'}`}>{step.done ? '✓' : index + 1}</span>
              <span className="min-w-0 flex-1">
                {step.label}
                {step.optional && <span className="text-xs text-steel"> (if it applies)</span>}
                <span className="sr-only">{step.done ? ', done' : ', not done'}</span>
              </span>
              <Link to={step.to} className="shrink-0 text-accent underline">Open</Link>
            </li>
          ))}
        </ol>
      </Card>
      <p className="mt-3 text-xs text-steel">To bring in many documents at once, use Import CSV on any list. Add a _key column, and columns like lines.qtyMilli. Rows with the same _key become one document.</p>
    </>
  );
}
