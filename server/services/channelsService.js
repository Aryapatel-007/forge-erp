// Everything that talks to the outside: reading mail, SMS, exchange rates and payment links.
// Each stays off until it has been given its address and credentials on the server.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { modelOf } from '../engine/registry.js';
import { createDoc } from '../engine/documents.js';
import { Comment } from '../models/platform.js';
import { Payment, PurchaseOrder, Quotation, SalesInvoice, SalesOrder, PurchaseInvoice } from '../models/documents.js';
import { A } from '../config/accounts.js';
import { payment as paymentService } from './accountsService.js';
import { audit } from './auditService.js';
import { Pop3Client } from './pop3Client.js';
import { withTxn } from '../utils/txn.js';
import { todayIst } from '../utils/dates.js';
import { conflict, rule } from '../utils/errors.js';

const MAX_BODY = 100000;
const SYSTEM = { id: null, name: 'Mail reader', role: 'ADMIN' };

/* ---------- Reading a message ---------- */

function decodeBytes(bytes, charset = 'utf-8') {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

const quotedPrintable = (text) => {
  const joined = text.replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < joined.length; i += 1) {
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(joined.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(bytes);
};

// Encoded words in a header, like =?UTF-8?B?...?=.
const decodeHeader = (value) => String(value ?? '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, kind, text) => {
  const bytes = kind.toLowerCase() === 'b'
    ? Buffer.from(text, 'base64')
    : quotedPrintable(text.replace(/_/g, ' '));
  return decodeBytes(bytes, charset);
});

function splitHeaders(raw) {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

const param = (header, name) => header?.match(new RegExp(`${name}="?([^";]+)"?`, 'i'))?.[1];

function decodePart(headers, body) {
  const encoding = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const charset = param(headers['content-type'], 'charset') ?? 'utf-8';
  if (encoding === 'base64') return decodeBytes(Buffer.from(body.replace(/\s+/g, ''), 'base64'), charset);
  if (encoding === 'quoted-printable') return decodeBytes(quotedPrintable(body), charset);
  return decodeBytes(Buffer.from(body, 'latin1'), charset);
}

// Only ever used as plain text. Nothing from an email reaches a page as markup.
const htmlToText = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function textOf(headers, body, depth = 0) {
  const type = (headers['content-type'] ?? 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return { plain: '', html: '' };
    const found = { plain: '', html: '' };
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const part = splitHeaders(chunk.replace(/^\r?\n/, ''));
      if (/attachment/i.test(part.headers['content-disposition'] ?? '')) continue;
      const inner = textOf(part.headers, part.body, depth + 1);
      found.plain ||= inner.plain;
      found.html ||= inner.html;
    }
    return found;
  }
  if (type.startsWith('text/html')) return { plain: '', html: decodePart(headers, body) };
  if (type.startsWith('text/')) return { plain: decodePart(headers, body), html: '' };
  return { plain: '', html: '' };
}

export function parseEmail(raw) {
  const { headers, body } = splitHeaders(raw);
  const { plain, html } = textOf(headers, body);
  const from = decodeHeader(headers.from);
  const address = from.match(/<([^>]+)>/)?.[1] ?? from.trim();
  const sent = new Date(headers.date ?? '');
  return {
    fromAddress: address.toLowerCase(),
    fromName: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim(),
    subject: decodeHeader(headers.subject).slice(0, 500),
    body: (plain || htmlToText(html)).trim().slice(0, MAX_BODY),
    sentAt: Number.isNaN(sent.getTime()) ? null : sent,
  };
}

/* ---------- Filing a message ---------- */

// Core documents store their comments under the name of their screen.
const CORE = [
  [Quotation, 'quotations'], [SalesOrder, 'salesOrders'], [SalesInvoice, 'salesInvoices'],
  [PurchaseOrder, 'purchaseOrders'], [PurchaseInvoice, 'purchaseInvoices'], [Payment, 'payments'],
];
const DOC_NO = /\b([A-Z]{2,5}\/[0-9-]+\/\d{3,})\b/;

async function findDocument(session, docNo, engineTypes) {
  for (const [Model, entityType] of CORE) {
    const row = await Model.findOne({ docNo }, { _id: 1 }).session(session).lean();
    if (row) return { entityType, entityId: row._id };
  }
  const prefix = docNo.split('/')[0];
  for (const type of engineTypes.filter((t) => t.series === prefix)) {
    const row = await type.Model.findOne({ docNo }, { _id: 1 }).session(session).lean();
    if (row) return { entityType: type.name, entityId: row._id };
  }
  return null;
}

// A subject that names a document files the mail on that document as a comment. Everything
// else waits in the inbox for a person. Mail is never acted on by itself.
async function fileEmail(session, uid, message, engineTypes) {
  const docNo = message.subject.match(DOC_NO)?.[1] ?? null;
  const target = docNo ? await findDocument(session, docNo, engineTypes) : null;
  if (target) {
    await Comment.create([{ ...target, body: `Email from ${message.fromName || message.fromAddress}: ${message.subject}\n\n${message.body}`.slice(0, 5000), byName: message.fromAddress }], { session });
  }
  await createDoc(session, 'InboundEmail', {
    uid,
    fromAddress: message.fromAddress,
    fromName: message.fromName,
    subject: message.subject || '(no subject)',
    body: message.body,
    sentAt: message.sentAt ? message.sentAt.toISOString() : null,
    state: target ? 'FILED' : 'NEW',
    filedOn: target ? docNo : '',
  }, SYSTEM);
  return Boolean(target);
}

export async function readMailbox({ client: given = null, env = process.env } = {}) {
  if (!given && !env.POP3_HOST) return { skipped: 'No mailbox is set up.' };
  const client = given ?? new Pop3Client({ host: env.POP3_HOST, port: Number(env.POP3_PORT ?? 995) });
  const { allTypes } = await import('../engine/registry.js');
  const engineTypes = allTypes().filter((t) => t.series);
  await client.open();
  let read = 0;
  let filed = 0;
  try {
    await client.login(env.POP3_USER, env.POP3_PASSWORD);
    const messages = await client.list();
    const known = new Set((await modelOf('InboundEmail').find({ uid: { $in: messages.map((m) => m.uid) } }, { uid: 1 }).lean()).map((row) => row.uid));
    for (const { number, uid } of messages) {
      if (known.has(uid)) {
        if (env.POP3_DELETE === 'true') await client.remove(number);
        continue;
      }
      const message = parseEmail(await client.retrieve(number));
      if (await withTxn((session) => fileEmail(session, uid, message, engineTypes))) filed += 1;
      read += 1;
      if (env.POP3_DELETE === 'true') await client.remove(number);
    }
  } finally {
    await client.close();
  }
  return { read, filed };
}

/* ---------- SMS ---------- */

// Sends through any provider that takes a JSON POST. In India, bulk SMS also needs its
// templates registered with the operator's DLT system, which is done with the provider.
export async function flushSms({ fetchFn = fetch, env = process.env } = {}) {
  const Sms = modelOf('SmsMessage');
  const queued = await Sms.find({ status: { $in: ['QUEUED', 'NOT_CONFIGURED'] }, attempts: { $lt: 5 } }).sort({ createdAt: 1 }).limit(50);
  if (queued.length === 0) return 0;
  if (!env.SMS_URL) {
    await Sms.updateMany({ _id: { $in: queued.map((m) => m._id) } }, { status: 'NOT_CONFIGURED' });
    return 0;
  }
  let sent = 0;
  for (const message of queued) {
    message.attempts += 1;
    try {
      const response = await fetchFn(env.SMS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.SMS_TOKEN ? { authorization: `Bearer ${env.SMS_TOKEN}` } : {}) },
        body: JSON.stringify({ to: message.toNumber, message: message.body, sender: env.SMS_SENDER ?? undefined }),
      });
      if (!response.ok) throw new Error(`The SMS provider answered ${response.status}.`);
      message.status = 'SENT';
      message.sentAt = new Date();
      message.error = '';
      sent += 1;
    } catch (error) {
      message.status = message.attempts >= 5 ? 'FAILED' : 'QUEUED';
      message.error = error.message.slice(0, 300);
    }
    await message.save();
  }
  return sent;
}

/* ---------- Exchange rates ---------- */

// Fetched rates are a guide for the person typing a document, and never change one by
// themselves. Customs and your bank use their own rates.
export async function fetchExchangeRates({ fetchFn = fetch, env = process.env, onDate = todayIst() } = {}) {
  if (!env.FX_RATE_URL) return { skipped: 'No exchange rate address is set up.' };
  const currencies = await modelOf('Currency').find({ isActive: true, code: { $ne: 'INR' } }).lean();
  const Rate = modelOf('CurrencyExchange');
  let saved = 0;
  const problems = [];
  for (const currency of currencies) {
    if (await Rate.exists({ fromCurrency: currency.code, toCurrency: 'INR', onDate })) continue;
    try {
      const response = await fetchFn(`${env.FX_RATE_URL}?base=${encodeURIComponent(currency.code)}&symbols=INR`);
      if (!response.ok) throw new Error(`answered ${response.status}`);
      const rate = (await response.json())?.rates?.INR;
      if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('gave no rate');
      await withTxn((session) => createDoc(session, 'CurrencyExchange', { fromCurrency: currency.code, toCurrency: 'INR', rateFx4: Math.round(rate * 10000), onDate }, { id: null, name: 'Exchange rates', role: 'ADMIN' }));
      saved += 1;
    } catch (error) {
      problems.push(`${currency.code}: ${error.message}`);
    }
  }
  return { saved, problems };
}

/* ---------- Payment links ---------- */

const RAZORPAY_URL = 'https://api.razorpay.com/v1/payment_links';

export async function createPaymentLink({ amountPaise, referenceId, description, customer }, { fetchFn = fetch, env = process.env } = {}) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) throw rule('Payment links are not set up. They need Razorpay keys on the server.', 'GATEWAY_NOT_CONFIGURED');
  const response = await fetchFn(RAZORPAY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      reference_id: String(referenceId).slice(0, 40),
      description: String(description).slice(0, 2048),
      customer,
      notify: { sms: false, email: false },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id || !body?.short_url) throw rule(`Razorpay refused this: ${body?.error?.description ?? response.status}`, 'GATEWAY_REFUSED');
  return { id: body.id, url: body.short_url };
}

// Razorpay signs the raw bytes of the request with the webhook secret, as hex.
export function razorpaySignatureOk(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const GATEWAY_ACTOR = { id: null, name: 'Razorpay', role: 'ADMIN' };

// Runs at most once for a link, however many times Razorpay delivers the event. The money
// goes against the invoice at its full amount. Razorpay's fee comes off the settlement, and
// has to be booked from the settlement report, because the paid event does not carry it here.
export async function recordLinkPaid(session, event, env = process.env) {
  const link = event?.payload?.payment_link?.entity;
  const paymentId = event?.payload?.payment?.entity?.id;
  if (event?.event !== 'payment_link.paid' || !link?.id) return { ignored: true };
  const request = await modelOf('PaymentRequest').findOne({ gatewayLinkId: link.id }).session(session);
  if (!request) return { ignored: true, reason: 'No request has that link.' };
  if (request.state === 'PAID') return { alreadyDone: true };
  if (link.amount_paid !== request.amountPaise) {
    throw conflict(`Razorpay reports ${link.amount_paid}, and the request was for ${request.amountPaise}.`, 'GATEWAY_AMOUNT_MISMATCH');
  }
  const data = await paymentService.prepare(session, {
    kind: 'RECEIPT',
    partyId: String(request.partyId),
    bankAccountCode: env.RAZORPAY_BANK_ACCOUNT_CODE || A.BANK,
    amountMinor: request.amountPaise,
    reference: paymentId ?? link.id,
    postingDate: todayIst(),
    ...(request.salesInvoiceId ? { allocations: [{ docId: String(request.salesInvoiceId), amountMinor: request.amountPaise }] } : {}),
  });
  const [payment] = await Payment.create([{ ...data, createdBy: null }], { session });
  const result = await paymentService.submit(session, payment, { actor: GATEWAY_ACTOR, body: {}, settings: null });
  await payment.save({ session });
  await audit(session, { actor: GATEWAY_ACTOR, action: result?.action ?? 'PAYMENT_SUBMITTED', entityType: 'Payment', entityId: payment._id, entityNo: payment.docNo, data: { gatewayLinkId: link.id, gatewayPaymentId: paymentId } });
  request.state = 'PAID';
  request.gatewayPaymentId = paymentId ?? '';
  request.paymentId = String(payment._id);
  await request.save({ session });
  return { paymentId: String(payment._id) };
}
