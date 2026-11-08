import { GlEntry } from '../models/ledgers.js';
import { Account } from '../models/masters.js';
import { rule } from '../utils/errors.js';
import { assertPostingDate, getSettings } from './settingsService.js';
import { getType } from '../engine/registry.js';
import { fyRange } from '../utils/dates.js';

// A STOP budget refuses the voucher that would exceed it, however the voucher was raised.
async function assertBudgets(session, rows, postingDate) {
  const Budget = getType('Budget')?.Model;
  if (!Budget) return;
  const { from, to } = fyRange(postingDate);
  for (const row of rows) {
    if (!row.costCenterId || row.debitPaise <= 0) continue;
    const budget = await Budget.findOne({ costCenterId: String(row.costCenterId), accountCode: row.accountCode, onExceed: 'STOP' }).session(session).lean();
    if (!budget) continue;
    const year = await getType('FiscalYear').Model.findById(budget.fiscalYearId).session(session).lean();
    if (year && (postingDate < year.startDate || postingDate > year.endDate)) continue;
    const [spent] = await GlEntry.aggregate([
      { $match: { costCenterId: String(row.costCenterId), accountCode: row.accountCode, postingDate: { $gte: year?.startDate ?? from, $lte: year?.endDate ?? to } } },
      { $group: { _id: null, net: { $sum: { $subtract: ['$debitPaise', '$creditPaise'] } } } },
    ]).session(session);
    if ((spent?.net ?? 0) + row.debitPaise > budget.amountPaise) {
      throw rule(`This goes over the budget for account ${row.accountCode}: Rs ${budget.amountPaise / 100} allowed, Rs ${((spent?.net ?? 0) + row.debitPaise) / 100} needed.`, 'BUDGET_EXCEEDED');
    }
  }
}

// An account can require a cost centre or project, or limit which ones may be used.
async function assertDimensions(session, rows) {
  const Filter = getType('AccountingDimensionFilter')?.Model;
  if (!Filter) return;
  const filters = await Filter.find({ accountCode: { $in: rows.map((r) => r.accountCode) } }).session(session).lean();
  for (const filter of filters) {
    const key = filter.dimension === 'PROJECT' ? 'projectId' : 'costCenterId';
    const label = filter.dimension === 'PROJECT' ? 'project' : 'cost centre';
    for (const row of rows.filter((r) => r.accountCode === filter.accountCode)) {
      const value = row[key] ? String(row[key]) : null;
      if (!value && filter.isMandatory) throw rule(`Account ${filter.accountCode} needs a ${label}.`, 'DIMENSION_REQUIRED');
      if (value && filter.allowed.length > 0 && !filter.allowed.some((a) => a.valueId === value)) throw rule(`That ${label} cannot be used on account ${filter.accountCode}.`, 'DIMENSION_NOT_ALLOWED');
    }
  }
}

// Posts one balanced voucher. Lines with both sides zero are dropped.
// lines: [{ accountCode, debitPaise, creditPaise, partyId, buildId, narration }]
export async function postGl(session, { postingDate, voucherType, voucherId, voucherNo, narration = '', lines, isReversal = false }) {
  const settings = await getSettings(session);
  assertPostingDate(postingDate, settings);
  const Period = getType('AccountingPeriod')?.Model;
  if (Period) {
    const closed = await Period.findOne({ isClosed: true, startDate: { $lte: postingDate }, endDate: { $gte: postingDate } }).session(session).lean();
    if (closed) throw rule(`${closed.name} is closed.`, 'PERIOD_CLOSED');
  }

  const rows = lines
    .map((line) => ({ debitPaise: 0, creditPaise: 0, ...line }))
    .filter((line) => line.debitPaise !== 0 || line.creditPaise !== 0);
  if (rows.length === 0) return [];
  if (!isReversal) await assertDimensions(session, rows);

  let debit = 0;
  let credit = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.debitPaise) || !Number.isSafeInteger(row.creditPaise)
      || row.debitPaise < 0 || row.creditPaise < 0) {
      throw new RangeError(`A voucher line must be a positive whole number of paise: ${row.accountCode}`);
    }
    if (row.debitPaise > 0 && row.creditPaise > 0) {
      throw new RangeError(`A voucher line cannot be both a debit and a credit: ${row.accountCode}`);
    }
    debit += row.debitPaise;
    credit += row.creditPaise;
  }
  if (debit !== credit) {
    throw rule(`Voucher ${voucherNo} does not balance: debit ${debit}, credit ${credit}.`, 'UNBALANCED_VOUCHER');
  }

  const codes = [...new Set(rows.map((row) => row.accountCode))];
  const accounts = await Account.find({ code: { $in: codes } }, { code: 1, isActive: 1 }).session(session).lean();
  for (const code of codes) {
    const account = accounts.find((a) => a.code === code);
    if (!account) throw rule(`Account ${code} does not exist.`, 'UNKNOWN_ACCOUNT');
    if (!account.isActive) throw rule(`Account ${code} is switched off.`, 'INACTIVE_ACCOUNT');
  }

  if (!isReversal) await assertBudgets(session, rows, postingDate);

  const entries = rows.map((row) => ({
    postingDate,
    voucherType,
    voucherId,
    voucherNo,
    accountCode: row.accountCode,
    debitPaise: row.debitPaise,
    creditPaise: row.creditPaise,
    partyId: row.partyId ?? null,
    buildId: row.buildId ?? null,
    costCenterId: row.costCenterId ? String(row.costCenterId) : null,
    projectId: row.projectId ? String(row.projectId) : null,
    narration: row.narration ?? narration,
    isReversal,
  }));
  return GlEntry.insertMany(entries, { session });
}

// Mirrors every GL entry of a voucher, dated postingDate. The originals stay.
export async function reverseGl(session, { postingDate, voucherType, voucherId, voucherNo, narration }) {
  const original = await GlEntry.find({ voucherType, voucherId, isReversal: false }).session(session).lean();
  if (original.length === 0) return [];
  return postGl(session, {
    postingDate,
    voucherType,
    voucherId,
    voucherNo,
    isReversal: true,
    lines: original.map((entry) => ({
      accountCode: entry.accountCode,
      debitPaise: entry.creditPaise,
      creditPaise: entry.debitPaise,
      partyId: entry.partyId,
      buildId: entry.buildId,
      costCenterId: entry.costCenterId,
      projectId: entry.projectId,
      narration: narration ?? `Reversal of ${voucherNo}`,
    })),
  });
}
