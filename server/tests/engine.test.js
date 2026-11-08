// The engine: what every document type gets, and the ways people might try to get round it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { call, ok, post, refused, startApi, stopApi } from './helpers/http.js';
import { allTypes, assertRegistryValid, linkTarget } from '../engine/registry.js';
import { parseFields } from '../engine/dsl.js';
import { parseCsv } from '../engine/importExport.js';
import { Notification, EmailQueue } from '../models/platform.js';
import { addDays, todayIst } from '../utils/dates.js';

const today = todayIst();
const refs = {};

before(async () => {
  await startApi();
  refs.customer = await ok('ADMIN', 'POST', '/parties', { code: 'C1', name: 'A Customer', isCustomer: true, stateCode: '24' });
  refs.supplier = await ok('ADMIN', 'POST', '/parties', { code: 'S1', name: 'A Supplier', isSupplier: true, stateCode: '24' });
  refs.item = await ok('ADMIN', 'POST', '/items', { code: 'NUT', name: 'Nut', type: 'CONSUMABLE' });
});
after(stopApi);

test('every definition is sound, and every link points at something real', () => {
  assertRegistryValid();
  const types = allTypes();
  assert.ok(types.length >= 200, `Only ${types.length} document types`);
  const series = types.filter((t) => t.series).map((t) => t.series);
  assert.equal(new Set(series).size, series.length, 'No two document types share a number series');
  // Numbers the hand-written documents and ledger vouchers already use.
  const reserved = ['QT', 'SO', 'MI', 'MR', 'TB', 'PO', 'GR', 'QC', 'PI', 'SM', 'JW', 'NCR', 'FAT', 'SI', 'CN', 'DN', 'RC', 'PY', 'JV', 'AMC', 'ST', 'FG', 'JR', 'AD', 'DP', 'DR'];
  assert.deepEqual(series.filter((prefix) => reserved.includes(prefix)), []);
  for (const type of types) {
    for (const field of [...type.fields, ...type.tables.flatMap((t) => t.fields)]) {
      if (field.link) assert.ok(linkTarget(field.link));
    }
    assert.ok(type.module, `${type.name} has no module`);
    assert.ok(type.labelFields.length > 0, `${type.name} has no label`);
  }
});

test('the field language refuses mistakes', () => {
  assert.throws(() => parseFields('a:nonsense'), /Unknown field type/);
  assert.throws(() => parseFields('a:select()'), /needs options/);
  assert.throws(() => parseFields('a:link()'), /needs a target/);
  assert.throws(() => parseFields('bad-token!'), /Bad field token/);
  const [field] = parseFields('amountPaise!*~:money=5');
  assert.deepEqual([field.required, field.unique, field.computed, field.default, field.label], [true, true, true, 5, 'Amount']);
});

test('CSV parser handles quotes, commas, newlines and a byte-order mark', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x,1","y ""q"""\n"line\nbreak",2\n\n'), [['a', 'b'], ['x,1', 'y "q"'], ['line\nbreak', '2']]);
});

test('meta shows each role only what it may read, with what it may do', async () => {
  const stores = await ok('STORES', 'GET', '/meta');
  const hr = await ok('HR', 'GET', '/meta');
  assert.equal(stores.doctypes.some((d) => d.name === 'SalarySlip'), false, 'pay is private');
  assert.equal(stores.doctypes.some((d) => d.name === 'Employee'), false);
  assert.equal(hr.doctypes.find((d) => d.name === 'SalarySlip').can.write, true);
  assert.equal(stores.doctypes.find((d) => d.name === 'Lead').can.write, false, 'can read a lead but not change it');
  assert.ok(stores.reports.every((r) => r.key !== 'salary-register'));
  await refused('STORES', 'GET', '/d/SalarySlip', undefined, 'FORBIDDEN', 403);
  await refused('STORES', 'POST', '/d/Lead', { leadName: 'X' }, 'FORBIDDEN', 403);
  assert.equal((await call(null, 'GET', '/meta')).status, 401);
  assert.equal((await call(null, 'GET', '/d/Lead')).status, 401);
  await refused('ADMIN', 'GET', '/d/NoSuchThing', undefined, 'NOT_FOUND', 404);
});

test('validation: required, types, unknown fields, computed fields cannot be typed in', async () => {
  await refused('SALES', 'POST', '/d/Lead', {}, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'X', hacked: true }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'X', status: 'NOPE' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'X', email: 'not-an-email' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Opportunity', { title: 'X', amountPaise: 1.5 }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Opportunity', { title: 'X', amountPaise: -5 }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Appointment', { subject: 'X', onDate: '2026-02-30' }, 'VALIDATION_FAILED', 400);
  // A computed field is the server's to set.
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'X', convertedPartyId: refs.customer.id }, 'VALIDATION_FAILED', 400);
  await refused('ACCOUNTS', 'POST', '/d/BankTransaction', { bankAccountId: '000000000000000000000000', onDate: today, state: 'RECONCILED' }, 'VALIDATION_FAILED', 400);
  await refused('PRODUCTION', 'POST', '/d/WorkOrder', { itemId: refs.item.id, qtyMilli: 1000, targetWarehouseId: 'x', wipPaise: 999 }, 'VALIDATION_FAILED', 400);
  await refused('HR', 'POST', '/d/Employee', { fullName: 'X', joiningDate: today, _labels: {} }, 'VALIDATION_FAILED', 400);
  await refused('HR', 'POST', '/d/Employee', { fullName: 'X', joiningDate: today, createdBy: 'me' }, 'VALIDATION_FAILED', 400);
});

test('links: must exist, must be the right kind, and carry a frozen label', async () => {
  await refused('SALES', 'POST', '/d/Opportunity', { title: 'X', partyId: '000000000000000000000000' }, 'LINK_NOT_FOUND', 422);
  await refused('SALES', 'POST', '/d/Opportunity', { title: 'X', partyId: 'not-an-id' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Opportunity', { title: 'X', partyId: refs.supplier.id }, 'LINK_NOT_ALLOWED', 422);
  const op = await ok('SALES', 'POST', '/d/Opportunity', { title: 'Big one', partyId: refs.customer.id, amountPaise: 100 });
  assert.equal(op._labels.partyId, 'C1 · A Customer');
  // Renaming the customer does not rewrite old records.
  await ok('ADMIN', 'PATCH', `/parties/${refs.customer.id}`, { name: 'Renamed Customer' });
  assert.equal((await ok('SALES', 'GET', `/d/Opportunity/${op.id}`))._labels.partyId, 'C1 · A Customer');
  const moved = await ok('SALES', 'PATCH', `/d/Opportunity/${op.id}`, { title: 'Big one', partyId: refs.customer.id, notes: 'Hello' });
  assert.equal(moved.notes, 'Hello');
  assert.equal(moved.status, 'OPEN', 'fields left out stay as they were');
  const cleared = await ok('SALES', 'PATCH', `/d/Opportunity/${op.id}`, { title: 'Big one', notes: null });
  assert.equal(cleared.notes, '', 'a null clears a field');
  await refused('SALES', 'PATCH', `/d/Opportunity/${op.id}`, { title: null }, 'VALIDATION_FAILED', 400);
});

test('numbers: non-submittable documents number on create, drafts on submit', async () => {
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'Numbered' });
  assert.match(lead.docNo, /^LD\/\d{4}\/\d{5}$/);
  const contract = await ok('SALES', 'POST', '/d/Contract', { title: 'C', partyId: refs.customer.id, startDate: today });
  assert.equal(contract.docNo, null);
  assert.equal(contract.status, 'DRAFT');
  const submitted = await ok('SALES', 'POST', `/d/Contract/${contract.id}/submit`, {});
  assert.match(submitted.docNo, /^CT\//);
  await refused('SALES', 'PATCH', `/d/Contract/${contract.id}`, { title: 'Changed' }, 'NOT_DRAFT', 409);
  await refused('SALES', 'DELETE', `/d/Contract/${contract.id}`, undefined, 'NOT_DELETABLE', 409);
  await refused('SALES', 'POST', `/d/Contract/${contract.id}/submit`, {}, 'NOT_DRAFT', 409);
  await refused('SALES', 'POST', `/d/Contract/${contract.id}/cancel`, {}, 'VALIDATION_FAILED', 400);
  const cancelled = await ok('SALES', 'POST', `/d/Contract/${contract.id}/cancel`, { reason: 'Changed mind' });
  assert.equal(cancelled.status, 'CANCELLED');
  await refused('SALES', 'POST', `/d/Contract/${contract.id}/cancel`, { reason: 'Again' }, 'ALREADY_CANCELLED', 409);
  const draft = await ok('SALES', 'POST', '/d/Contract', { title: 'D', partyId: refs.customer.id, startDate: today });
  await refused('SALES', 'POST', `/d/Contract/${draft.id}/cancel`, { reason: 'x' }, 'IS_DRAFT', 422);
  await ok('SALES', 'DELETE', `/d/Contract/${draft.id}`);
  await refused('SALES', 'GET', `/d/Contract/${draft.id}`, undefined, 'NOT_FOUND', 404);
  await refused('SALES', 'GET', '/d/Contract/not-an-id', undefined, 'VALIDATION_FAILED', 400);
});

test('delete: a master cannot go, and nothing goes while something still points at it', async () => {
  const source = await ok('SALES', 'POST', '/d/LeadSource', { name: 'Trade show' });
  await refused('SALES', 'DELETE', `/d/LeadSource/${source.id}`, undefined, 'NOT_DELETABLE', 409);
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'To delete' });
  const opportunity = await ok('SALES', 'POST', '/d/Opportunity', { title: 'From lead', leadId: lead.id });
  await refused('SALES', 'DELETE', `/d/Lead/${lead.id}`, undefined, 'STILL_LINKED', 409);
  const links = await ok('SALES', 'GET', `/d/Lead/${lead.id}/connections`);
  assert.deepEqual(links.map((l) => [l.doctype, l.count]), [['Opportunity', 1]]);
  await ok('SALES', 'DELETE', `/d/Opportunity/${opportunity.id}`);
  await ok('SALES', 'DELETE', `/d/Lead/${lead.id}`);
});

test('unique fields refuse a duplicate, ignoring case', async () => {
  await ok('SALES', 'POST', '/d/Competitor', { name: 'Acme Machines' });
  await refused('SALES', 'POST', '/d/Competitor', { name: 'ACME MACHINES' }, 'DUPLICATE', 409);
});

test('actions: conditions and inputs are enforced on the server, not only on screen', async () => {
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'Actor', companyName: 'Actor Ltd', mobile: '98' });
  await refused('SALES', 'POST', `/d/Lead/${lead.id}/a/nope`, {}, 'NOT_FOUND', 404);
  await refused('SALES', 'POST', `/d/Lead/${lead.id}/a/toOpportunity`, {}, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', `/d/Lead/${lead.id}/a/toOpportunity`, { title: 'T', extra: 1 }, 'VALIDATION_FAILED', 400);
  const opportunity = await ok('SALES', 'POST', `/d/Lead/${lead.id}/a/toOpportunity`, { title: 'From action', amountPaise: 5000 });
  assert.equal(opportunity.leadId, lead.id);
  const customer = await ok('SALES', 'POST', `/d/Lead/${lead.id}/a/toCustomer`, { stateCode: '24' });
  assert.equal(customer.status, 'CONVERTED');
  assert.match(customer._labels.convertedPartyId, /Actor Ltd/);
  await refused('SALES', 'POST', `/d/Lead/${lead.id}/a/toCustomer`, {}, 'ACTION_NOT_AVAILABLE', 422);
  await refused('STORES', 'POST', `/d/Lead/${lead.id}/a/toOpportunity`, { title: 'T' }, 'FORBIDDEN', 403);
  await ok('SALES', 'POST', `/d/Opportunity/${opportunity.id}/a/markWon`, {});
  await refused('SALES', 'POST', `/d/Opportunity/${opportunity.id}/a/markLost`, { lostReasonId: '000000000000000000000000' }, 'ACTION_NOT_AVAILABLE', 422);
});

test('history: a change records what it was before', async () => {
  const opportunity = await ok('SALES', 'POST', '/d/Opportunity', { title: 'Tracked', amountPaise: 100 });
  await ok('SALES', 'PATCH', `/d/Opportunity/${opportunity.id}`, { title: 'Tracked', amountPaise: 200 });
  const timeline = await ok('SALES', 'GET', `/timeline?entityType=Opportunity&entityId=${opportunity.id}`);
  assert.equal(timeline[0].action, 'OPPORTUNITY_UPDATED');
  assert.equal(timeline[0].data.before.amountPaise, 100);
  assert.equal(timeline.at(-1).action, 'OPPORTUNITY_CREATED');
});

test('custom fields: appear, are required when asked, are type-checked, and only admin adds them', async () => {
  await refused('SALES', 'POST', '/admin/custom-fields', { doctype: 'Lead', key: 'x', label: 'X', type: 'text' }, 'FORBIDDEN', 403);
  await refused('ADMIN', 'POST', '/admin/custom-fields', { doctype: 'Nope', key: 'x', label: 'X', type: 'text' }, 'VALIDATION_FAILED', 400);
  await refused('ADMIN', 'POST', '/admin/custom-fields', { doctype: 'Lead', key: 'Bad Key', label: 'X', type: 'text' }, 'VALIDATION_FAILED', 400);
  const size = await ok('ADMIN', 'POST', '/admin/custom-fields', { doctype: 'Lead', key: 'plantSize', label: 'Plant size', type: 'select', options: ['SMALL', 'BIG'], required: true });
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'No size' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Lead', { leadName: 'Bad size', custom: { plantSize: 'HUGE' } }, 'VALIDATION_FAILED', 400);
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'Sized', custom: { plantSize: 'BIG', ignored: 'dropped' } });
  assert.deepEqual(lead.custom, { plantSize: 'BIG' });
  assert.ok((await ok('SALES', 'GET', '/meta')).custom.some((c) => c.key === 'plantSize'));
  await ok('ADMIN', 'DELETE', `/admin/custom-fields/${size.id}`);
  await ok('SALES', 'POST', '/d/Lead', { leadName: 'Fine again' });
});

test('role permissions: an admin can change them at runtime, and admin itself cannot be locked out', async () => {
  await refused('SERVICE', 'POST', '/d/Competitor', { name: 'Blocked' }, 'FORBIDDEN', 403);
  await refused('SALES', 'POST', '/admin/role-permissions', { doctype: 'Competitor', role: 'SERVICE', read: true, write: true, submit: false, cancel: false }, 'FORBIDDEN', 403);
  await ok('ADMIN', 'POST', '/admin/role-permissions', { doctype: 'Competitor', role: 'SERVICE', read: true, write: true, submit: false, cancel: false });
  await ok('SERVICE', 'POST', '/d/Competitor', { name: 'Now allowed' });
  await ok('ADMIN', 'POST', '/admin/role-permissions', { doctype: 'Competitor', role: 'SERVICE', read: false, write: false, submit: false, cancel: false });
  await refused('SERVICE', 'GET', '/d/Competitor', undefined, 'FORBIDDEN', 403);
  await ok('ADMIN', 'POST', '/admin/role-permissions', { doctype: 'Competitor', role: 'ADMIN', read: false, write: false, submit: false, cancel: false });
  await ok('ADMIN', 'GET', '/d/Competitor');
  const rows = await ok('ADMIN', 'GET', '/admin/role-permissions?doctype=Competitor');
  assert.equal(rows.find((r) => r.role === 'SERVICE').read, false);
});

test('workflow: no submit until approved, the right role per step, and no approving your own', async () => {
  await ok('ADMIN', 'POST', '/d/Workflow', {
    name: 'Contract approval',
    doctypeName: 'Contract',
    startState: 'Draft',
    approvedState: 'Approved',
    transitions: [
      { fromState: 'Draft', action: 'Send for review', toState: 'Review', role: 'SALES' },
      { fromState: 'Review', action: 'Approve', toState: 'Approved', role: 'MANAGEMENT' },
      { fromState: 'Review', action: 'Reject', toState: 'Draft', role: 'MANAGEMENT' },
    ],
  });
  const contract = await ok('MANAGEMENT', 'POST', '/d/Contract', { title: 'Own contract', partyId: refs.customer.id, startDate: today });
  await refused('MANAGEMENT', 'POST', `/d/Contract/${contract.id}/submit`, {}, 'WORKFLOW_NOT_APPROVED', 422);
  await refused('MANAGEMENT', 'POST', `/d/Contract/${contract.id}/workflow`, { action: 'Approve' }, 'BAD_TRANSITION', 422);
  await refused('MANAGEMENT', 'POST', `/d/Contract/${contract.id}/workflow`, { action: 'Send for review' }, 'WRONG_ROLE', 422);
  const options = await ok('SALES', 'GET', `/d/Contract/${contract.id}/workflow`);
  assert.deepEqual(options.actions, ['Send for review']);
  await ok('SALES', 'POST', `/d/Contract/${contract.id}/workflow`, { action: 'Send for review' });
  await refused('MANAGEMENT', 'POST', `/d/Contract/${contract.id}/workflow`, { action: 'Approve' }, 'SELF_APPROVAL', 422);

  const other = await ok('SALES', 'POST', '/d/Contract', { title: 'Their contract', partyId: refs.customer.id, startDate: today });
  await ok('SALES', 'POST', `/d/Contract/${other.id}/workflow`, { action: 'Send for review' });
  await ok('MANAGEMENT', 'POST', `/d/Contract/${other.id}/workflow`, { action: 'Approve' });
  const done = await ok('SALES', 'POST', `/d/Contract/${other.id}/submit`, {});
  assert.equal(done.workflowState, 'Approved');
  assert.equal(done.status, 'SUBMITTED');
  const flow = await ok('ADMIN', 'GET', '/d/Workflow');
  await ok('ADMIN', 'PATCH', `/d/Workflow/${flow[0].id}`, { name: flow[0].name, doctypeName: 'Contract', startState: 'Draft', approvedState: 'Approved', isActive: false });
});

test('notification rules tell a whole role, and email waits if there is no mail server', async () => {
  await ok('ADMIN', 'POST', '/d/NotificationRule', { name: 'Contracts', doctypeName: 'Contract', event: 'SUBMITTED', role: 'ACCOUNTS', sendEmail: true });
  const contract = await post('SALES', '/d/Contract', { title: 'Tell them', partyId: refs.customer.id, startDate: today });
  const notes = await call('ACCOUNTS', 'GET', '/notifications');
  assert.equal(notes.body.meta.unread, 1);
  assert.match(notes.body.data[0].title, new RegExp(contract.docNo));
  await ok('ACCOUNTS', 'POST', '/notifications/read');
  assert.equal((await call('ACCOUNTS', 'GET', '/notifications')).body.meta.unread, 0);
  assert.equal((await Notification.countDocuments({ readAt: { $ne: null } })) >= 1, true);
  assert.equal(await EmailQueue.countDocuments({ status: 'QUEUED' }), 1);
  const { flushEmails } = await import('../doctypes/jobs.js');
  assert.equal(await flushEmails(), 0);
  assert.equal(await EmailQueue.countDocuments({ status: 'NOT_CONFIGURED' }), 1, 'it says it could not send, and does not pretend');
});

test('comments, assignments and permission on them', async () => {
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'Discussed' });
  await refused('SALES', 'POST', '/comments', { entityType: 'Lead', entityId: lead.id, body: '  ' }, 'VALIDATION_FAILED', 400);
  await ok('SALES', 'POST', '/comments', { entityType: 'Lead', entityId: lead.id, body: 'Called them' });
  const rows = await ok('MANAGEMENT', 'GET', `/comments?entityType=Lead&entityId=${lead.id}`);
  assert.equal(rows[0].body, 'Called them');
  assert.equal(rows[0].byName, 'SALES person');
  await refused('STORES', 'GET', '/comments?entityType=SalarySlip&entityId=x', undefined, 'FORBIDDEN', 403);

  const { User } = await import('../models/index.js');
  const purchase = await User.findOne({ role: 'PURCHASE' });
  await ok('SALES', 'POST', '/todos', { entityType: 'Lead', entityId: lead.id, entityLabel: 'Discussed', assignedTo: String(purchase._id), note: 'Check this', dueOn: addDays(today, 2) });
  const mine = await ok('PURCHASE', 'GET', '/todos');
  assert.equal(mine.length, 1);
  assert.equal((await call('PURCHASE', 'GET', '/notifications')).body.meta.unread, 1);
  await ok('PURCHASE', 'PATCH', `/todos/${mine[0].id}`, { isDone: true });
  assert.equal((await ok('PURCHASE', 'GET', '/todos')).length, 0);
});

test('files: right bytes back, dangerous types refused, delete cleans up', async () => {
  const lead = await ok('SALES', 'POST', '/d/Lead', { leadName: 'With file' });
  const bytes = Buffer.from('%PDF-1.4 a drawing');
  const query = `entityType=Lead&entityId=${lead.id}`;
  for (const name of ['evil.html', 'evil.svg', 'evil.exe', 'evil.js', 'noextension']) {
    await refused('SALES', 'POST', `/files?${query}&filename=${name}`, bytes, 'VALIDATION_FAILED', 400);
  }
  await refused('SALES', 'POST', `/files?${query}&filename=empty.pdf`, Buffer.alloc(0), 'VALIDATION_FAILED', 400);
  await refused('STORES', 'POST', `/files?entityType=Lead&entityId=${lead.id}&filename=a.pdf`, bytes, 'FORBIDDEN', 403);
  const file = await ok('SALES', 'POST', `/files?${query}&filename=${encodeURIComponent('../../etc/pass wd.pdf')}`, bytes);
  assert.equal(file.filename.includes('/'), false, 'a path cannot be smuggled in the name');
  const download = await call('MANAGEMENT', 'GET', `/files/${file.id}/download`);
  assert.equal(download.status, 200);
  assert.deepEqual(download.body, bytes);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await ok('SALES', 'GET', `/files?${query}`)).length, 1);
  assert.equal((await call(null, 'GET', `/files/${file.id}/download`)).status, 401);
  await ok('SALES', 'DELETE', `/files/${file.id}`);
  assert.equal((await ok('SALES', 'GET', `/files?${query}`)).length, 0);
  assert.equal((await call('SALES', 'GET', `/files/${file.id}/download`)).status, 404);
});

test('CSV import: dry run saves nothing, real run obeys the rules, links by name, errors by row', async () => {
  const before = (await call('SALES', 'GET', '/d/Competitor')).body.meta.total;
  const csv = 'name,website\nCsv One,one.example\nCsv Two,two.example\n';
  const dry = await ok('SALES', 'POST', '/d/Competitor/import', { csv, dryRun: true });
  assert.deepEqual([dry.ok, dry.errorCount], [2, 0]);
  assert.equal((await call('SALES', 'GET', '/d/Competitor')).body.meta.total, before);
  const real = await ok('SALES', 'POST', '/d/Competitor/import', { csv, dryRun: false });
  assert.equal(real.ok, 2);
  assert.equal((await call('SALES', 'GET', '/d/Competitor')).body.meta.total, before + 2);

  const again = await ok('SALES', 'POST', '/d/Competitor/import', { csv: 'name\nCsv One\nCsv Three\n', dryRun: false });
  assert.equal(again.ok, 1);
  assert.equal(again.errorCount, 1);
  assert.equal(again.errors[0].row, 2);

  await refused('SALES', 'POST', '/d/Competitor/import', { csv: 'name,nonsense\nX,Y\n' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/d/Competitor/import', { csv: 'name\n' }, 'VALIDATION_FAILED', 400);

  const opp = await ok('SALES', 'POST', '/d/Opportunity/import', { csv: 'title,partyId,amountPaise,probabilityBps\nImported,C1,"1,250.50",18\nBad,NOBODY,1,1\n', dryRun: false });
  assert.equal(opp.ok, 1);
  assert.match(opp.errors[0].message, /NOBODY.*not found/);
  const rows = await ok('SALES', 'GET', '/d/Opportunity?q=Imported');
  assert.equal(rows[0].amountPaise, 125050, 'rupees in the file become paise');
  assert.equal(rows[0].probabilityBps, 1800, 'percent in the file becomes basis points');
  assert.equal(rows[0].partyId, refs.customer.id);
});

test('CSV export defuses formulas, so a spreadsheet will not run them', async () => {
  await ok('SALES', 'POST', '/d/Competitor', { name: '=HYPERLINK("http://evil")' });
  const result = await call('SALES', 'GET', '/d/Competitor/export');
  assert.equal(result.status, 200);
  const text = result.body.toString();
  assert.match(text, /"'=HYPERLINK/);
  assert.doesNotMatch(text, /"=HYPERLINK/);
});

test('report builder: lists, groups, adds up, and refuses fields it does not know', async () => {
  await ok('SALES', 'POST', '/d/Opportunity', { title: 'R1', amountPaise: 1000, status: 'QUOTATION' });
  await ok('SALES', 'POST', '/d/Opportunity', { title: 'R2', amountPaise: 2000, status: 'QUOTATION' });
  const listed = await ok('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', columns: ['title', 'amountPaise'], filters: { status: 'QUOTATION' } });
  assert.equal(listed.rows.length, 2);
  assert.deepEqual(listed.columns.map((c) => c.key), ['title', 'amountPaise']);
  const grouped = await ok('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', groupBy: 'status', sums: ['amountPaise'], filters: { status: 'QUOTATION' } });
  assert.deepEqual([grouped.rows[0].group, grouped.rows[0].count, grouped.rows[0].amountPaise], ['QUOTATION', 2, 3000]);
  await refused('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', filters: { $where: '1' } }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', filters: { status: { $ne: 'x' } } }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', groupBy: 'nope' }, 'VALIDATION_FAILED', 400);
  await refused('SALES', 'POST', '/report-builder', { doctype: 'Opportunity', groupBy: 'status', sums: ['title'] }, 'VALIDATION_FAILED', 400);
  await refused('STORES', 'POST', '/report-builder', { doctype: 'SalarySlip' }, 'FORBIDDEN', 403);
  const saved = await ok('SALES', 'POST', '/saved-reports', { name: 'Mine', doctype: 'Opportunity', columns: ['title'], isShared: false });
  assert.equal((await ok('SALES', 'GET', '/saved-reports'))[0].id, saved.id);
  assert.equal((await ok('STORES', 'GET', '/saved-reports')).length, 0, 'an unshared report is private');
});

test('search finds across types, within what you may read', async () => {
  await ok('HR', 'POST', '/d/Employee', { fullName: 'Zebulon Findme', joiningDate: today });
  await ok('SALES', 'POST', '/d/Competitor', { name: 'Zebulon Machines' });
  const hr = await ok('HR', 'GET', '/search?q=Zebulon');
  assert.ok(hr.some((h) => h.doctype === 'Employee'));
  const stores = await ok('STORES', 'GET', '/search?q=Zebulon');
  assert.equal(stores.some((h) => h.doctype === 'Employee'), false);
  assert.ok(stores.some((h) => h.doctype === 'Competitor'));
  assert.deepEqual(await ok('STORES', 'GET', '/search?q=Z'), []);
  assert.deepEqual(await ok('STORES', 'GET', '/search?q=.*'), []);
});

test('list: search is literal, filters are safe, paging clamps', async () => {
  const rows = await call('SALES', 'GET', '/d/Lead?status[$ne]=NEW&limit=99999');
  assert.equal(rows.status, 200);
  assert.equal(rows.body.meta.limit, 200);
  assert.equal((await call('SALES', 'GET', '/d/Lead?page=-5')).body.meta.page, 1);
  assert.equal((await ok('SALES', 'GET', '/d/Lead?q=(((')).length, 0);
  assert.equal((await call('SALES', 'GET', '/d/Lead?sort=$where&dir=asc')).status, 200);
});
