# ZX Solar CRM API

## Project structure

```text
config/          Runtime configuration
controllers/     HTTP request handlers
data/            Temporary file storage for isolated tests only
database/        MongoDB connection lifecycle
middleware/      Authentication, authorization, and error handling
models/           MongoDB CRM state and user models
routes/           API route declarations
services/         Password authentication, lead intake, and SMS OTP
app.js            Express app and middleware composition
server.js         Startup and first-admin provisioning
server.test.js    API integration tests
```

## First-time setup

Copy `.env.example` to `.env`, set `MONGODB_URI`, `ADMIN_NAME`, `ADMIN_USERNAME` (a 3–40 character login ID; email-style IDs are supported), and a unique `ADMIN_PASSWORD` of at least 12 characters, then run:

```sh
npm install
npm run dev
```

MongoDB is the primary database; set `MONGODB_URI` to the connection string for your database. The API creates the `users` and `crm_state` collections as needed. The first admin is created from environment values with a scrypt-hashed password. There are no default accounts or CRM records. After startup, the admin creates employee and technician accounts from **Team accounts** in the frontend. There is no JSON or in-memory production fallback: if MongoDB is unreachable or `MONGODB_URI` is missing, the backend exits with a configuration error.

The file adapter is selected only under `NODE_ENV=test` for the automated integration tests, so tests never connect to or modify the configured MongoDB database.

## Lead integrations

Each verified lead is stored in the central CRM lead pool and assigned to an active employee. Duplicate webhook deliveries are ignored when the source provides an external ID; WhatsApp contacts are deduplicated by phone number.

### Meta / Instagram Lead Ads

Configure `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_LEAD_ACCESS_TOKEN`, and `META_GRAPH_API_VERSION`. The backend `.env` uses Graph API `v24.0`; update it when moving to a different supported version. Set the same `META_WEBHOOK_VERIFY_TOKEN` value in the Meta app's webhook settings, subscribe the app to the `leadgen` webhook field, and set its callback URL to `/api/webhooks/meta`. The callback verifies Meta's HMAC signature, then fetches the submitted form fields using the Graph API token. Facebook and Instagram lead forms that feed the configured Meta page arrive in the same central pool.

### WhatsApp Cloud API

Configure the Meta app webhook secret and verification token, then subscribe the WhatsApp webhook to `messages` using `/api/webhooks/whatsapp`. Inbound contacts are saved with message text as lead notes. Repeated messages from one number are ignored instead of creating duplicate leads.

### Website, referral, and other forms

Set separate server-only API keys in `WEBSITE_WEBHOOK_SECRET`, `REFERRAL_WEBHOOK_SECRET`, and `LEAD_WEBHOOK_SECRET`. Send a `POST` request with `Content-Type: application/json` and an `x-api-key` header to `/api/webhooks/leads/website`, `/api/webhooks/leads/referral`, or `/api/webhooks/leads/generic`.

```json
{
  "name": "Customer name",
  "phone": "+919876543210",
  "email": "customer@example.com",
  "message": "Interested in rooftop solar",
  "externalId": "form-submission-123"
}
```

An array of records can also be sent in `{ "leads": [...] }`. Never expose webhook keys in browser code; submit the form to your own server and forward it to this API.

## OTP delivery

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Installation/customer phone numbers must be stored in E.164 format (for example `+919876543210`). The service OTP is sent through Twilio and is never returned to the frontend. OTPs expire after five minutes and are invalidated after five failed attempts. Missing or failed Twilio delivery is reported as an API error, not a successful send.

## API

- `GET /api/health`
- `GET /api/auth/setup-status`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/crm`
- `PUT /api/crm/:resource`
- `GET /api/users` and `POST /api/users` — administrator only
- `POST /api/installations`
- `POST /api/applications`
- `POST /api/applications/:id/complete-step`
- `POST /api/leads/auto-assign`
- `GET` and `POST /api/webhooks/meta`
- `GET` and `POST /api/webhooks/whatsapp`
- `POST /api/webhooks/leads/:source`
- `GET /api/webhooks/integrations` — administrator only
- `POST /api/maintenance/:id/otp`
- `POST /api/maintenance/:id/verify-otp`

Authenticated routes use a bearer token returned from login. Employees and technicians only receive their own records; write routes enforce role and ownership permissions.

Run `npm test` for API integration tests.
