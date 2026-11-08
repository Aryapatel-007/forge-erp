import { Settings } from '../models/core.js';
import { Account } from '../models/masters.js';
import { DEFAULT_ACCOUNTS } from '../config/accounts.js';
import { rule } from '../utils/errors.js';
import { isDateString, todayIst } from '../utils/dates.js';

export async function getSettings(session) {
  let settings = await Settings.findById('company').session(session ?? null);
  if (!settings) {
    await Settings.updateOne({ _id: 'company' }, { $setOnInsert: { _id: 'company' } }, { upsert: true, session });
    settings = await Settings.findById('company').session(session ?? null);
  }
  return settings;
}

// Safe to run on every boot: it only adds what is missing.
export async function ensureDefaults() {
  await getSettings();
  await Promise.all(DEFAULT_ACCOUNTS.map((account) => Account.updateOne(
    { code: account.code },
    { $setOnInsert: account },
    { upsert: true },
  )));
}

export function assertPostingDate(date, settings) {
  if (!isDateString(date)) throw rule('The posting date is not a real date.', 'INVALID_DATE');
  if (date > todayIst()) throw rule('A document cannot be posted in the future.', 'FUTURE_DATE');
  if (settings.booksLockedUpTo && date <= settings.booksLockedUpTo) {
    throw rule(`The books are locked up to ${settings.booksLockedUpTo}.`, 'PERIOD_LOCKED');
  }
}
