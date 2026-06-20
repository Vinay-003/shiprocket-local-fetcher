# Shiprocket Local Fetcher

A local Node.js server that fetches order/shipment data from the Shiprocket API and exports it as CSV for import into Google Sheets.

No webhooks, no cloud deployment, no Vercel, no VPS. Runs entirely on your laptop.

## How it works

```
Your Laptop
   ↓
http://localhost:3000
   ↓
Shiprocket API
   ↓
deduped master_orders.json + CSV exports
```

## Prerequisites

- Node.js 16+
- A Shiprocket account
- A Shiprocket **API user** (not your main login)
- Your laptop's public IP whitelisted in Shiprocket

## Shiprocket API User Setup

1. Log in to your Shiprocket account
2. Go to **Settings → API Users → Create API User**
3. Use a separate email for the API user (not your main login):

   ```
   shiprocket.api@yourdomain.com
   ```

4. Select these **Modules**:

   ```
   Orders (create, update)
   Shipments
   Courier
   ```

5. Find your **public IP**:

   - Google search: "what is my ip"
   - Mac/Linux/Git Bash: `curl https://api.ipify.org`
   - Windows PowerShell: `Invoke-RestMethod https://api.ipify.org`

6. Paste that IP into **Allowed IPs for PII Access**

   **Important:** Do NOT use `localhost`, `127.0.0.1`, or `192.168.x.x` — Shiprocket needs your real public IP. When running the fetcher, your laptop must be connected to the same internet whose IP you whitelisted.

## Setup

```bash
# 1. Clone or enter the project
cd shiprocket-local-fetcher

# 2. Install dependencies
npm install

# 3. Create .env from the example
cp .env.example .env

# 4. Edit .env and fill in your Shiprocket API credentials
nano .env
```

### .env file

```
SHIPROCKET_EMAIL=your_api_user_email@example.com
SHIPROCKET_PASSWORD=your_api_user_password
SHIPROCKET_BASE_URL=https://apiv2.shiprocket.in
SHIPROCKET_ORDERS_ENDPOINT=/v1/external/orders
PORT=3000
```

## Usage

```bash
npm start
```

Open: [http://localhost:3000](http://localhost:3000)

### Buttons

| Button | Fetches |
|---|---|
| Fetch Today | Current day only |
| Fetch Last 3 Days | Today + previous 2 days |
| Fetch Last 7 Days | Today + previous 6 days |
| Fetch Last 28 Days | Today + previous 27 days |
| Fetch Last 90 Days | Today + previous 89 days |
| Download Latest CSV | Downloads the most recent CSV |
| Check Status | Refreshes the job status panel |
| Reset Local Data | Clears all deduped order data |

### Recommended first run

1. Click **Fetch Today** — quick test
2. Click **Fetch Last 3 Days** — small range
3. Click **Fetch Last 90 Days** — full data pull (takes a few minutes)
4. Click **Download Latest CSV**

## How fetching works

- Date ranges are split into **3-day chunks**
- Each chunk is fetched with **pagination** (100 records per page)
- **1 second delay** between pages, **3 seconds** between chunks
- HTTP 429 rate limits trigger **exponential backoff**: 10s → 30s → 60s → 120s → 300s
- Duplicate detection uses AWB → Shipment ID → Shiprocket Order ID → Channel Order ID → SHA-256 hash fallback
- Every fetch **updates** existing records instead of duplicating them

## Output files

```
data/
  master_orders.json       # Deduped master record of all fetched orders
  current_job.json         # Live job status (progress, errors, etc.)

output/
  shiprocket_orders_latest.csv                          # Latest CSV
  shiprocket_orders_last_90_days_2026-06-19.csv         # Dated copy
  shiprocket_orders_last_28_days_2026-06-19.csv
  shiprocket_orders_last_7_days_2026-06-19.csv
  shiprocket_orders_last_3_days_2026-06-19.csv
  shiprocket_orders_today_2026-06-19.csv
```

## CSV columns

The CSV uses webhook-compatible column names so the downstream Apps Script webhook upsert can directly update the same columns without maintaining duplicate field names.

```
Shiprocket Unique Key      Sr Order Id                 Shipment Status Id
Shipment Status            Scans 1 Status              Scans 1 Sr-status-label
Scans 1 Sr-status          Scans 1 Location            Scans 1 Date
Scans 1 Activity           Scans 0 Status              Scans 0 Sr-status-label
Scans 0 Sr-status          Scans 0 Location            Scans 0 Date
Scans 0 Activity           Order Id                    Is Return
Etd                        Current Timestamp           Current Status Id
Current Status             Courier Name                Channel Id
Awb                        Order Date                  Created At
Customer Name              Customer Email              Customer Phone
Pickup Location            Payment Status              Payment Method
Order Total                Tax                         Order Status
Order Status Code          Shipment ID                 Tracking URL
Delivered Date             Products                    Last Local API Sync At
Raw Shiprocket JSON
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Browser UI |
| POST | `/start?days=N` | Start fetch (N = 1, 3, 7, 28, 90) |
| GET | `/status` | Current job status JSON |
| GET | `/chunks?days=N` | Chunk breakdown for a range |
| GET | `/download` | Download latest CSV |
| POST | `/reset-master` | Clear all local data |

## Data safety

- No data is ever sent anywhere except to the Shiprocket API
- All files stay on your local machine
- `data/` and `output/` are git-ignored
- Reset button clears everything so you can start fresh
