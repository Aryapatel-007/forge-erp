# Forge ERP

An ERP for a company that builds pharmaceutical machines to order. MERN: MongoDB,
Express 5, React 18, Node. Written from scratch. See `docs/DESIGN.md`.

## Run it

Needs Node 20.19 or later, and MongoDB 7 **running as a replica set**, because every
posting is a transaction.

```
npm install
cp .env.example .env      # then fill in two different secrets
npm run seed              # demo data, for development only
npm run dev               # API on 4100, screens on 5180
```

## A real install

```
NODE_ENV=production
npm run build
ADMIN_EMAIL=you@company.com node --env-file=.env server/scripts/createAdmin.js
ADMIN_MONGO_URI=... APP_DB_USER=forge_app APP_DB_PASSWORD=... npm run db:roles
npm start
```

Connect the app as `forge_app`. That database role can only read and insert on the
ledgers, so nothing can rewrite the books, not even a bug or a stolen password.
