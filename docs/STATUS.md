# Forge ERP: status

The truth about what is built and what has been checked. Update this at the end of
every session. Last updated 2026-11-08.

`docs/PARITY.md` is the generated comparison with ERPNext. Run `server/scripts/parity.js`.

## How it is built

- About 30 hand-written documents for the core machine flow, in `server/services`.
- An engine, in `server/engine`: define a document type in `server/doctypes` and it gets a
  model, validation, API, screens, permissions, audit, comments, files, assignments, custom
  fields, workflow, CSV import and export, report builder and search.
- 328 engine document types, 141 reports, 13 scheduled jobs.
- `server/doctypes/logic.js` adds behaviour to types defined elsewhere. It must load first.

## How close to ERPNext

- ERPNext and HRMS have 693 document types: 307 child tables, 386 others.
- Of the 386: 360 matched, 14 do not apply, 0 missing, 12 settings pages and tools not matched.
- **Matched means the job has a home. It does not mean the same depth.**
- Only 127 of the 328 engine types have logic of their own. The other 201 are records: they
  save, validate, link, search, import and report, and do nothing further. Many ERPNext
  equivalents do much more, like scorecard formulas, shift auto-assignment and benefit claims.
- Forge has 141 reports: 128 in the report runner, the rest on fixed screens. ERPNext and
  HRMS have 221.
- Individual documents have far fewer options. ERPNext's sales invoice has 159 data fields.
  Forge's has just under 50.

## Checked

| What | How | Result |
|---|---|---|
| Money, tax, GSTIN, dates | `tests/money.test.js` | 16 pass |
| Ledgers, locks, numbering, audit chain, concurrency | `tests/ledgers.test.js` | 18 pass |
| Machine flow, refusals, cancels, forex, tampering | `tests/erp.test.js` | 25 pass |
| Engine: permissions, computed fields, links, workflow, files, CSV, reports | `tests/engine.test.js` | 22 pass |
| Work orders, MRP, landed cost, assets, POS, payroll, TDS, closing, and every report and job running | `tests/modules.test.js` | 38 pass |
| Reverse charge, imports, SEZ, blocked credit, exempt items, IRN, deductions, set-off, 2B, opening balances, GSTR-1, GSTR-3B, account books | `tests/gst.test.js` | 21 pass |
| Work order depth, MRP, capacity, subcontracting, per-record limits, portal, web forms, backup and restore, CSV import, dashboards, approval limits, closed periods, HR and selling logic | `tests/depth.test.js` | 27 pass |
| Limits on core documents, backward scheduling, OEE, standard cost, bulk submit, website, translations, POP3 mail, SMS, exchange rates, bank statements, Razorpay links, backup copy | `tests/channels.test.js` | 18 pass, against local stand-ins for outside services |
| The server loads in production order | `tests/boot.test.js` | 2 pass |
| Demo seed through the real services | Run on a throwaway database, then dropped | Works |
| Client production build | `npm run build` | Compiles |
| All 128 runner reports and the new routes on the running server, admin login | API calls | All respond, integrity OK |

Tests run file by file against a real replica set: 187 in all, each passing on its last run.
`npm test` as one command has not been run.

## Not checked

- **The Windows setup program has never been run on Windows.** `packaging/windows/build.sh`
  builds `ForgeERP-Setup-<version>-x64.exe` here, but this phone cannot run it. Its downloads
  are pinned to the checksums Node.js and MongoDB publish, and the zip paths inside them
  were read from the real files. The wizard, the services and the uninstaller need one full
  install, update and uninstall on a Windows PC before anyone relies on them.
  It is not code-signed, so Windows SmartScreen will warn about it.

- **The rebuilt screens have never been run.** The new layout, home page, search and page
  templates compile. On the user's instruction no tests were run after they were written, and
  `/views/home` and the core document search have no tests yet.
- **No screen has been opened in a browser.** The user declined installing one on the phone.
  They compile, and the APIs behind them are tested. Expect bugs on screen.
- **No chartered accountant has reviewed GST, TDS, payroll or the postings.** PF, ESI,
  professional tax and income tax rates are editable records, seeded with commonly quoted
  figures. They must be confirmed before a real month is run.
- **The GST rules come from secondary sources and my own knowledge, not from the Act.** The
  set-off order is the least certain. So are the 3B table mapping, the B2CL limit, the 30-day
  IRN limit and the 24-hour IRN cancel window. The limits are settings, except the 24 hours.
- The 3B and GSTR-1 tests check that invoices land in the expected tables and agree with the
  ledger. They do not prove the expected tables are right. Compare one real month with a CA.
- **No outside service has been contacted.** The POP3 client, Razorpay links and webhook, SMS
  and exchange rates are tested against stand-ins, or against what the documentation says.
  Each needs one real try with real credentials, in a test mode where there is one.
- Languages are a machine-written glossary of common words, not reviewed by a native speaker.
  Most screen text stays in English until someone adds a Translation record for it.
- E-invoice and e-way bill JSON is modelled on the public schema, but has not been validated
  against the current NIC schema or uploaded anywhere.
- About 244 record-only types have only had their shared behaviour tested through a sample.
- No load test, no outside security review, no restore-from-backup drill.

## Not built

Before a real company runs on this:

- Choosing where backups go. They run daily and restore correctly in a test. Set
  BACKUP_COPY_DIR to another disk or a synced folder, or they die with this disk.
- Direct e-invoice and e-way bill connection. It needs GSP credentials. Files only for now.
- A guided data migration. There is a Going live checklist, and CSV import for items,
  parties, accounts, warehouses and any engine type, with lines. Imported documents stay
  drafts. They can be submitted a page at a time, and a failure is listed, not hidden.

GST that is not built:

- Credit on reverse charge is booked with the invoice. The law ties it to paying the tax, so
  the timing can differ from what is filed. No self-invoice is produced for reverse charge.
- GSTR-2B matching reads a plain CSV in Forge's own columns, not the portal's file. It only
  reports differences, and does not stop credit being claimed.
- Rule 42/43 reversals, the 180-day payment reversal, interest and late fees, and ISD.
- Supplier balances and payment deductions are rupees only.
- GSTR-1 and 3B are screens and CSV, with no portal JSON to upload.

Platform features ERPNext has and Forge does not:

- Online checkout. The website ends in an enquiry, as machines are not bought by card.
- Multiple companies. Forge is one company, as decided at the start.
- A live bank feed. It needs an aggregator and a contract. Statements come in by file.
- Telephony.
- IMAP, and attachments on incoming mail. Mail is read over POP3 as text.
- Rich print design. The designer arranges blocks, and has no free layout.
- Dragging on boards and timelines by touch. Each has a menu or date boxes instead.
- Boards, calendars and timelines show up to 200 rows. Core documents other than builds,
  sales orders, purchase orders and sales invoices do not have them.

Manufacturing that is not built:

- Sequencing within a day. Capacity is booked in whole days.
- MRP counts open machine builds as demand, but does not plan them. It compares each need
  with supply due by that date, not a full day-by-day stock projection.
- Standard costing in the books. Stock stays at actual moving average. Standard cost is for
  roll-ups and for a report comparing actual with standard.

Payment links:

- Razorpay's fee is not booked. A receipt is recorded at the full amount, so the bank will be
  short by the fee until the settlement is booked by hand.

Limits that are easy to assume away:

- Per-record limits work only where a document names that kind of record. A limit on Plant
  does nothing to a sales order, as it has no plant. Fixed reports, reports with their own
  code, FAT and service tickets are refused to a limited person, rather than narrowed.
- A limited person can still read comments and files on core documents if given the record's id.
- Approval limits compare the document's total, and a sales order's is in its own currency.

## Known limits, on purpose

- Stock cost follows posting order, and backdating does not revalue later entries.
- A foreign currency sales invoice must be an export under LUT.
- An invoice from an earlier month cannot be cancelled, only credited.
- A closed year cannot be reopened in the system.
- Statutory filing is working papers: GSTR-1, GSTR-3B, TDS and PF registers are not uploads.
- Expired batches are not picked, unless switched off in settings. Stock already issued is
  not checked again.
- GST set-offs run in date order, and one at a time. An unpaid one blocks the next, so the
  same balance cannot be paid twice.
- Not validated for 21 CFR Part 11. The audit chain helps, but validation is a formal
  exercise with documents of its own.
