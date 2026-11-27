# CRM storage performance and deployment

## Status and limitations

The CRM now requires MongoDB transactions at startup. A replica set or sharded cluster with sessions and transaction support is required; a standalone server is rejected. Verify the actual production topology, permissions, backup, and transaction behavior in staging before deployment. No production topology or data was inspected during this work.

**This is not a complete lost-update solution for all existing APIs.** The legacy `PUT /api/crm/leads` and `PUT /api/crm/attendance` requests send entire client-side arrays without a version. A stale browser can overwrite a later change even though the database writes are atomic. Preserving that contract was explicitly selected for this phase. A safe next stage must add a version or ETag to reads, require a matching version on writes, update the frontend to handle HTTP 409, and decide how to retire unversioned writers. Do not claim that all silent lost updates are eliminated until that stage is deployed.

HR account changes also write to the separate `users` collection and update in-memory sessions outside CRM resource transactions. External document uploads, OTP delivery, and maintenance reminder delivery are not transactionally coupled to CRM writes; a database failure can leave an external side effect or an uncertain result. These existing cross-system workflows need separate idempotency/reconciliation work. User account lookups used in routing and authorization are not locked together with the CRM transaction.

The existing lead DELETE behavior is **permanent removal**, not soft deletion. The unrouted restore controller remains unrouted. This behavior was retained as requested.

## Root causes and dependency map

Each `crm_<resource>` collection contains a single document, `_id: "primary"`, whose `items` array holds all records for that resource. Previously every mutation read all 11 arrays, advanced one global metadata revision, then independently replaced all 11 documents. Competing writes could fail globally, interleave after the revision increment, overwrite newer data, or leave partially written resources. Attendance auto-checkout invoked that path every minute and on dashboard reads, even with no changes.

Important dependencies:

| Workflow | CRM resources |
| --- | --- |
| Lead intake, assignment, location transfer, deletion and status history | leads, customers; assignment considers all leads and a users snapshot |
| Application creation, transfer and OCR history | applications, customers |
| Application commissioning | applications, customers, installations, maintenance |
| Installation assignment | installations, applications, customers |
| Maintenance authorization and mutation | maintenance, installations, applications, customers as applicable |
| Payroll creation/recalculation | payroll, HR profiles, attendance, holidays; users are separate |
| Customer profile and dashboard | related resource snapshots plus users |
| Attendance, visits, holidays, leave, HR profile | their respective resource; some HR flows also use users or external storage |

Initialization copies legacy `crm_state` data into resource documents only if those documents do not already exist. Customer migration may update leads, applications, installations, maintenance and customers; application migration transforms legacy workflow steps. Repeated customer migration no longer changes timestamps when nothing else changed.
This change cannot automatically identify or repair inconsistent data left by earlier partial writes; validate existing records and backups separately before cutover.

## Changes and concurrency

- `models/crmModel.js`: selective reads and mutations, per-resource revisions, conditional single-document writes, transactional multi-resource writes and snapshot reads. Related resources used as read dependencies receive revision guards even when their arrays do not change. Unchanged operations do not write.
- Lead, application, installation, maintenance, customer, HR, attendance, visit, holiday, dashboard and reminder call sites select the resources they need. The legacy CRM endpoint retains its response shape. Payroll calculations and writes use a common CRM snapshot.
- Safe lead and attendance mutators use up to five attempts with exponential backoff and jitter; other business mutators are not blindly retried. Commit retries are bounded and apply only to an uncertain commit result; an unresolved commit returns 503 rather than claiming success or a conflict.
- Expected client errors are not logged as server exceptions. Database conflicts log safe resource names; optional slow logs contain method, route template, status and duration, not request bodies, tokens, credentials or customer data. Set `CRM_PERF_LOG=1` to enable slow CRM database operations (250 ms) and HTTP requests (1000 ms); development mode also enables them. Other database operations are not instrumented.
- `crm.mongo.test.js` tests an explicitly supplied local replica set; `crm.benchmark.js` generates a synthetic local workload. Existing file-backed API tests remain available.

Changed files: `models/crmModel.js`, `models/userModel.js`; `controllers/applicationController.js`, `crmController.js`, `customerController.js`, `holidayController.js`, `hrController.js`, `installationController.js`, `installationDocumentController.js`, `leadController.js`, `maintenanceController.js`, `visitController.js`; `services/attendanceService.js`, `customerService.js`, `leadService.js`; `server.js`, `app.js`, `middleware/errorMiddleware.js`, `README.md`, this document, `crm.mongo.test.js`, and `crm.benchmark.js`.

The array architecture still rewrites the affected resource's complete `items` array on a change and is constrained by MongoDB's 16 MB document limit. Different lead writes contend on the same document. `findAll()` and existing list APIs still return unbounded payloads for compatibility. Indexed per-record lookups and scalable pagination require a separately designed staged migration, compatible readers/writers, reconciliation, and frontend agreement.

### Dashboard loading after login

The admin dashboard requests `GET /api/crm/summary`, not the complete CRM response. It returns counts and at most 20 current service rows; the maintenance page retains the complete list. The summary projects the fields required from leads, attendance, maintenance and installations in a consistent CRM snapshot. Attendance auto-checkout still runs first to preserve its existing behavior. The frontend loads resources for other screens on navigation through role-filtered `GET /api/crm/views/:view`; customers, HR and profile screens use their existing dedicated APIs. The original `GET /api/crm` remains available to other clients. The employee dashboard still loads its assigned leads, applications, complete employee attendance, holidays and leave requests; the technician dashboard loads its maintenance-related data. Lead and employee pages no longer make an immediate duplicate refresh after their initial view load.

The summary currently reads projected fields for all relevant records into Node, and auto-checkout still reads the complete attendance array. Other module views still return complete resource arrays, and employee dashboard polling still retrieves all assigned leads. Server-side pagination, filtering, sorting and employee/technician summary endpoints are **not implemented**. This is intentionally not presented as the full requested optimization. The timer's existing unversioned whole-array attendance write must first be replaced or versioned before attendance can safely be truncated; other lists, counts and exports also need coordinated pagination changes. These remaining limitations must be resolved and tested before claiming the complete requested outcome.

The summary and views do not create indexes or migrate data. MongoDB scans the embedded arrays even for projections. Reads within a multi-resource transaction are sequential. Slow Atlas operations can still dominate latency; no production timing was measured.

On a local macOS file-backed test fixture with 6,000 synthetic leads, 1,000 attendance rows, 300 installations and 300 tickets, five sequential requests per endpoint yielded:

| Endpoint | JSON bytes | Median response |
| --- | ---: | ---: |
| Legacy `/api/crm` | 1,919,598 | 68.54 ms |
| Admin `/api/crm/summary` | 3,120 | 41.03 ms |

Both fixtures were freshly initialized with the same generated data; other local validation processes ran during this small sample. File storage parses the entire file and does not model Atlas, network latency or MongoDB command counts. The user's reported 22.03 seconds is a separate production observation, not a comparable measurement. Dashboard CPU, RSS and production timings were not measured.

Post-login files changed: backend `models/crmModel.js`, `controllers/crmController.js`, `routes/crmRoutes.js`, `server.test.js`, and `crm.mongo.test.js`; frontend `src/App.jsx`, `src/utils/CrmContext.jsx`, `src/components/Layout.jsx`, `src/pages/Dashboard.jsx`, `src/pages/EmployeeDashboard.jsx`, and `src/pages/Leads.jsx`.

## Database and indexes

No collection is dropped and no existing index is dropped or added. The existing user schema declares unique indexes for `id` and `username`; installation documents declare unique `id` and indexes on `installationId` and `employeeId`. Actual deployed indexes were not inspected. New resource documents include `revision`; existing documents acquire it on their first guarded write. The legacy metadata revision is retained for compatibility but is no longer the concurrency authority.

Do not run old and new application writers concurrently: the old code ignores resource revisions and can overwrite new data. Stop **all** API processes, scheduled jobs, and other writers for cutover and rollback. No automatic production data migration command is required; startup performs the existing migrations transactionally. Take a verified, restorable Atlas backup first.

## Tests and local benchmark

- `node --test server.test.js`: 31 tests passed, including summary and role-scoped view compatibility.
- Isolated local MongoDB 7.0.16 replica set: 11 tests passed, including projected reads, customer/application migration, lead authorization and response shapes, concurrent updates, attendance, payroll, transaction rollback, BSON change detection, and snapshot reads.
- A separate isolated standalone MongoDB was rejected before CRM initialization with a 503 transaction-support error.

Measured on one macOS x86-64 machine with Node 24.18.0 and local MongoDB 7.0.16, synthetic 100-lead fixture, 30 sequential lead note edits then 10 concurrent edits to different leads. These are single runs, not production measurements or a capacity guarantee. Instrumentation excludes initialization and login. CPU is process CPU time during the workload; RSS is the process reading immediately afterward, not peak memory.

| Metric | Before | After |
| --- | ---: | ---: |
| Sequential p50 / p95 | 58.16 / 60.52 ms | 29.01 / 31.67 ms |
| Whole 11-resource read rounds | 58 | 0 |
| Resource document reads | 638 | 50 |
| `replaceOne` resource replacements | 429 | 0 |
| Whole-array writes, including attempted conditional writes | 429 | 50 |
| MongoDB commands during workload | 1223 | 100 |
| Concurrent results | 9 success, 1 conflict | 10 success |
| Workload wall time | 2168 ms | 1126 ms |
| Node CPU time | 967 ms | 425 ms |
| Node RSS after workload | 184.0 MiB | 168.1 MiB |

The updated benchmark counts both replacement writes and `$set` of an entire resource array. The optimized path still sends the full lead array on each attempted write; the zero `replaceOne` count does **not** mean record-level writes. No DigitalOcean CPU, swap, network latency, Atlas operation count, or production workload was measured.

For repeatable local tests, provision a **dedicated disposable replica set**, not a production server or tunnel. These commands create uniquely named synthetic databases and do not drop them; dispose of the isolated server and its data using your normal test-environment procedure:

```sh
cd /path/to/Crm_Backend
npm test
CRM_TEST_MONGODB_URI='mongodb://127.0.0.1:27199/?replicaSet=crm-test' node --test crm.mongo.test.js
CRM_BENCHMARK_MONGODB_URI='mongodb://127.0.0.1:27199/?replicaSet=crm-test' node crm.benchmark.js
```

The optional URI must point to an unauthenticated loopback replica set. Tests and benchmark deliberately create new databases; never point them at production. The existing `npm test` suite deletes and recreates the backend's `.test-data` directory; do not run it where that directory contains important data. The old code must be benchmarked separately with the same fixture and workload for a fresh before/after comparison.

## Safe deployment checklist

1. Rotate any MongoDB credentials exposed during diagnostics. Use secure environment management; do not paste credentials into commands or logs.
2. Verify a recent Atlas backup and its restore procedure; record the old application release. Verify disk space, Node compatibility, and the expected PM2 working directory and process name.
3. Confirm Atlas is a transaction-capable replica set or sharded cluster, allows sessions and transactions, and the application user can read/write the required collections. Validate with staging data and run both test suites against an isolated replica set.
4. Arrange a maintenance window. Stop every writer, including all PM2 instances and external workers. Never use a rolling or zero-downtime mixed-version deployment.
5. Back up the application code securely. Deploy the tested files without replacing `.env`, `data`, or dependencies. No dependency manifest changed.
6. Start one new version; confirm startup, logs, transaction capability, and read-only role-scoped dashboard results. Perform authorized smoke tests in staging first. Monitor conflicts, slow logs, Atlas metrics, CPU, RSS and swap.
7. If verification fails, stop writes immediately and follow the rollback procedure; investigate any uncertain commit outcome before retrying an operation.
8. Deploy the tested frontend after the backend: the new frontend requires the new summary and view endpoints. Record and back up the existing frontend release, build the tested frontend with its existing environment, and publish its `dist/` using the server's normal deployment method. Verify admin, employee, technician and HR login and their module navigation in staging first. The frontend's real web-root and deployment mechanism were not inspected, so no production web-root command can safely be inferred here.

### Example DigitalOcean commands

Set the paths to the actual existing backend, separately uploaded tested release, and a new private backup directory. The release directory must contain the backend files at its root. Verify paths and available space before running; these commands do not update Node, PM2, environment variables, or dependencies.

```sh
set -eu
BACKEND_DIR=/absolute/path/to/Crm_Backend
RELEASE_DIR=/absolute/path/to/tested/Crm_Backend
BACKUP_DIR="$HOME/zxcrm-backend-code-backup-$(date +%Y%m%d-%H%M%S)"
pm2 describe zxcrm-backend
test -f "$BACKEND_DIR/server.js"
test -f "$RELEASE_DIR/models/crmModel.js"
# Read-only transaction preflight using the backend's .env; verify it matches PM2's actual connection.
(cd "$BACKEND_DIR" && node --env-file-if-exists=.env -e '
const mongoose = require("mongoose");
(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (hello.logicalSessionTimeoutMinutes == null ||
        !(hello.setName || hello.msg === "isdbgrid") ||
        hello.maxWireVersion < (hello.msg === "isdbgrid" ? 8 : 7)) throw new Error("Transactions unavailable");
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" } });
      await mongoose.connection.collection("crm_metadata").findOne({ _id: "primary" }, { session });
      await session.abortTransaction();
    } finally { await session.endSession(); }
    console.log("Read-only transaction preflight passed.");
  } catch (error) {
    console.error("Transaction preflight failed:", error.name);
    process.exitCode = 1;
  } finally { await mongoose.disconnect(); }
})();')
mkdir -m 700 "$BACKUP_DIR"
rsync -a --exclude='.env' --exclude='node_modules/' --exclude='data/' --exclude='.test-data/' "$BACKEND_DIR/" "$BACKUP_DIR/"
# Stop every other writer as well before continuing.
pm2 stop zxcrm-backend
rsync -a --exclude='.env' --exclude='node_modules/' --exclude='data/' --exclude='.test-data/' "$RELEASE_DIR/" "$BACKEND_DIR/"
pm2 restart zxcrm-backend
pm2 status zxcrm-backend
curl --fail --silent --show-error http://127.0.0.1:3001/api/health
pm2 logs zxcrm-backend --nostream --lines 100
```

Check `pm2 describe` against the real process entry point and working directory before use. `rsync` does not delete extra files. Health only confirms the HTTP endpoint, not ongoing database health or business correctness. Inspect logs privately; historical logs may contain sensitive data. The example assumes `rsync` is installed and that the same Node installation already runs this backend.

### Rollback

Keep all writers stopped while restoring the exact saved code, and do not restore an old database snapshot over new writes without a separately approved recovery plan. The old code reintroduces the original non-atomic writes and conflict risk; consider remaining in maintenance mode instead of resuming writes.
Restore the matching frontend release before rolling the backend back; the new frontend cannot use the older backend's missing summary/view endpoints.

```sh
set -eu
pm2 stop zxcrm-backend
rsync -a --exclude='.env' --exclude='node_modules/' --exclude='data/' --exclude='.test-data/' "$BACKUP_DIR/" "$BACKEND_DIR/"
pm2 restart zxcrm-backend
pm2 status zxcrm-backend
curl --fail --silent --show-error http://127.0.0.1:3001/api/health
```

If dependency versions or files outside this change were modified independently, restore the matching release and dependencies using the deployment system's normal procedure. Review Atlas and application logs, check customer/lead consistency, and resolve any uncertain writes before reopening traffic.
