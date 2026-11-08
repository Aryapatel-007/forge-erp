// Records behind mail, SMS, bank statements, the website and translations.
import { define, extend, modelOf } from '../engine/registry.js';
import { createDoc } from '../engine/documents.js';
import { scaledInt, parseCsv } from '../engine/importExport.js';
import { GlEntry } from '../models/ledgers.js';
import { Party } from '../models/masters.js';
import { Journal } from '../models/documents.js';
import { journal as journalService } from '../services/accountsService.js';
import { createPaymentLink } from '../services/channelsService.js';
import { daysBetween, isDateString } from '../utils/dates.js';
import { rule } from '../utils/errors.js';

/* ---------- Mail ---------- */

define({
  name: 'InboundEmail',
  module: 'support',
  labelFields: ['subject'],
  fields: 'uid!* fromAddress fromName subject! body:long sentAt:datetime state:select(NEW,FILED,DONE,IGNORED)=NEW filedOn',
  list: 'subject fromAddress sentAt state filedOn',
  writers: ['ADMIN', 'MANAGEMENT', 'SERVICE', 'SALES'],
  searchFields: ['subject', 'fromAddress'],
  hint: 'Mail read from the mailbox. A subject naming a document number goes on that document as a comment. The rest waits here.',
  actions: [
    {
      key: 'makeIssue',
      label: 'Make a support issue',
      primary: true,
      when: { state: ['NEW'] },
      fields: 'partyId:link(Party)',
      navigate: 'Issue',
      async run(session, doc, body, { actor }) {
        const party = body.partyId ? null : await Party.findOne({ email: doc.fromAddress }, { _id: 1 }).session(session).lean();
        const issue = await createDoc(session, 'Issue', { subject: doc.subject.slice(0, 300), description: doc.body.slice(0, 15000), partyId: body.partyId ?? (party ? String(party._id) : null) }, actor);
        doc.state = 'DONE';
        await doc.save({ session });
        return issue;
      },
    },
    {
      key: 'makeLead',
      label: 'Make a lead',
      when: { state: ['NEW'] },
      fields: '',
      navigate: 'Lead',
      async run(session, doc, _body, { actor }) {
        const lead = await createDoc(session, 'Lead', { leadName: doc.fromName || doc.fromAddress, email: doc.fromAddress, requirement: `${doc.subject}\n\n${doc.body}`.slice(0, 15000) }, actor);
        doc.state = 'DONE';
        await doc.save({ session });
        return lead;
      },
    },
    {
      key: 'ignore',
      label: 'Ignore',
      when: { state: ['NEW'] },
      fields: '',
      async run(session, doc) {
        doc.state = 'IGNORED';
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

/* ---------- SMS ---------- */

const PHONE = /^\+?[0-9]{10,15}$/;
const cleanNumber = (text) => String(text ?? '').replace(/[\s()-]/g, '');

define({
  name: 'SmsMessage',
  module: 'platform',
  labelFields: ['toNumber'],
  fields: 'toNumber! body!:long status~:select(QUEUED,SENT,FAILED,NOT_CONFIGURED)=QUEUED attempts~:int error~ sentAt~:datetime',
  list: 'toNumber status attempts sentAt',
  prepare(_session, data) {
    const toNumber = cleanNumber(data.toNumber);
    if (!PHONE.test(toNumber)) throw rule('That is not a phone number.', 'BAD_PHONE');
    return { ...data, toNumber };
  },
});

define({
  name: 'SmsCenter',
  module: 'platform',
  labelFields: ['title'],
  label: 'SMS center',
  fields: 'title! audience:select(LIST,ALL_CUSTOMERS,ALL_SUPPLIERS,ALL_EMPLOYEES)=LIST numbers:long body!:long queued~:int skipped~:int',
  list: 'title audience queued skipped',
  hint: 'For a list, put numbers separated by commas or new lines. Messages wait in the queue until an SMS provider is set up on the server.',
  actions: [{
    key: 'send',
    label: 'Queue the messages',
    primary: true,
    when: { queued: [0] },
    fields: '',
    async run(session, doc, _body, { actor }) {
      let raw = [];
      if (doc.audience === 'LIST') raw = String(doc.numbers).split(/[,;\n]+/);
      else if (doc.audience === 'ALL_EMPLOYEES') raw = (await modelOf('Employee').find({ state: 'ACTIVE' }, { mobile: 1 }).session(session).lean()).map((e) => e.mobile);
      else raw = (await Party.find(doc.audience === 'ALL_CUSTOMERS' ? { isCustomer: true } : { isSupplier: true }, { phone: 1 }).session(session).lean()).map((p) => p.phone);
      const numbers = [...new Set(raw.map(cleanNumber).filter(Boolean))];
      const good = numbers.filter((n) => PHONE.test(n));
      if (good.length === 0) throw rule('None of these is a phone number.', 'NO_RECIPIENTS');
      for (const toNumber of good) await createDoc(session, 'SmsMessage', { toNumber, body: doc.body }, actor);
      doc.queued = good.length;
      doc.skipped = raw.length - good.length;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Bank statements ---------- */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// Indian bank statements write dates day first, so 03/04/2026 is read as 3 April here.
export function statementDate(text) {
  const value = String(text ?? '').trim();
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let date = null;
  if (match) date = `${match[1]}-${match[2]}-${match[3]}`;
  match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (match) date = `${match[3].length === 2 ? `20${match[3]}` : match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = value.match(/^(\d{1,2})[ /-]([A-Za-z]{3})[a-z]*[ /-](\d{2}|\d{4})$/);
  if (match && MONTHS[match[2].toLowerCase()]) date = `${match[3].length === 2 ? `20${match[3]}` : match[3]}-${MONTHS[match[2].toLowerCase()]}-${match[1].padStart(2, '0')}`;
  return date && isDateString(date) ? date : null;
}

extend('BankTransaction', { fields: 'fingerprint~ journalId~', index: [{ bankAccountId: 1, fingerprint: 1 }] });

const statementMoney = (text, line, name) => {
  const clean = String(text ?? '').replace(/,/g, '').replace(/^(Rs\.?|INR|₹)\s*/i, '').trim();
  if (clean === '' || clean === '-') return 0;
  try {
    return Math.abs(scaledInt(clean, 2));
  } catch {
    throw rule(`Line ${line}: "${text}" in ${name} is not an amount.`, 'BAD_AMOUNT');
  }
};

define({
  name: 'BankStatementImport',
  module: 'accounts',
  series: 'BSI',
  labelFields: ['docNo'],
  label: 'Bank statement import',
  fields: 'bankAccountId!:link(BankAccount) dateColumn=date descriptionColumn=description referenceColumn=reference withdrawalColumn=withdrawal depositColumn=deposit loaded~:int duplicates~:int matched~:int journalsDrafted~:int',
  list: 'docNo bankAccountId loaded duplicates matched journalsDrafted',
  hint: 'Name the columns as your bank has them. Dates are read day first, as Indian banks write them.',
  actions: [
    {
      key: 'load',
      label: 'Load statement',
      primary: true,
      when: {},
      fields: 'csv!:bigtext',
      async run(session, doc, body, { actor }) {
        const rows = parseCsv(body.csv);
        // Banks often put a few lines above the table, so find the heading row.
        const wanted = [doc.dateColumn, doc.withdrawalColumn, doc.depositColumn].map((c) => c.trim().toLowerCase());
        const headerAt = rows.findIndex((row) => wanted.every((name) => row.map((c) => c.trim().toLowerCase()).includes(name)));
        if (headerAt < 0) throw rule(`No row has the columns ${wanted.join(', ')}.`, 'BAD_COLUMNS');
        const header = rows[headerAt].map((c) => c.trim().toLowerCase());
        const col = (name) => header.indexOf(String(name).trim().toLowerCase());
        const at = { date: col(doc.dateColumn), description: col(doc.descriptionColumn), reference: col(doc.referenceColumn), withdrawal: col(doc.withdrawalColumn), deposit: col(doc.depositColumn) };
        const Tx = modelOf('BankTransaction');
        const seenInFile = new Map();
        let loaded = 0;
        let duplicates = 0;
        for (let index = headerAt + 1; index < rows.length; index += 1) {
          const row = rows[index];
          const onDate = statementDate(row[at.date]);
          // A closing line or a page footer has no date. Only those may be skipped.
          if (!onDate) {
            if (row[at.date]?.trim() && (row[at.withdrawal]?.trim() || row[at.deposit]?.trim())) throw rule(`Line ${index + 1}: "${row[at.date]}" is not a date.`, 'BAD_DATE');
            continue;
          }
          const withdrawalPaise = statementMoney(row[at.withdrawal], index + 1, 'withdrawals');
          const depositPaise = statementMoney(row[at.deposit], index + 1, 'deposits');
          if (withdrawalPaise === 0 && depositPaise === 0) continue;
          const reference = at.reference >= 0 ? (row[at.reference] ?? '').trim().slice(0, 300) : '';
          const description = at.description >= 0 ? (row[at.description] ?? '').trim().slice(0, 500) : '';
          // Two identical lines in one file can be real, so the file's own count is part of
          // the key. Loading the same file twice still finds them all as duplicates.
          const base = [onDate, withdrawalPaise, depositPaise, reference, description].join('|');
          const count = (seenInFile.get(base) ?? 0) + 1;
          seenInFile.set(base, count);
          const fingerprint = `${base}|${count}`;
          if (await Tx.exists({ bankAccountId: String(doc.bankAccountId), fingerprint }).session(session)) {
            duplicates += 1;
            continue;
          }
          const created = await createDoc(session, 'BankTransaction', { bankAccountId: String(doc.bankAccountId), onDate, withdrawalPaise, depositPaise, reference, description }, actor);
          created.fingerprint = fingerprint;
          await created.save({ session });
          loaded += 1;
        }
        doc.loaded += loaded;
        doc.duplicates += duplicates;
        await doc.save({ session });
        return doc;
      },
    },
    {
      // Only marks what is certain: the reference names the voucher, or exactly one voucher
      // has that amount within a few days. Anything else stays for a person to match.
      key: 'autoMatch',
      label: 'Match to the books',
      when: {},
      fields: 'withinDays:int=5',
      async run(session, doc, body) {
        const bank = await modelOf('BankAccount').findById(doc.bankAccountId).session(session).lean();
        const Tx = modelOf('BankTransaction');
        const open = await Tx.find({ bankAccountId: String(doc.bankAccountId), state: 'UNRECONCILED' }).session(session);
        const used = new Set((await Tx.find({ bankAccountId: String(doc.bankAccountId), voucherNo: { $nin: ['', null] } }, { voucherNo: 1 }).session(session).lean()).map((t) => t.voucherNo));
        const entries = await GlEntry.find({ accountCode: bank.accountCode }).session(session).lean();
        const vouchers = new Map();
        for (const entry of entries) {
          const row = vouchers.get(entry.voucherNo) ?? { voucherNo: entry.voucherNo, net: 0, onDate: entry.postingDate, reversed: false };
          row.net += entry.debitPaise - entry.creditPaise;
          if (entry.isReversal) row.reversed = true;
          vouchers.set(entry.voucherNo, row);
        }
        const free = [...vouchers.values()].filter((v) => !v.reversed && v.net !== 0 && !used.has(v.voucherNo));
        const days = body.withinDays ?? 5;
        let matched = 0;
        for (const tx of open) {
          const net = tx.depositPaise - tx.withdrawalPaise;
          const text = `${tx.reference} ${tx.description}`.toUpperCase();
          const sameAmount = free.filter((v) => v.net === net && !used.has(v.voucherNo));
          const named = sameAmount.filter((v) => text.includes(v.voucherNo.toUpperCase()));
          const near = sameAmount.filter((v) => Math.abs(daysBetween(v.onDate, tx.onDate)) <= days);
          let pick = null;
          if (named.length === 1) [pick] = named;
          else if (named.length === 0 && near.length === 1) [pick] = near;
          if (!pick) continue;
          tx.voucherNo = pick.voucherNo;
          tx.state = 'RECONCILED';
          tx.clearedOn = tx.onDate;
          await tx.save({ session });
          used.add(pick.voucherNo);
          matched += 1;
        }
        doc.matched += matched;
        await doc.save({ session });
        return doc;
      },
    },
    {
      // Bank charges and interest have no voucher yet. The rules draft one, and a person
      // still reviews and submits it. Control accounts are left out, as a journal cannot use them.
      key: 'draftJournals',
      label: 'Draft journals from rules',
      when: {},
      fields: '',
      async run(session, doc, _body, { actor }) {
        const bank = await modelOf('BankAccount').findById(doc.bankAccountId).session(session).lean();
        const rules = await modelOf('BankTransactionRule').find({ isActive: true, accountCode: { $nin: [null, ''] } }).session(session).lean();
        const open = await modelOf('BankTransaction').find({ bankAccountId: String(doc.bankAccountId), state: 'UNRECONCILED', journalId: { $in: ['', null] } }).session(session);
        let drafted = 0;
        for (const tx of open) {
          const text = `${tx.reference} ${tx.description}`.toLowerCase();
          const hit = rules.find((r) => text.includes(r.descriptionContains.toLowerCase()));
          if (!hit) continue;
          const amount = tx.depositPaise + tx.withdrawalPaise;
          const isIn = tx.depositPaise > 0;
          const lines = [
            { accountCode: bank.accountCode, ...(isIn ? { debitPaise: amount } : { creditPaise: amount }) },
            { accountCode: hit.accountCode, ...(isIn ? { creditPaise: amount } : { debitPaise: amount }) },
          ];
          let data;
          try {
            data = await journalService.prepare(session, { postingDate: tx.onDate, narration: `${hit.name}: ${tx.description || tx.reference}`.slice(0, 300), lines });
          } catch (error) {
            if (error.code === 'CONTROL_ACCOUNT') continue;
            throw error;
          }
          const [journal] = await Journal.create([{ ...data, createdBy: actor.id }], { session });
          tx.journalId = String(journal._id);
          await tx.save({ session });
          drafted += 1;
        }
        doc.journalsDrafted += drafted;
        await doc.save({ session });
        return doc;
      },
    },
  ],
});

/* ---------- Payment links ---------- */

extend('PaymentRequest', {
  fields: 'gatewayLinkId~ gatewayUrl~ gatewayPaymentId~ paymentId~',
  actions: [{
    key: 'makeLink',
    label: 'Make a payment link',
    when: { state: ['DRAFT', 'SENT'], kind: ['INWARD'], gatewayLinkId: ['', null] },
    fields: '',
    async run(session, doc) {
      const party = await Party.findById(doc.partyId).session(session).lean();
      const link = await createPaymentLink({
        amountPaise: doc.amountPaise,
        referenceId: doc.docNo,
        description: `Payment request ${doc.docNo}`,
        customer: { name: party?.name ?? '', ...(doc.email || party?.email ? { email: doc.email || party.email } : {}), ...(party?.phone ? { contact: party.phone } : {}) },
      });
      doc.gatewayLinkId = link.id;
      doc.gatewayUrl = link.url;
      await doc.save({ session });
      return doc;
    },
  }],
});

/* ---------- Website ---------- */

const SLUG = /^[a-z0-9-]{1,60}$/;

// Pages are built from blocks of plain text, so nothing typed can run in a visitor's browser.
define({
  name: 'WebPage',
  module: 'platform',
  label: 'Web page',
  labelFields: ['title'],
  fields: 'title!* slug!* isPublished:check showInMenu:check=true sortOrder:int metaDescription',
  tables: { blocks: 'kind!:select(HEADING,TEXT,CATALOGUE,ENQUIRY)=TEXT text:long' },
  list: 'title slug isPublished showInMenu sortOrder',
  deletable: true,
  hint: 'The page called home opens at /site. Others open at /site/your-slug.',
  prepare(_session, data) {
    if (!SLUG.test(data.slug)) throw rule('A slug uses lowercase letters, numbers and dashes.', 'BAD_SLUG');
    return data;
  },
});

/* ---------- Languages ---------- */

define({
  name: 'Translation',
  module: 'setup',
  labelFields: ['sourceText'],
  fields: 'language!:select(hi,gu) sourceText! translatedText!',
  list: 'language sourceText translatedText',
  searchFields: ['sourceText', 'translatedText'],
  index: [{ language: 1, sourceText: 1 }],
  deletable: true,
  hint: 'Replaces the built-in wording for that exact English text.',
  async prepare(session, data, { existing }) {
    const clash = await modelOf('Translation').exists({ _id: { $ne: existing?._id ?? null }, language: data.language, sourceText: data.sourceText }).session(session);
    if (clash) throw rule('That text already has a translation in this language.', 'DUPLICATE');
    return data;
  },
});

/* ---------- Tools ---------- */

// A code is frozen on documents already made, so old documents keep showing the old code.
define({
  name: 'RenameTool',
  module: 'setup',
  labelFields: ['oldCode'],
  fields: 'target:select(ITEM,PARTY)=ITEM oldCode! newCode! isDone~:check',
  list: 'target oldCode newCode isDone',
  hint: 'Documents already made keep the code they were made with, as they are records of what happened.',
  actions: [{
    key: 'rename',
    label: 'Rename',
    primary: true,
    when: { isDone: [false] },
    fields: '',
    async run(session, doc) {
      const { Item } = await import('../models/masters.js');
      const Model = doc.target === 'PARTY' ? Party : Item;
      const oldCode = doc.oldCode.trim().toUpperCase();
      const newCode = doc.newCode.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._/-]{0,59}$/.test(newCode)) throw rule('A code uses letters, numbers, dots, dashes and slashes.', 'BAD_CODE');
      const row = await Model.findOne({ code: oldCode }).session(session);
      if (!row) throw rule(`Nothing has the code ${oldCode}.`, 'LINK_NOT_FOUND');
      if (await Model.exists({ code: newCode }).session(session)) throw rule(`${newCode} is already in use.`, 'DUPLICATE');
      row.code = newCode;
      await row.save({ session });
      doc.isDone = true;
      await doc.save({ session });
      return doc;
    },
  }],
});

// Rolls the bill of materials up into each assembly's standard cost, from the bottom.
define({
  name: 'StandardCostRollup',
  module: 'manufacturing',
  series: 'SCR',
  labelFields: ['docNo'],
  label: 'Standard cost roll-up',
  fields: 'includeLabour:check=true updated~:int',
  tables: { 'changes~': 'code name oldPaise:money newPaise:money' },
  list: 'docNo updated',
  hint: 'Parts with no standard cost count as nothing, so set those first. This does not change the value of stock.',
  actions: [{
    key: 'run',
    label: 'Work out and save',
    primary: true,
    when: { updated: [0] },
    fields: '',
    async run(session, doc) {
      const { Item } = await import('../models/masters.js');
      const { Bom } = await import('../models/documents.js');
      const { getSettings } = await import('../services/settingsService.js');
      const { applyBps, lineValue, sumInts } = await import('../utils/money.js');
      const settings = await getSettings(session);
      const boms = await Bom.find({ status: 'RELEASED' }).session(session).lean();
      const byItem = new Map(boms.map((b) => [String(b.itemId), b]));
      const items = new Map((await Item.find({}, { code: 1, name: 1, standardCostPaise: 1, type: 1 }).session(session).lean()).map((i) => [String(i._id), i]));
      const memo = new Map();
      const costOf = (id, path = []) => {
        if (memo.has(id)) return memo.get(id);
        if (path.includes(id)) throw rule('These BOMs contain a loop.', 'BOM_LOOP');
        const bom = byItem.get(id);
        const item = items.get(id);
        if (!bom || !['ASSEMBLY', 'MACHINE'].includes(item?.type)) return item?.standardCostPaise ?? 0;
        const parts = sumInts(bom.lines.map((line) => lineValue(line.qtyMilli + applyBps(line.qtyMilli, line.scrapBps ?? 0), costOf(String(line.itemId), [...path, id]))));
        const total = parts + (doc.includeLabour ? lineValue(bom.labourHoursMilli ?? 0, settings.labourRatePaise ?? 0) : 0);
        memo.set(id, total);
        return total;
      };
      for (const id of byItem.keys()) costOf(id);
      const changes = [];
      for (const [id, newPaise] of memo) {
        const item = items.get(id);
        if (item.standardCostPaise === newPaise) continue;
        changes.push({ code: item.code, name: item.name, oldPaise: item.standardCostPaise ?? 0, newPaise });
        await Item.updateOne({ _id: id }, { standardCostPaise: newPaise }, { session });
      }
      if (changes.length === 0) throw rule('Every standard cost is already up to date.', 'NOTHING_CHANGED');
      doc.changes = changes;
      doc.updated = changes.length;
      await doc.save({ session });
      return doc;
    },
  }],
});

