# Forge ERP

MERN ERP for a company that builds pharmaceutical machines to order. One company.

Read `docs/DESIGN.md` for the rules and the postings, and `docs/STATUS.md` for what is
built and what has actually been checked. Update `docs/STATUS.md` when you finish.

Written from scratch. ERPNext is GPL-3.0: never copy its code, fields or text.

## Running here

`mongod` must be running as replica set `rs0`. Forge uses its own databases, `forge-erp`
and `forge-erp-test`, on the same server as other projects. Never touch the others.

```
cd server && node --env-file=.env.test --test tests/erp.test.js   # one test file
npm run dev                                                      # API 4100, screens 5180
```

## Adding a document type

Define it in `server/doctypes/`, in the field language described at the top of
`server/engine/dsl.js`. Mark anything the server sets as computed with `~`. Money or stock
moves belong in `onSubmit`, and cancel reverses both automatically. A number series must
not clash with one in `tests/engine.test.js`. Then run `server/scripts/parity.js`.

To add behaviour to a type defined in another file, use `extend()` in
`server/doctypes/logic.js`. It must run before the definition, so that file loads first.

The user's phone has no browser for testing and they declined to install one. Test through
the API, one test file at a time.

## Rules that are easy to break

- Paise, thousandths and basis points are integers. All arithmetic goes through
  `server/utils/money.js` and `server/utils/tax.js`.
- Nothing updates or deletes `glentries`, `stockentries` or `auditlogs`. Reverse instead.
- Only `stockService` writes stock. Only `ledgerService` writes the GL.
- Every posting runs inside `withTxn`, and the callback may be retried, so it must do
  nothing outside the session.
- A new document type goes in `client/src/config/resources.js`, not in a new screen.
- `client/src/config/apps.js` decides where each screen lives. Put new screens there.
- A new check in `reportService.integrity` needs a test that breaks it on purpose.
