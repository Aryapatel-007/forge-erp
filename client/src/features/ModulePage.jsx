// Search, my work, and the redirect from old module addresses.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { APPS } from '../config/apps.js';
import { get, patch, post, queryString } from '../api/client.js';
import { Button, Card, ErrorBox, Input, PageHeader, Spinner, Table } from '../components/ui.jsx';
import { formatDate, formatDateTime } from '../utils/format.js';
import { WaitingOnDepartment } from './OrderJourney.jsx';

// Old addresses keep working, and land in the area that now holds that module.
export function LegacyModuleRedirect() {
  const { module } = useParams();
  const app = APPS.find((row) => row.modules.includes(module));
  return <Navigate to={app ? `/app/${app.key}` : '/apps'} replace />;
}

export function SearchPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const query = useQuery({ queryKey: ['search', term], queryFn: () => get(`/search${queryString({ q: term })}`), enabled: term.length >= 2 });
  return (
    <>
      <PageHeader title="Search everything" />
      <form className="mb-4 flex max-w-lg gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <Input aria-label="Search" placeholder="A name, number or code" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="primary">Search</Button>
      </form>
      {query.isLoading && term && <Spinner />}
      <ErrorBox error={query.error} />
      {query.data && (
        <Card>
          <Table
            rowKey={(r) => `${r.doctype}${r.id}`}
            rows={query.data}
            empty="Nothing found."
            onRowClick={(r) => navigate(`/${r.doctype}/${r.id}`)}
            columns={[{ key: 'label', label: 'Found', wrap: true }, { key: 'doctype', label: 'Type', render: (r) => r.typeLabel ?? r.doctype.replace(/([a-z0-9])([A-Z])/g, '$1 $2') }]}
          />
        </Card>
      )}
    </>
  );
}

export function MyWorkPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const todos = useQuery({ queryKey: ['my-todos'], queryFn: () => get('/todos') });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => get('/notifications') });
  const done = useMutation({ mutationFn: (id) => patch(`/todos/${id}`, { isDone: true }), onSuccess: () => client.invalidateQueries({ queryKey: ['my-todos'] }) });
  const readAll = useMutation({ mutationFn: () => post('/notifications/read'), onSuccess: () => client.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <>
      <PageHeader title="My work" />
      <div className="space-y-4">
        <Card title="Assigned to me">
          <ErrorBox error={todos.error} />
          <Table
            rows={todos.data ?? []}
            empty="Nothing assigned to you."
            onRowClick={(r) => navigate(`/${r.entityType}/${r.entityId}`)}
            columns={[
              { key: 'entityLabel', label: 'What', wrap: true, render: (r) => r.entityLabel || r.entityType },
              { key: 'note', label: 'To do', wrap: true },
              { key: 'dueOn', label: 'By', render: (r) => formatDate(r.dueOn) },
              { key: 'assignedByName', label: 'From' },
              { key: 'act', label: '', render: (r) => <Button variant="ghost" onClick={(e) => { e.stopPropagation(); done.mutate(r.id); }}>Done</Button> },
            ]}
          />
        </Card>
        <WaitingOnDepartment title="Order steps due for your department" />
        <Card title="Notifications" actions={<Button variant="ghost" onClick={() => readAll.mutate()}>Mark all read</Button>}>
          <ErrorBox error={notes.error} />
          <Table
            rows={notes.data ?? []}
            empty="No notifications."
            onRowClick={(r) => r.link && navigate(r.link)}
            columns={[
              { key: 'title', label: 'What', wrap: true, render: (r) => <span className={r.readAt ? 'text-steel' : 'font-medium'}>{r.title}</span> },
              { key: 'createdAt', label: 'When', render: (r) => formatDateTime(r.createdAt) },
            ]}
          />
        </Card>
      </div>
    </>
  );
}
