// What every record has, whatever its type: approvals, assignments, comments, files, what
// links to it, and who changed what.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, get, patch, post, queryString, sendFile, downloadFile, del } from '../../api/client.js';
import { RefPicker } from '../../components/RefPicker.jsx';
import { Button, Card, ErrorBox, Input, TextArea } from '../../components/ui.jsx';
import { formatDate, formatDateTime, humanise } from '../../utils/format.js';

const sizeLabel = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

function Workflow({ resource, id, onChanged }) {
  const query = useQuery({ queryKey: ['workflow', resource, id], queryFn: () => get(`/d/${resource}/${id}/workflow`) });
  const step = useMutation({
    mutationFn: (action) => post(`/d/${resource}/${id}/workflow`, { action }),
    onSuccess: () => { query.refetch(); onChanged(); },
  });
  if (!query.data) return null;
  return (
    <Card title="Approval">
      <div className="flex flex-wrap items-center gap-2 p-4 text-sm">
        <span>At: <strong>{query.data.state}</strong></span>
        {query.data.state === query.data.approvedState && <span className="text-ok">Ready to submit</span>}
        {query.data.actions.map((action) => <Button key={action} disabled={step.isPending} onClick={() => step.mutate(action)}>{action}</Button>)}
      </div>
      {step.error && <div className="px-4 pb-4"><ErrorBox error={step.error} /></div>}
    </Card>
  );
}

function Assignments({ resource, id, label }) {
  const key = ['todos', resource, id];
  const client = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => get(`/todos${queryString({ entityType: resource, entityId: id })}`) });
  const [form, setForm] = useState({ assignedTo: '', note: '', dueOn: '' });
  const add = useMutation({
    mutationFn: () => post('/todos', { entityType: resource, entityId: id, entityLabel: label, assignedTo: form.assignedTo, note: form.note, dueOn: form.dueOn || null }),
    onSuccess: () => { setForm({ assignedTo: '', note: '', dueOn: '' }); client.invalidateQueries({ queryKey: key }); },
  });
  const toggle = useMutation({ mutationFn: (todo) => patch(`/todos/${todo.id}`, { isDone: !todo.isDone }), onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  return (
    <Card title="Assigned to">
      <ul className="divide-y divide-line">
        {(query.data ?? []).map((todo) => (
          <li key={todo.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
            <span className={todo.isDone ? 'text-steel line-through' : ''}>{todo.assignedToName}{todo.note ? `: ${todo.note}` : ''}{todo.dueOn ? `, by ${formatDate(todo.dueOn)}` : ''}</span>
            <Button variant="ghost" onClick={() => toggle.mutate(todo)}>{todo.isDone ? 'Reopen' : 'Done'}</Button>
          </li>
        ))}
      </ul>
      <form className="grid gap-2 p-4 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <RefPicker endpoint="/lookup/User" labelOf={(r) => r.name} value={form.assignedTo} placeholder="Who" onChange={(assignedTo) => setForm({ ...form, assignedTo })} />
        <Input placeholder="What to do" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        <Input aria-label="Due" type="date" value={form.dueOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} />
        <Button type="submit" disabled={!form.assignedTo || add.isPending}>Assign</Button>
      </form>
      {add.error && <div className="px-4 pb-4"><ErrorBox error={add.error} /></div>}
    </Card>
  );
}

function Comments({ resource, id }) {
  const key = ['comments', resource, id];
  const client = useQueryClient();
  const [body, setBody] = useState('');
  const query = useQuery({ queryKey: key, queryFn: () => get(`/comments${queryString({ entityType: resource, entityId: id })}`) });
  const add = useMutation({
    mutationFn: () => post('/comments', { entityType: resource, entityId: id, body }),
    onSuccess: () => { setBody(''); client.invalidateQueries({ queryKey: key }); },
  });
  return (
    <Card title="Comments">
      <form className="space-y-2 p-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <TextArea aria-label="Comment" rows={2} value={body} onChange={(e) => setBody(e.target.value)} />
        <Button type="submit" disabled={!body.trim() || add.isPending}>Add comment</Button>
        <ErrorBox error={add.error} />
      </form>
      <ul className="divide-y divide-line">
        {(query.data ?? []).map((row) => (
          <li key={row.id} className="px-4 py-2 text-sm">
            <p className="whitespace-pre-wrap">{row.body}</p>
            <p className="mt-0.5 text-xs text-steel">{row.byName}, {formatDateTime(row.createdAt)}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Files({ resource, id }) {
  const key = ['files', resource, id];
  const client = useQueryClient();
  const input = useRef(null);
  const query = useQuery({ queryKey: key, queryFn: () => get(`/files${queryString({ entityType: resource, entityId: id })}`) });
  const upload = useMutation({
    mutationFn: (file) => sendFile(`/files${queryString({ entityType: resource, entityId: id, filename: file.name })}`, file),
    onSuccess: () => { client.invalidateQueries({ queryKey: key }); if (input.current) input.current.value = ''; },
  });
  const remove = useMutation({ mutationFn: (fileId) => del(`/files/${fileId}`), onSuccess: () => client.invalidateQueries({ queryKey: key }) });
  return (
    <Card title="Files">
      <ul className="divide-y divide-line">
        {(query.data ?? []).map((file) => (
          <li key={file.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
            <button type="button" className="truncate text-left text-accent underline" onClick={() => downloadFile(`/files/${file.id}/download`, file.filename)}>{file.filename}</button>
            <span className="flex shrink-0 items-center gap-2 text-xs text-steel">
              {sizeLabel(file.sizeBytes)}, {file.byName}
              <Button variant="ghost" onClick={() => remove.mutate(file.id)}>Remove</Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="p-4">
        <input ref={input} aria-label="Attach a file" type="file" className="text-sm" onChange={(e) => e.target.files[0] && upload.mutate(e.target.files[0])} />
        <p className="mt-1 text-xs text-steel">PDF, images, Word, Excel, CAD drawings or zip, up to 15 MB.{upload.isPending ? ' Uploading…' : ''}</p>
        <ErrorBox error={upload.error ?? remove.error} />
      </div>
    </Card>
  );
}

function Connections({ resource, id }) {
  const query = useQuery({ queryKey: ['connections', resource, id], queryFn: () => get(`/d/${resource}/${id}/connections`) });
  if (!query.data?.length) return null;
  return (
    <Card title="Linked records">
      <ul className="flex flex-wrap gap-2 p-4 text-sm">
        {query.data.map((row) => (
          <li key={`${row.doctype}${row.field}`}>
            <Link className="rounded border border-line px-2 py-1 hover:bg-paper" to={`/${row.doctype}?${row.field.includes('.') ? '' : `${row.field}=${id}`}`}>{row.doctype.replace(/([a-z0-9])([A-Z])/g, '$1 $2')}: {row.count}</Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const showChange = (value) => {
  if (value === null || value === undefined || value === '') return '(blank)';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
};

function Timeline({ resource, id }) {
  const [isOpen, setIsOpen] = useState(false);
  const query = useQuery({ queryKey: ['timeline', resource, id], queryFn: () => api(`/timeline${queryString({ entityType: resource, entityId: id })}`).then((r) => r.data), enabled: isOpen });
  return (
    <Card title="History" actions={<Button variant="ghost" onClick={() => setIsOpen(!isOpen)}>{isOpen ? 'Hide' : 'Show'}</Button>}>
      {isOpen && (
        <ul className="divide-y divide-line">
          {query.error && <li className="p-4"><ErrorBox error={query.error} /></li>}
          {(query.data ?? []).map((row) => (
            <li key={row.id} className="px-4 py-2 text-sm">
              {row.action.replace(/_/g, ' ').toLowerCase()}{row.reason ? `: ${row.reason}` : ''}
              <div className="text-xs text-steel">{row.actorName}, {formatDateTime(row.at)}</div>
              {row.data?.after && Object.keys(row.data.after).length > 0 && (
                <table className="mt-1 w-full text-xs">
                  <thead><tr className="text-left text-steel"><th className="pr-2 font-medium">Field</th><th className="pr-2 font-medium">Was</th><th className="font-medium">Now</th></tr></thead>
                  <tbody>
                    {Object.keys(row.data.after).map((key) => (
                      <tr key={key} className="align-top">
                        <td className="pr-2">{humanise(key)}</td>
                        <td className="break-all pr-2 text-danger">{showChange(row.data.before?.[key])}</td>
                        <td className="break-all text-ok">{showChange(row.data.after[key])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RecordExtras({ config, resource, id, doc, onChanged }) {
  const entity = config.isEngine ? config.name : (config.entityType ?? resource);
  const label = config.titleOf?.(doc) ?? doc.docNo ?? config.single;
  return (
    <div className="space-y-4">
      {config.isEngine && <Workflow resource={config.name} id={id} onChanged={onChanged} />}
      <Assignments resource={entity} id={id} label={label} />
      <Files resource={entity} id={id} />
      <Comments resource={entity} id={id} />
      {config.isEngine && <Connections resource={config.name} id={id} />}
      <Timeline resource={entity} id={id} />
    </div>
  );
}
