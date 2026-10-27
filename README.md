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

MongoDB is the primary database; set `MONGODB_URI` to the connection string for your database. The API creates the `users` and `crm_state` collections as needed. The first admin is created from environment values with a scrypt-hashed password. There are no default accounts or CRM records. After startup, the admin creates employee, technician, and HR accounts from **Team accounts** in the frontend. There is no JSON or in-memory production fallback: if MongoDB is unreachable or `MONGODB_URI` is missing, the backend exits with a configuration error.

The file adapter is selected only under `NODE_ENV=test` for the automated integration tests, so tests never connect to or modify the configured MongoDB database.

## Lead integrations

Each verified lead is stored in the central CRM lead pool, linked to a persistent customer profile, and routed to an active employee when capacity and routing rules permit. Employee routing criteria (service areas, property types, score range, and open-lead capacity) are configured in Team accounts. Auto-routing is deterministic and records an explanation with the lead; leads without an eligible employee remain unassigned. Duplicate webhook deliveries are ignored when the source provides an external ID; WhatsApp contacts are deduplicated by phone number.

### Meta / Instagram Lead Ads

Configure `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_LEAD_ACCESS_TOKEN`, and `META_GRAPH_API_VERSION`. The backend `.env` uses Graph API `v24.0`; update it when moving to a different supported version. Set the same `META_WEBHOOK_VERIFY_TOKEN` value in the Meta app's webhook settings, subscribe the app to the `leadgen` webhook field, and set its callback URL to `/api/webhooks/meta`. The callback verifies Meta's HMAC signature, then fetches the submitted form fields using the Graph API token. Standard field labels are normalized case-insensitively (for example, `Full Name` and `Phone Number`). Facebook and Instagram lead forms that feed the configured Meta page arrive in the same central pool; the open Lead Pool refreshes from the server automatically every 20 seconds.

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
  "state": "Maharashtra",
  "city": "Pune",
  "propertyType": "Residential",
  "score": 82,
  "externalId": "form-submission-123"
}
```

An array of records can also be sent in `{ "leads": [...] }`. Never expose webhook keys in browser code; submit the form to your own server and forward it to this API.

## OTP delivery

Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM_NUMBER`. Installation/customer phone numbers must be stored in E.164 format (for example `+919876543210`). The service OTP is sent through Twilio and is never returned to the frontend. OTPs expire after five minutes and are invalidated after five failed attempts. Missing or failed Twilio delivery is reported as an API error, not a successful send.

## Customer, installation, and service lifecycle

Customer records are created or matched by normalized phone/email when leads, applications, and installations enter the CRM. Their history links these lifecycle records and service tickets. `GET /api/customers` and `GET /api/customers/:id` return a role-scoped 360 profile, including applications and commissioned installations assigned to the requesting employee.

The solar application workflow is sequential: Registration, Application, Feasibility, Vendor Selection, Upload Agreement, Pre-site Inspection, Material Dispatch, Installation, Post-site Inspection, Project Commissioning, Subsidy Request, and Subsidy Disbursal. Employees create applications and may advance only applications assigned to their account; their CRM response contains only their applications and commissioned installations. Administrators can view all applications, but cannot create or advance them. Feasibility and Post-site Inspection require an administrator decision; decisions are retained with timestamp, actor, and note. Existing seven-step application records are migrated to the extended timeline. Completing Project Commissioning creates the active installation and its quarterly maintenance tickets, linked to the application and customer. The direct installation-creation endpoint is disabled to prevent bypassing this workflow. Use `POST /api/applications/:id/approval` with `{ "decision": "Approved", "note": "..." }` (or `Rejected`), then `POST /api/applications/:id/complete-step`.

Administrators create and assign detailed customer service tickets through `POST /api/maintenance` and update active assignment/details through `PATCH /api/maintenance/:id`. Technicians only receive their assigned tickets and close work through the Twilio OTP flow. Generic CRM bulk writes cannot replace lifecycle records or bypass approval/OTP workflows.

## HR, payroll, visits, and photo storage

Administrators create HR accounts in **Team accounts**. HR accounts use a separate login role and can manage employee/technician department, job title, joining date, and monthly salary, review attendance and field visits, create monthly payroll slips, and mark them paid. Payroll pays the full monthly salary without attendance proration; HR enters deductions manually. Leave tracking and statutory tax, PF, ESI, overtime, and holiday calculations are not implemented.

Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` (or `CLOUDINARY_URL`) for image uploads. Authenticated employees can attach a photo at check-in and submit site/sales visit reports with a required photo. Images are limited to 5 MB and JPEG, PNG, or WebP. The server signs uploads and stores returned Cloudinary URLs with CRM attendance/visit records. Set the office or site coordinates before enabling the requested 10 m attendance radius; location enforcement is not active until that configuration exists.

Set `HR_DATA_ENCRYPTION_KEY` to a persistent 32-byte key encoded as 64 hexadecimal characters before employees or HR save bank details. Generate one with `openssl rand -hex 32`; keep it in the server environment and back it up securely. Bank account numbers are encrypted with AES-256-GCM in CRM storage. Losing or changing the key makes existing bank details unreadable. Employees and HR can view/manage bank details; employees can upload their own documents, and HR can manage employee documents. Identity and bank-proof files (PDF/JPEG/PNG, up to 7 MB, maximum 20 per employee) are uploaded to Cloudinary as authenticated private assets and downloaded only through role-checked API routes.

## API

- `GET /api/health`
- `GET /api/auth/setup-status`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/crm`
- `PUT /api/crm/:resource`
- `GET /api/users` and `POST /api/users` — administrator only
- `PATCH /api/users/:id` — edit employee/technician/HR profile and optionally reset its password; administrator only
- `DELETE /api/users/:id` — soft-delete employee/technician/HR account; data is retained and sign-in is revoked
- `POST /api/users/:id/restore` — restore a soft-deleted employee/technician/HR account; administrator only
- `POST /api/applications` — employee creates an application, assigned to their account
- `POST /api/applications/:id/approval` — administrator approves or rejects the current gated stage
- `POST /api/applications/:id/complete-step` — assigned employee completes the current stage
- `GET /api/hr/me`, `PATCH /api/hr/me/bank-details`, and `POST /api/hr/me/documents` — employee/technician own records
- `GET /api/hr/me/documents/:documentId/download` — employee/technician own documents
- `GET /api/hr/employees`, `PATCH /api/hr/employees/:id`, `PATCH /api/hr/employees/:id/bank-details`, and `POST /api/hr/employees/:id/documents` — HR
- `GET /api/hr/employees/:id/documents/:documentId/download` — HR employee document access
- `GET /api/hr/payroll`, `POST /api/hr/payroll`, and `PATCH /api/hr/payroll/:id/paid` — HR only
- `POST /api/uploads` — authenticated Cloudinary image upload
- `GET /api/visits` and `POST /api/visits` — employee field visit records
- `POST /api/leads/auto-assign`
- `POST /api/leads/import` and `PATCH /api/leads/:id/assign` — administrator only
- `GET /api/customers` and `GET /api/customers/:id` — scoped customer 360 profiles
- `POST /api/maintenance` and `PATCH /api/maintenance/:id` — administrator ticket handling
- `GET` and `POST /api/webhooks/meta`
- `GET` and `POST /api/webhooks/whatsapp`
- `POST /api/webhooks/leads/:source`
- `GET /api/webhooks/integrations` — administrator only
- `POST /api/maintenance/:id/otp`
- `POST /api/maintenance/:id/verify-otp`

Authenticated routes use a bearer token returned from login. Employee and technician CRM data is scoped to their work; HR receives HR, payroll, attendance, and visit records but not customer, lead, installation, or service-ticket data. Bank details and identity/bank-proof documents are available only to the employee concerned and HR; administrator routes do not expose them.

Run `npm test` for API integration tests.
