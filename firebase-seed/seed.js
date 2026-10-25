// HealthHub Firebase seeder.
//
// Creates the same demo dataset the old SQL seed.sql created — 1 admin,
// 6 doctors, 6 patients, 14 appointments with treatments embedded — as
// Firebase Auth users + Firestore documents.
//
// Run it ONCE against your real project:
//   1. Firebase console → Project settings → Service accounts →
//      "Generate new private key" → save as firebase-seed/serviceAccountKey.json
//   2. cd firebase-seed && npm install
//   3. node seed.js
// Safe to re-run: existing Auth users are reused and demo documents are
// overwritten with the same deterministic ids.
//
// Login credentials are the same as the MySQL version:
//   admin    username: admin          password: Admin123
//   doctors  username: dr_arjun etc.  password: Doctor123
//   patients email logins             password: Patient123

const admin = require('firebase-admin');

if (process.env.FIRESTORE_EMULATOR_HOST) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'healthhub-demo' });
    console.log('Seeding the local EMULATOR at', process.env.FIRESTORE_EMULATOR_HOST);
} else {
    const key = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(key) });
    console.log('Seeding project', key.project_id);
}
const auth = admin.auth();
const db = admin.firestore();
const Ts = (s) => admin.firestore.Timestamp.fromDate(new Date(s));

async function userByEmail(email, password, displayName) {
    try {
        return await auth.getUserByEmail(email);
    } catch (e) {
        const u = await auth.createUser({ email, password, displayName });
        console.log('  created auth user', email);
        return u;
    }
}

// ---------------- demo data (mirrors the old database/seed.sql) --------
const DOCTORS = [
    { username: 'dr_arjun', name: 'Dr. Arjun Mehta', specialization: 'Cardiologist', phone: '+91 98200 11223', email: 'arjun.mehta@healthhub.com', location_name: 'HealthHub Central Clinic', location_address: 'MG Road, Mumbai, Maharashtra 400001', age: 42, experience_years: 15 },
    { username: 'dr_priya', name: 'Dr. Priya Nair', specialization: 'Dermatologist', phone: '+91 98200 22334', email: 'priya.nair@healthhub.com', location_name: 'HealthHub Skin Care Centre', location_address: 'Kochi, Kerala 682001', age: 38, experience_years: 11 },
    { username: 'dr_rohan', name: 'Dr. Rohan Kapoor', specialization: 'Orthopedic', phone: '+91 98110 33445', email: 'rohan.kapoor@healthhub.com', location_name: 'HealthHub Ortho Speciality Hospital', location_address: 'Karol Bagh, New Delhi 110005', age: 47, experience_years: 19 },
    { username: 'dr_sneha', name: 'Dr. Sneha Iyer', specialization: 'Pediatrician', phone: '+91 98450 44556', email: 'sneha.iyer@healthhub.com', location_name: 'HealthHub Child Care Clinic', location_address: 'Indiranagar, Bengaluru, Karnataka 560038', age: 36, experience_years: 9 },
    { username: 'dr_vikram', name: 'Dr. Vikram Singh', specialization: 'General Physician', phone: '+91 98330 55667', email: 'vikram.singh@healthhub.com', location_name: 'HealthHub Family Health Centre', location_address: 'Sector 17, Chandigarh 160017', age: 50, experience_years: 22 },
    { username: 'dr_kavitha', name: 'Dr. Kavitha Rao', specialization: 'Gynecologist', phone: '+91 98490 66778', email: 'kavitha.rao@healthhub.com', location_name: 'HealthHub Women Wellness Hospital', location_address: 'Banjara Hills, Hyderabad, Telangana 500034', age: 44, experience_years: 16 }
];

const PATIENTS = [
    { name: 'Rahul Sharma', email: 'rahul.sharma@gmail.com', phone: '+91 98765 43210', age: 31, dob: '1994-11-30', gender: 'Male', address: 'Andheri West, Mumbai, Maharashtra 400058', id_type: 'Aadhar', id_number: '2345 6789 0123' },
    { name: 'Ananya Verma', email: 'ananya.verma@gmail.com', phone: '+91 98111 22334', age: 27, dob: '1998-12-05', gender: 'Female', address: 'Hauz Khas, New Delhi 110016', id_type: 'Aadhar', id_number: '3456 7890 1234' },
    { name: 'Karthik Menon', email: 'karthik.menon@gmail.com', phone: '+91 98470 11223', age: 35, dob: '1990-11-15', gender: 'Male', address: 'Ernakulam, Kochi, Kerala 682016', id_type: 'Passport', id_number: 'N4829103' },
    { name: 'Divya Patel', email: 'divya.patel@gmail.com', phone: '+91 98980 33445', age: 29, dob: '1996-11-25', gender: 'Female', address: 'Satellite, Ahmedabad, Gujarat 380015', id_type: 'Aadhar', id_number: '4567 8901 2345' },
    { name: 'Mohammed Faiz', email: 'mohammed.faiz@gmail.com', phone: '+91 97420 55667', age: 41, dob: '1985-01-20', gender: 'Male', address: 'Frazer Town, Bengaluru, Karnataka 560005', id_type: 'Voter ID', id_number: 'XYZ1234567' },
    { name: 'Shreya Kulkarni', email: 'shreya.kulkarni@gmail.com', phone: '+91 98225 77889', age: 24, dob: '2001-11-08', gender: 'Female', address: 'Kothrud, Pune, Maharashtra 411038', id_type: 'Aadhar', id_number: '5678 9012 3456' }
];

// patient email, doctor username, date, time, status
const APPOINTMENTS = [
    ['rahul.sharma@gmail.com', 'dr_arjun', '2026-03-16', '10:00:00', 'Completed'],
    ['ananya.verma@gmail.com', 'dr_priya', '2026-03-16', '10:00:00', 'Completed'],
    ['karthik.menon@gmail.com', 'dr_rohan', '2026-03-16', '18:00:00', 'Completed'],
    ['divya.patel@gmail.com', 'dr_sneha', '2026-03-17', '10:00:00', 'Completed'],
    ['mohammed.faiz@gmail.com', 'dr_vikram', '2026-03-17', '19:00:00', 'Completed'],
    ['shreya.kulkarni@gmail.com', 'dr_kavitha', '2026-03-18', '10:20:00', 'Completed'],
    ['rahul.sharma@gmail.com', 'dr_vikram', '2026-03-19', '10:00:00', 'Completed'],
    ['ananya.verma@gmail.com', 'dr_arjun', '2026-03-20', '18:30:00', 'Completed'],
    ['karthik.menon@gmail.com', 'dr_arjun', '2026-03-21', '11:00:00', 'Cancelled'],
    ['divya.patel@gmail.com', 'dr_priya', '2026-03-22', '10:00:00', 'Cancelled'],
    ['rahul.sharma@gmail.com', 'dr_arjun', '2026-04-06', '10:00:00', 'Pending'],
    ['ananya.verma@gmail.com', 'dr_priya', '2026-04-06', '11:00:00', 'Pending'],
    ['karthik.menon@gmail.com', 'dr_rohan', '2026-04-07', '18:00:00', 'Pending'],
    ['mohammed.faiz@gmail.com', 'dr_vikram', '2026-04-08', '10:00:00', 'Pending']
];

// appointment index (1-based) -> treatment
const TREATMENTS = {
    1: { diagnosis: 'Stable angina — mild coronary artery disease', prescription: 'Aspirin 75mg OD, Atorvastatin 20mg HS, Metoprolol 25mg BD', treatment_notes: 'ECG and TMT reviewed. Advised low-fat diet, daily 30-min walk. Review after 4 weeks with lipid profile.', treatment_cost: 2500, payment_status: 'Paid' },
    2: { diagnosis: 'Atopic dermatitis (eczema) — moderate', prescription: 'Moisturizer (ceramide-based) twice daily, Tacrolimus 0.03% ointment BD for 2 weeks, Cetirizine 10mg HS', treatment_notes: 'Avoid harsh soaps and known triggers. Patch test scheduled if no improvement in 3 weeks.', treatment_cost: 1200, payment_status: 'Paid' },
    3: { diagnosis: 'ACL strain — right knee (Grade I)', prescription: 'Paracetamol 650mg TDS for 5 days, Diclofenac gel for local application', treatment_notes: 'RICE protocol advised. Physiotherapy referral given. MRI only if instability persists beyond 2 weeks.', treatment_cost: 1800, payment_status: 'Paid' },
    4: { diagnosis: 'Acute viral fever with mild dehydration', prescription: 'Paracetamol syrup 250mg/5ml — 5ml SOS for fever, ORS as needed', treatment_notes: 'Plenty of fluids. Dengue NS1 test done — negative. Review if fever persists beyond 3 days.', treatment_cost: 800, payment_status: 'Paid' },
    5: { diagnosis: 'Type 2 Diabetes Mellitus — routine follow-up, HbA1c 7.2%', prescription: 'Metformin 500mg BD (continue), Glimepiride 1mg OD', treatment_notes: 'Fasting sugar 118 mg/dL. Diet chart provided. HbA1c recheck after 3 months.', treatment_cost: 950, payment_status: 'Unpaid' },
    6: { diagnosis: 'Routine antenatal check-up — 24 weeks gestation', prescription: 'Iron + Folic acid supplement OD, Calcium 500mg BD', treatment_notes: 'Growth scan normal. BP 110/70. Glucose tolerance test scheduled at next visit.', treatment_cost: 1500, payment_status: 'Paid' },
    7: { diagnosis: 'Acute gastritis', prescription: 'Pantoprazole 40mg OD before breakfast for 14 days, Antacid gel SOS', treatment_notes: 'Advised small frequent meals, avoid spicy food and NSAIDs. Review after 2 weeks.', treatment_cost: 700, payment_status: 'Unpaid' },
    8: { diagnosis: 'Hypertension — Stage 1, newly detected', prescription: 'Telmisartan 40mg OD', treatment_notes: 'BP 142/90 on two readings. Salt restriction advised. Home BP monitoring chart given. Review in 2 weeks.', treatment_cost: 1600, payment_status: 'Paid' }
};

// doctor username, off date
const OFF_DAYS = [
    ['dr_arjun', '2026-04-10'], ['dr_arjun', '2026-04-17'], ['dr_priya', '2026-04-11'],
    ['dr_priya', '2026-04-25'], ['dr_rohan', '2026-04-12'], ['dr_rohan', '2026-04-19'],
    ['dr_sneha', '2026-04-13'], ['dr_sneha', '2026-04-27'], ['dr_vikram', '2026-04-09'],
    ['dr_kavitha', '2026-04-15']
];

async function main() {
    const batch = db.batch();
    const doctorUid = {}; const doctorByUser = {};
    const patientUid = {}; const patientByEmail = {};

    console.log('Admin…');
    const adminUser = await userByEmail('admin@healthhub.com', 'Admin123', 'Administrator');
    batch.set(db.collection('accounts').doc(adminUser.uid), { role: 'admin', name: 'Administrator', email: 'admin@healthhub.com', username: 'admin' });
    batch.set(db.collection('usernames').doc('admin'), { email: 'admin@healthhub.com', role: 'admin', uid: adminUser.uid });

    console.log('Doctors…');
    for (const d of DOCTORS) {
        const u = await userByEmail(d.email, 'Doctor123', d.name);
        doctorUid[d.username] = u.uid; doctorByUser[d.username] = d;
        batch.set(db.collection('doctors').doc(u.uid), {
            name: d.name, specialization: d.specialization, phone: d.phone, email: d.email,
            username: d.username, location_name: d.location_name, location_address: d.location_address,
            age: d.age, experience_years: d.experience_years, is_banned: false,
            created_at: Ts('2026-03-10T10:00:00Z')
        });
        batch.set(db.collection('accounts').doc(u.uid), { role: 'doctor', name: d.name, email: d.email, username: d.username });
        batch.set(db.collection('usernames').doc(d.username), { email: d.email, role: 'doctor', uid: u.uid });
    }

    console.log('Patients…');
    for (const p of PATIENTS) {
        const u = await userByEmail(p.email, 'Patient123', p.name);
        patientUid[p.email] = u.uid; patientByEmail[p.email] = p;
        batch.set(db.collection('patients').doc(u.uid), {
            name: p.name, email: p.email, phone: p.phone, age: p.age, dob: p.dob, gender: p.gender,
            address: p.address, id_type: p.id_type, id_number: p.id_number,
            id_document_path: null, profile_complete: true,
            registration_date: Ts('2026-03-12T10:00:00Z')
        });
        batch.set(db.collection('accounts').doc(u.uid), { role: 'patient', name: p.name, email: p.email });
    }
    await batch.commit();

    console.log('Appointments + treatments + slot locks (Pending only) + off-days…');
    const b2 = db.batch();
    APPOINTMENTS.forEach((a, i) => {
        const n = i + 1;
        const p = patientByEmail[a[0]]; const d = doctorByUser[a[1]];
        const t = TREATMENTS[n] || null;
        const id = 'seed-appt-' + n;
        b2.set(db.collection('appointments').doc(id), {
            patient_id: patientUid[a[0]], patient_name: p.name, patient_age: p.age,
            patient_gender: p.gender, patient_phone: p.phone, patient_address: p.address,
            doctor_id: doctorUid[a[1]], doctor_name: d.name, specialization: d.specialization,
            doctor_phone: d.phone, appointment_date: a[2], appointment_time: a[3],
            slot_hour: a[3].substring(0, 2), status: a[4],
            treatment: t, created_at: Ts('2026-03-15T09:00:00Z')
        });
        if (a[4] === 'Pending') {
            b2.set(db.collection('slotLocks').doc(doctorUid[a[1]] + '_' + a[2] + '_' + a[3]), {
                appointment_id: id, patient_id: patientUid[a[0]], doctor_id: doctorUid[a[1]],
                appointment_date: a[2], appointment_time: a[3], slot_hour: a[3].substring(0, 2)
            });
        }
    });
    OFF_DAYS.forEach((o) => {
        b2.set(db.collection('doctorOffDays').doc(doctorUid[o[0]] + '_' + o[1]), {
            doctor_id: doctorUid[o[0]], off_date: o[1]
        });
    });
    b2.set(db.collection('_meta').doc('seed'), { seeded_at: admin.firestore.FieldValue.serverTimestamp(), version: 'firebase-1' });
    await b2.commit();

    console.log('Done. Demo logins: admin/Admin123 · dr_arjun/Doctor123 · rahul.sharma@gmail.com/Patient123');
}

main().then(() => process.exit(0)).catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
