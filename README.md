# DukaanSetu

Offline-first billing and ledger starter for Indian retail and wholesale teams. The active clients are React: React Native with Expo for Android, and React for browser/desktop use.

## Repository layout

```text
apps/
  mobile/                         Expo / React Native Android client
    App.tsx                       Offline billing, sync settings and PDF sharing
    src/database.ts               SQLCipher SQLite schema, local writes and sync queue
  web/                            React desktop/browser client
    src/localDb.ts                IndexedDB billing repository and sync queue
    src/webApp.tsx                Responsive POS and local PDF generation
  shared/                         Shared invoice types, validation and totals
services/
  api/                             TypeScript Express sync API
    src/
      db/                           PostgreSQL pool and migrations
      sync/                         Transactional mutation processor
      whatsapp/                     Deferred invoice notification job
      index.ts
    package.json
    tsconfig.json
    .env.example
```

## Run locally

### 1. Start PostgreSQL and Redis

You can use local installations, or Docker:

```powershell
docker run --name dukaan-postgres -e POSTGRES_USER=dukaan -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=dukaan_setu -p 5432:5432 -d postgres:17
docker run --name dukaan-redis -p 6379:6379 -d redis:7
```

Apply the starter schema (with PostgreSQL's `psql` installed):

```powershell
psql "postgres://dukaan:change-me@localhost:5432/dukaan_setu" -f services/api/src/db/schema.sql
```

### 2. Configure and start the API

From the repository root:

```powershell
Copy-Item services/api/.env.example services/api/.env
```

Edit `services/api/.env` and set a development `SYNC_TOKEN` (the same value goes into both clients). The example database URL matches the Docker command above. Then run:

```powershell
npm install
npm run dev:api
```

The API listens on `http://localhost:3000`. Check `http://localhost:3000/health`; it should return `{"ok":true}` once PostgreSQL is reachable. Redis is required by the API's BullMQ WhatsApp worker. Web development origins are allowed by the `CORS_ORIGINS` setting in `.env.example`.

### 3. Start the web POS

In another terminal, from the repository root:

```powershell
npm run dev:web
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). Open **Sync connection settings** and enter API URL `http://localhost:3000` and the `SYNC_TOKEN` from `services/api/.env`, then save. Create a bill to exercise local invoice creation and PDF download.

### 4. Start the Android app

SQLCipher needs a native development build; Expo Go does not include the configured native database support. Install Android Studio with its SDK and have an emulator running (or connect an Android device with USB debugging). In `apps/mobile`:

```powershell
npx expo run:android
```

This builds and installs the development app. For later JS-only sessions, start Metro with `npm run dev:mobile` from the repository root and open/reload the development app. In the app, open **Set up sync connection**. Use the API URL `http://10.0.2.2:3000` for the Android emulator; for a physical phone use the computer's LAN IP, such as `http://192.168.1.20:3000`. Enter the same sync token. The phone and computer must share a reachable network, and the firewall must allow port 3000.

### Manual offline and sync check

1. With the API, PostgreSQL, and Redis running, save the sync settings in the client and create an invoice. The bill should save immediately on-device and generate/download or share its PDF.
2. Disconnect the client from the network (Airplane mode on Android, or browser DevTools **Network > Offline**). Create another invoice; the offline indicator should show a locally saved bill.
3. Restore connectivity. The client retries sync in the background (also on its periodic retry); the pending bill count should drop. The mock WhatsApp worker logs the queued invoice job in the API terminal. This starter's WhatsApp and UPI integrations are placeholders, so it does not deliver real messages or collect payments.

### Build and type checks

From the repository root:

```powershell
npm run build:web
npm run build -w dukaan-setu-api
```

For Android dependency/type checks, from `apps/mobile`:

```powershell
npx expo install --check
npx tsc --noEmit -p tsconfig.json
```

These are build/type checks; the repository does not currently include an automated test suite.

Both clients write locally before syncing. Android uses SQLCipher-backed SQLite; browser/desktop uses IndexedDB. Each maintains a durable outbound mutation queue and syncs to the TypeScript API when online. IDs and invoice sequences are generated locally. Customer records are reused by phone or name. The API's sample `SYNC_TOKEN` and `TENANT_ID` are development placeholders and must be replaced with device enrollment and tenant-aware identity before production. The web client stores its development sync token in browser local storage; production web authentication should use short-lived tokens.

## Security and deployment

Set `DATABASE_URL`, `REDIS_URL`, `TENANT_ID`, and a strong `SYNC_TOKEN` on the API. Replace demo auth with a verified tenant/device identity provider. Use TLS, encrypted backups, key rotation, and device-specific SQLCipher keys held in secure storage. Browser local data is persisted with IndexedDB; browser storage encryption and production token handling need a deployment-specific security design.

Invoices are append-only, and stock changes should be synced as movement deltas. The API deduplicates mutations and queues invoice WhatsApp jobs after commit. The mobile client generates and shares invoice PDFs locally; the web client downloads them. WhatsApp and UPI are provider placeholders; configure an approved WhatsApp Business API and payment provider before enabling customer messaging or live payment links. Production deployments should add migrations, observability, rate limits, audit retention, GST/e-invoice handling, and real device enrollment.

