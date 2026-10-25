<h1 align="center">🏥 HealthHub — Firebase Edition</h1>

<p align="center">
  <b>A digital healthcare management system with dedicated portals for Admins, Doctors, and Patients.</b><br/>
  Built with AngularJS · Firebase Authentication · Cloud Firestore · Firebase Hosting<br/>
  <b>No backend server, no SQL database</b> — the browser app talks directly to Firebase,
  and <code>firestore.rules</code> is the security/enforcement layer.
</p>

---

## 🔥 Firebase setup (one-time, ~10 minutes)

You need your OWN Firebase project for this copy (do not reuse another app's project).

1. Go to the [Firebase console](https://console.firebase.google.com) → **Add project** (any name, e.g. `healthhub`).
2. **Authentication** → Get started → Sign-in method → enable **Email/Password**.
   Also enable **Google** — the login and create-account pages both have a
   Google button, and it works as soon as the provider is enabled.
3. **Firestore Database** → Create database → **Start in production mode**.
   *(This step matters: if the database is never created, the app has nowhere to write.)*
4. **Storage: skip it entirely.** On new projects Firebase Storage requires the
   Blaze billing plan, so this app deliberately does not use it — uploaded
   files live inside Firestore instead (see "Files" note below). Nothing to do here.
5. Project settings (⚙️) → **Your apps** → Web (`</>`) → register the app → copy the
   `firebaseConfig` values into **`public/js/firebase-config.js`**.
6. Deploy the security rules + indexes (pick one):
   - **Firebase CLI:** `npm i -g firebase-tools` → `firebase login` → `firebase use <your-project-id>`
     → `firebase deploy --only firestore:rules,firestore:indexes`
   - **Or by hand:** paste `firestore.rules` into Firestore → Rules → Publish.
     Indexes can be created from the links in the browser console errors on first use.
7. **Seed the demo data** (admin + doctors + patients + appointments):
   - Project settings → Service accounts → **Generate new private key** → save the file as
     `firebase-seed/serviceAccountKey.json` (it is git-ignored — never share it).
   - `cd firebase-seed && npm install && node seed.js`

## ▶️ Run it

The app is fully static (`public/`). Any static server works:

```bash
# option A — Firebase Hosting emulator (also serves the SPA rewrite)
firebase emulators:start --only hosting        # http://localhost:5000

# option B — any static file server
npx serve public                               # or: python -m http.server -d public
```

For production: `firebase deploy` (hosting + rules + indexes in one go).

### 🌐 "Run it always" — deploy to Firebase Hosting (recommended)

```bash
npm i -g firebase-tools
firebase login
firebase use health-hub-18677     # or your project id
firebase deploy                    # hosting + firestore rules + indexes
```

You get a permanent live URL like `https://health-hub-18677.web.app` —
always on, free on the Spark plan, no server to babysit. Redeploy after
every change with just `firebase deploy`. (This copy is bound to the
project by `.firebaserc`.) Your `*.web.app` and
`*.firebaseapp.com` domains are auto-authorized for Google sign-in;
if you later test from a different address (e.g. a LAN IP), add it under
Authentication → Settings → Authorized domains.

Pushing the code to **Git/GitHub is optional** — it is backup/version
control, not hosting. Do both if you like: `git push` to save the code,
`firebase deploy` to publish it. (Never commit
`firebase-seed/serviceAccountKey.json` — it's already in `.gitignore`.)

### 🔐 Social sign-in (patients)

The login page (Patient tab) and the Create Account page have a **Google**
button (`signInWithPopup`).
First social sign-in auto-creates the patient profile (profile incomplete,
same as registration); later ones land on the existing account. Safety
details: a doctor/admin email used on a social button is refused with a
pointer to the right tab, and if the email already has a password account,
Firebase's own error is translated into "sign in with your password
instead". Providers are toggled in the console — the app code is already
in place.

### ✅ Validation regexes

All in `public/js/services/api.service.js` (single `REGEX` map; mirrored
as HTML `pattern` attributes in the register form): names (letters,
3–50), email, Indian mobile numbers (optional +91, 10 digits starting
6–9), doctor usernames (3–20 word chars), new passwords (8+ with a letter
and a number), and per-type ID numbers (Aadhar 12 digits, Passport
letter+7 digits, Voter ID 3 letters+7 digits).

**Demo logins** (same as the MySQL version):

| Role    | Login                          | Password    |
|---------|--------------------------------|-------------|
| Admin   | username `admin`               | `Admin123`  |
| Doctors | username `dr_arjun` (etc.)     | `Doctor123` |
| Patients| email, e.g. `rahul.sharma@gmail.com` | `Patient123` |

> Admin/doctors log in with a **username**: a `usernames/{username}` document maps it to
> the account email, because Firebase Auth itself is email-based.

### 🎂 Date of birth → automatic age, 🎨 polished theme + logo, 🔑 forgot password, 📱 mobile

- **DOB → age:** the patient profile form takes a date of birth and derives the age automatically (recomputed on save in the service — the two can never disagree). Demo patients are seeded with matching DOBs.
- **Theme:** the original teal theme, professionally finished — all emoji replaced by inline SVG line icons, refined shadows/focus rings/scrollbars, and a proper logo (`public/assets/logo-icon.svg`, `logo-full.svg`, `logo-mono.svg`) used in every header and as the favicon.
- **Forgot password:** login page → 'Forgot password?' — patients reset by email; doctors/admins enter their username and the reset link goes to the email on the account (Firebase Auth email). The response never reveals whether an account exists.
- **Mobile:** at phone widths the sidebar becomes a bottom app-bar, grids stack, tables scroll inside their cards, popups go near-fullscreen, and inputs use 16 px text so iOS doesn't auto-zoom.

## 🧱 How the MySQL design maps to Firestore

| MySQL concept | Firebase equivalent |
|---|---|
| Tables | Collections: `accounts`, `usernames`, `doctors`, `patients`, `appointments`, `reports`, `doctorOffDays`, `slotLocks`, `files`, `notifications`, `reportAccessRequests` |
| JOINs | **Denormalization** — appointments snapshot patient/doctor names, phone, address, specialization at booking time |
| `TREATMENT.appointment_id` 1:1 FK + UNIQUE | Treatment is **embedded as a map** inside the appointment document |
| Booking transaction + slot uniqueness | Firestore **transaction** that creates the appointment AND a `slotLocks/{doctorId_date_time}` document — one lock per occupied slot makes double-booking impossible by construction; hour-capacity and same-patient clash checks count locks, so patients never need to read other patients' appointments |
| JWT middleware + bcrypt | **Firebase Authentication** (passwords hashed by Google); the app keeps a local session copy for routing |
| `express.static /uploads` + ownership route | A **`files` collection in Firestore**: the file bytes are stored base64 in a document (≤700 KB per file — Firestore documents cap at ~1 MiB), and `reports.file_path` / `patients.id_document_path` hold the file document's id. Files are fetched under the caller's identity and decoded in the browser, so there is **no public URL** for any file — the `files` rules give reports to the owning patient + their doctors (plus doctors the patient has approved via report-access sharing), and ID documents to the patient + admin only. Admins deliberately have **no** report access. |
| Express route checks | The same checks in `public/js/services/api.service.js`, **plus** `firestore.rules` (the real boundary in a serverless app) |
| `schema.sql` + `seed.sql` | `firestore.indexes.json` + `firebase-seed/seed.js` (Admin SDK; deterministic ids, safe to re-run) |

## ⚠️ Firebase-plan limitations worth knowing (viva material)

- **Admins cannot change a doctor's password from inside the app** — a browser client
  can't reset another user's Auth password. Use Firebase console → Authentication →
  Users → Reset password. (The edit form tells you this instead of silently failing.)
- **Deleting a doctor/patient in the app deletes their Firestore data and files**, but
  their Auth login entry remains in the console's user list until removed there.
  (Their access still dies immediately: profile/lookup documents are gone.)
- Doctor **patient-history is scoped to that doctor's own appointments** — enforced
  both in the app query and by the rules (a doctor can't read other doctors'
  appointment documents at all).
- ID documents are stricter than reports: only the patient and admins
  can read them — **not** doctors.
- **Files are limited to 700 KB each** because they are stored inside
  Firestore documents (a Spark-plan trade-off: Firebase Storage would need
  the Blaze billing plan on a new project). The app rejects larger files
  with a clear message asking for a compressed/resized copy.

## 🌟 Features by Role

### 👑 Admin Portal
- **Dashboard Overview** — Live counts (patients, doctors, appointments) via Firestore aggregation queries
- **Doctor Management** — Create (provisions a real Auth login), edit, delete, and ban/unban doctors; a banned doctor is signed out at login
- **Patient Records** — Search and browse all registered patients
- **Appointment Oversight** — View all appointments across the platform, filterable by status and searchable by patient/doctor name, with sort options
- **Off-Day Oversight** — All doctor leave days, filterable by doctor, with sort options
- *(By design, admins have no access to medical reports — those are patient + doctor only.)*

### 👨‍⚕️ Doctor Portal
- **Appointment Dashboard** — Pending vs. completed/cancelled at a glance
- **Appointment Detail** — Patient snapshot, treatment record, report status
- **Treatment Records** — Diagnosis, prescription, notes, cost & payment status (frozen once Completed)
- **Medical Report Upload** — One report per appointment, only for your own appointments, locked once submitted
- **Status Management** — Completed (terminal) / Cancelled (terminal, frees the slot lock)
- **Off-Day Management** — Leave days block patient booking for those dates
- **Patient History** — Your own visits/treatments/reports for that patient
- **Report Access Requests** — Ask a patient for temporary access to reports from their *other* doctors; the patient approves or denies from their notifications. Approved access lasts **48 hours**, shows a "valid until" time, and then expires — you request again after that
- **Notifications** — New bookings arrive here, with read/unread state

### 🧑 Patient Portal
- **Registration & Login** — Firebase Auth email/password
- **Profile Completion** — Details + ID document upload (required before booking)
- **Doctor Discovery** — Browse/filter doctors by specialization (banned doctors hidden)
- **Booking** — 10-minute slots, 10 AM–1 PM & 6–10 PM, up to 14 days ahead, no Wednesdays,
  exact-slot + per-hour capacity + own-clash rules enforced inside a transaction
- **Reports** — Upload a report against a completed appointment or an external doctor
- **Appointment History** — Includes the doctor's prescription and treatment notes
- **Notifications** — Booking confirmations, status changes, and report-access requests you can **approve or deny in place**; granting a doctor access to your reports lasts **48 hours** and then expires automatically

## 📂 Project structure

```
public/                  the whole app (Firebase Hosting root)
  index.html             loads AngularJS + Firebase compat SDK + firebase-config.js
  js/firebase-config.js  ← your project's config goes here
  js/services/api.service.js   the entire "backend": Auth + Firestore (data + files) calls
  js/services/auth.service.js  local session copy + Firebase sign-out
  js/controllers/…       unchanged role controllers
  views/…                  unchanged templates
firestore.rules          who can read/write what (the security boundary)
firestore.indexes.json   composite indexes for the app's queries
firebase.json            hosting (SPA rewrite + security headers), rules, emulators
firebase-seed/seed.js    one-time demo-data seeder (Admin SDK)
```

## 🧪 Local development with emulators

```bash
firebase emulators:start          # Auth 9099 · Firestore 8080 · Hosting 5000
# in another terminal:
cd firebase-seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 GCLOUD_PROJECT=demo-healthhub node seed.js
```

Then point `public/js/firebase-config.js` at a project with id `demo-healthhub`
(emulators accept any config values as long as `projectId` matches).
