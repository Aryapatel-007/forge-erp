# Forge ERP: design

An ERP for a company that designs and builds pharmaceutical processing machines
to order (washing, depyrogenation, filling, sealing, inspection, labelling).
One company, one or more plants, Indian GST, exports. MERN.

Forge is written from scratch. ERPNext (GPL-3.0) was studied for its ideas only.
Do not copy code, field lists or text from it, or Forge falls under the GPL.

## 1. What this business does

A machine is sold before it exists. One order runs for months:

    Enquiry -> Quotation (revisions) -> Sales order + advance -> Machine build
    -> BOM snapshot -> Shortages -> Purchase -> Goods receipt -> Incoming QC
    -> Job work (laser, machining, polishing) -> Issue to build -> Labour
    -> FAT with the customer -> Finished -> Balance payment -> Invoice + dispatch
    -> Installation, SAT, IQ/OQ -> Warranty -> AMC, service tickets, spares

So the unit of work is the **machine build**, one per serial number. Stock can be
set aside for a build, and every rupee spent is traceable to one.

## 2. Ideas taken from ERPNext, and what Forge does differently

| Idea studied | Forge |
|---|---|
| Documents go Draft -> Submitted -> Cancelled, and a submitted document never changes | Same. Cancelling posts a reversal. |
| One append-only ledger for stock, one for accounts, each pointing at its voucher | Same. |
| A summary row (Bin) for fast balances | Same, and the Bin also holds value, so average cost is exact. |
| Quality inspection as a report | A hold: goods sit in a quarantine warehouse until accepted. |
| Backdated stock reposts every later entry | Forge does not repost. Cost follows posting order. Simpler to audit, at the cost of no valuation change on backdating. |
| Generic manufacturing work orders | Machine builds, with pegged stock, cost sheets, FAT and serial numbers. |
| GST via a separate app | Built in. |
| Decimal quantities and floats | Integers only: see section 3. |

## 3. Non-negotiable rules

1. Money is whole paise integers, fields ending `Paise`. Foreign money is whole
   minor units, fields ending `Minor`. Rates are basis points, fields ending `Bps`.
2. Quantities are integer thousandths, fields ending `Milli`. 1.5 kg is `1500`.
3. All money and quantity arithmetic lives in `server/utils/money.js`, and tax in
   `server/utils/tax.js`. Both use BigInt internally where products can overflow.
4. Ledgers are append-only. Nothing updates or deletes `glentries`, `stockentries`
   or `auditlogs`. A Mongoose guard stops it in code. In production the database
   role grants only find and insert on them (`npm run db:roles`).
5. Every posting runs in one transaction: document, ledger, stock, audit, or none.
6. Document numbers are reserved inside the transaction that submits the document,
   so an aborted submit leaves no gap. They reset each Indian financial year and
   stay within GST's 16 characters.
7. A voucher's debits equal its credits or it does not post.
8. Stock can never go negative, in any bucket.
9. Permissions are checked on the server on every route.
10. Prices, tax rates, HSN codes and names are copied onto a line when it is made.
    Reports add up those frozen values and never read live masters.
11. Dates that decide the books are `YYYY-MM-DD` strings in India time. Timestamps
    are UTC.
12. GST rates are data on the item, never in code.
13. Nothing posts on or before `booksLockedUpTo`.
14. Whoever raises a purchase order above the limit cannot approve it.

## 4. Stock model

A **bucket** is item + warehouse + lot + build. `buildId: null` is free stock. A
lot is a heat number or batch, so a 316L sheet stays traceable to its certificate.

Warehouses have a kind: `STORES`, `QUARANTINE`, `REJECT`, `JOBWORK`, `FG`.
All of them are the company's own stock in the books, except that FG uses its own
ledger account.

Average cost is per bucket. The Bin holds `qtyMilli` and `valuePaise`. An issue
takes `value * issued / onHand`, rounded, so issuing everything takes all of the
value and rounding can never strand a paisa.

## 5. Postings

| Event | Debit | Credit |
|---|---|---|
| Goods receipt | Inventory | Goods received not billed |
| Purchase invoice (goods) | Goods received not billed, input GST, variance | Supplier |
| Purchase invoice (service, job work) | Expense or WIP, input GST | Supplier |
| Issue to build | WIP | Inventory |
| Return from build | Inventory | WIP |
| Labour booking | WIP | Labour absorbed |
| Build finished | Finished goods | WIP |
| Sales invoice | Customer | Sales, output GST, round-off |
| Goods leaving on the invoice | Cost of goods sold | Finished goods or inventory |
| Receipt | Bank | Customer |
| Payment | Supplier | Bank |
| Export receipt at a different rate | Forex loss, or | Forex gain |
| Stock adjustment | Inventory or stock adjustment | Stock adjustment or inventory |
| Purchase invoice on reverse charge | Expense or GRNI, input GST | Supplier for the bare amount, RCM payable |
| Blocked credit on a purchase | GST not claimable, a cost | Supplier |
| Bill of entry | Input IGST, landed cost clearing for duty | Bank |
| Payment or receipt with deductions | The deduction account, such as TDS | Taken off what moves through the bank |
| GST set-off | Output GST | Input GST |
| Paying the set-off balance | Output GST, RCM payable | Bank |
| Opening sales balance | Customer | Opening balances |
| Opening purchase balance | Opening balances | Supplier |

Job work moves stock to a `JOBWORK` warehouse with no GL entry, because the goods
stay ours. Each challan tracks the GST rule 45 return deadline: one year for
inputs, three for capital goods.

Work orders carry their own WIP. Part issues and returns move at what was issued. A process
loss leaves its cost on the good pieces, unless none remain. Closing short writes what is left
to manufacturing variance. With backflush, each batch takes its own materials plus a share of
the labour so far. Goods needing inspection wait in quarantine as inventory, and become
finished goods on passing. Goods from a job worker carry the materials sent plus the charge,
which waits in a clearing account for the job worker's bill.

## 6. Tax

Same state as the company: CGST + SGST. Different state: IGST. Export: zero-rated
under LUT, or IGST with payment. Tax is rounded once per rate, not per line. CGST
takes the odd paisa. **A chartered accountant must review this before real use.**

The place of supply sets the tax, and it can differ from the customer's state. SEZ is
zero-rated, under LUT or with IGST. Imported goods carry no tax on the supplier's invoice:
IGST is paid on the bill of entry. Exempt, nil-rated and non-GST items carry no tax, whatever
rate is typed.

Credit set-off (`gstSetOff` in `utils/tax.js`): IGST credit goes to IGST first, then to CGST
and SGST where their own credit falls short. CGST and SGST credit go to their own head, then
IGST, and never to each other. Reverse charge is paid in cash only. Set-offs run one at a
time in date order, because an unpaid balance stays in the accounts and would be counted
twice. This order is from general knowledge of the Act and is not yet confirmed.

Opening balances are real invoices marked `isOpening`, so they age and take payments. They
are left out of GST returns, and an IRN cannot be raised on one.

## 7. Modules

| ID | Module | Holds |
|---|---|---|
| M0 | Foundation | Auth, roles, audit chain, numbering, settings, period lock |
| M1 | Masters | Items, parties, warehouses, chart of accounts |
| M2 | Sales | Quotations with revisions, sales orders, payment milestones |
| M3 | Engineering | Machine models, BOM revisions |
| M4 | Builds | Serial numbers, BOM snapshot, shortages, stages, cost sheet |
| M5 | Purchase | Purchase orders with approval, goods receipts, purchase invoices |
| M6 | Stores | Stock ledger, transfers, adjustments, issues, job work challans |
| M7 | Quality | Incoming inspection, NCR, FAT, gauge calibration |
| M8 | Accounts | GL, journals, sales invoices, receipts and payments, forex |
| M9 | Service | Installed machines, warranty, AMC, tickets |
| M10 | Reports | Trial balance, P&L, balance sheet, ageing, GST, stock, integrity |

## 8. Integrity checks

`GET /api/v1/reports/integrity` proves the books on demand. Each check has a test
that breaks it on purpose.

- I1 Every voucher in the GL balances, and the whole GL sums to zero.
- I2 Each Bin equals the sum of its stock entries, in quantity and value.
- I3 Stock value by account equals the GL balance of that account.
- I4 WIP in the GL equals the open cost across builds.
- I5 No bucket is negative.
- I6 The audit hash chain is unbroken.
- I7 No gaps in any document number series.

## 9. Known limits

Tracked openly, not hidden. See `docs/STATUS.md` for what is built and verified.

## 10. How the screens are organised

The structure follows what the large ERPs share. It is not a copy of any of them.

| Idea | Seen in | In Forge |
|---|---|---|
| A bar that is always there, with search and your account | SAP Fiori shell bar, NetSuite global search | Top bar. Ctrl K or / opens search anywhere |
| Home shaped by your role | Business Central role centres, NetSuite dashboards | `HomePage.jsx`, from `/views/home` |
| A launcher of business areas | Odoo, Oracle springboard, Fiori spaces | 13 areas in `config/apps.js` |
| Short menus for the area you are in | Business Central's navigation bar, Odoo's top menu | The area bar. There is no long side menu |
| Standard page layouts | Fiori floorplans, Business Central page types | One list, one record page, one form |
| The next step in view, the rest tucked away | Business Central's action bar | Up to two primary buttons, others under More |
| Related information beside the record | FactBoxes, Odoo chatter | Comments, files and history in a side panel |

`config/apps.js` decides what lives where. Add a new screen there. A document type nobody has
placed still appears in the area for its module, so nothing is ever lost, only less well placed.
Daily work goes in an area's menus, and lookup lists and rules go under its Setup. On a phone,
wide tables become cards, menus rise from the bottom, and a bottom bar holds the essentials.
