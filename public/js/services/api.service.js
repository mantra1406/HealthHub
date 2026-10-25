// HealthHub API Service — Firebase edition (no backend server).
//
// This service keeps EXACTLY the interface the controllers were written
// against (methods returning promises that resolve to { data: ... } and
// reject with { data: { error } }), but every call now goes straight to
// Firebase: Authentication for logins, Firestore for data AND files.
// Enforcement of the business rules lives in this service AND in
// firestore.rules, which are the real security boundary
// in a serverless app.
//
// Data model (Firestore):
//   accounts/{uid}        { role, name, email, username? }
//   usernames/{username}  { email, role, uid }     (username -> email login)
//   doctors/{uid}         profile + is_banned
//   patients/{uid}        profile + profile_complete
//   appointments/{id}     patient/doctor fields DENORMALIZED (no joins in
//                         Firestore) + treatment embedded as a map
//   reports/{id}          metadata; file_path holds a files/{id} reference
//   files/{id}            base64 file bytes (reports + ID docs, <=700 KB)
//   doctorOffDays/{doctorId_date}
//   slotLocks/{doctorId_date_time}   one doc per occupied slot — created in
//                         the SAME transaction as the appointment, so a
//                         slot can never be double-booked, and hour/clash
//                         counts read locks instead of other patients'
//                         appointments (which patients may not read).
angular.module('healthhubApp').service('ApiService', ['$q', 'AuthService', function ($q, AuthService) {
    var self = this;

    // ---------- plumbing ----------
    function fb() {
        if (!window.HEALTHHUB_FIREBASE_READY) {
            throw new Error('Firebase is not configured yet — fill in public/js/firebase-config.js (see README).');
        }
        return window.firebase;
    }
    function auth() { return fb().auth(); }
    function db() { return fb().firestore(); }
    function serverTs() { return fb().firestore.FieldValue.serverTimestamp(); }

    // Firebase Auth restores the session asynchronously after a reload;
    // wait for the first auth-state callback before trusting currentUser.
    var authReady = new Promise(function (resolve) {
        var done = false;
        try {
            fb().auth().onAuthStateChanged(function (u) { if (!done) { done = true; resolve(u); } });
        } catch (e) { resolve(null); }
    });
    function requireUser() {
        return authReady.then(function () {
            var u = auth().currentUser;
            if (!u) throw new Error('Not logged in');
            return u;
        });
    }

    function friendlyError(err) {
        if (!err) return 'Something went wrong. Please try again.';
        if (err.message && ['slot-taken', 'PROFILE_INCOMPLETE'].indexOf(err.message) >= 0) return err.message;
        var code = err.code || '';
        var map = {
            'auth/user-not-found': 'Invalid credentials',
            'auth/wrong-password': 'Invalid credentials',
            'auth/invalid-credential': 'Invalid credentials',
            'auth/invalid-email': 'Invalid credentials',
            'auth/email-already-in-use': 'Email already registered',
            'auth/weak-password': 'Password is too weak',
            'auth/account-exists-with-different-credential': 'This email is already registered with a password. Please sign in with your password instead.',
            'auth/popup-closed-by-user': 'The sign-in popup was closed before finishing.',
            'auth/cancelled-popup-request': 'The sign-in popup was closed before finishing.',
            'auth/popup-blocked': 'Your browser blocked the sign-in popup — please allow popups for this site and try again.',
            'auth/operation-not-allowed': 'This sign-in method is not enabled. Please enable it in the Firebase console (Authentication → Sign-in method).',
            'auth/unauthorized-domain': 'This website address is not authorized for sign-in. Add it in the Firebase console (Authentication → Settings → Authorized domains).',
            'auth/too-many-requests': 'Too many attempts. Please try again in a few minutes.',
            'auth/network-request-failed': 'Network error. Please check your connection.',
            'permission-denied': 'Access denied',
            'failed-precondition': 'This view needs a database index that is still being created. Please wait a minute and refresh.',
        };
        if (map[code]) return map[code];
        if (code === 'permission-denied' || (err.message || '').indexOf('permission') >= 0) return 'Access denied';
        return err.message || 'Something went wrong. Please try again.';
    }

    // Wrap a native promise into an Angular $q promise shaped like the old
    // $http results ({ data }) so controllers work unchanged — including
    // digest integration, which raw Promises would bypass.
    function wrap(promise) {
        return $q.when(promise).then(
            function (data) { return { data: data }; },
            function (err) { return $q.reject({ data: { error: friendlyError(err) } }); }
        );
    }
    function run(fn) {
        return wrap(Promise.resolve().then(fn));
    }

    function tsToISO(v) {
        if (!v) return null;
        if (typeof v === 'string') return v;
        if (v.toDate) return v.toDate().toISOString();
        return null;
    }

    // ---------- small validation helpers (mirror of the old backend) ----
    function isValidDateStr(s) {
        if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
        var p = s.split('-').map(Number);
        var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
        return dt.getUTCFullYear() === p[0] && dt.getUTCMonth() === p[1] - 1 && dt.getUTCDate() === p[2];
    }
    function dayOfWeekUTC(dateStr) {
        var p = String(dateStr).split('-').map(Number);
        return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    }
    function toYMD(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function addDaysYMD(dateStr, days) {
        var p = dateStr.split('-').map(Number);
        var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
        return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
    }
    function isValidSlotTime(t) {
        var m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
        if (!m) return false;
        var h = Number(m[1]), min = Number(m[2]), sec = m[3] ? Number(m[3]) : 0;
        if (sec !== 0 || min % 10 !== 0) return false;
        return (h >= 10 && h < 13) || (h >= 18 && h < 22);
    }
    function generateSlots() {
        var slots = [];
        [10, 18].forEach(function (start) {
            var end = start === 10 ? 13 : 22, h = start, min = 0;
            while (h < end) {
                slots.push(String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00');
                min += 10; if (min >= 60) { min -= 60; h++; }
            }
        });
        return slots;
    }
    // ---------- validation regexes (single source of truth) -------------
    // The same patterns are mirrored as HTML `pattern` attributes in the
    // register form; these service-side checks are the real gate because
    // client markup can be bypassed.
    var REGEX = {
        // Letters, spaces and dots; 3-50 chars (e.g. "Aarohi Joshi", "Dr. R. Rao")
        name: /^[A-Za-z][A-Za-z .]{2,49}$/,
        // Standard pragmatic email pattern
        email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
        // Indian mobile AFTER spaces/hyphens are stripped: optional +91,
        // then 10 digits starting 6-9
        phone: /^(\+91)?[6-9]\d{9}$/,
        // New passwords: 8+ chars with at least one letter and one number
        password: /^(?=.*[A-Za-z])(?=.*\d).{8,}$/,
        // Doctor usernames: 3-20 letters/digits/underscore (e.g. dr_arjun)
        username: /^[A-Za-z0-9_]{3,20}$/,
        // ID document numbers, checked per type in patientCompleteProfile
        idNumber: {
            'Aadhar': /^\d{4}\s?\d{4}\s?\d{4}$/,
            'Passport': /^[A-Za-z][0-9]{7}$/,
            'Voter ID': /^[A-Za-z]{3}[0-9]{7}$/
        }
    };
    function isValidEmail(s) { return REGEX.email.test(String(s || '').trim()); }
    var GENDERS = ['Male', 'Female', 'Other'];
    var ID_TYPES = ['Aadhar', 'Passport', 'Voter ID'];
    var MAX_BOOKING_DAYS_AHEAD = 14;

    // ---------- mappers: Firestore doc -> the shapes the views expect ---
    function mapDoctor(snap) {
        var d = snap.data();
        return {
            doctor_id: snap.id, name: d.name, specialization: d.specialization,
            phone: d.phone, email: d.email, username: d.username,
            location_name: d.location_name || null, location_address: d.location_address || null,
            age: d.age || null, experience_years: d.experience_years || null,
            is_banned: !!d.is_banned, created_at: tsToISO(d.created_at)
        };
    }
    function mapPatient(snap) {
        var d = snap.data();
        return {
            patient_id: snap.id, name: d.name, email: d.email, phone: d.phone,
            age: d.age || null, dob: d.dob || null, gender: d.gender || null, address: d.address || null,
            id_type: d.id_type || null, id_number: d.id_number || null,
            id_document_path: d.id_document_path || null,
            profile_complete: !!d.profile_complete, registration_date: tsToISO(d.registration_date)
        };
    }
    function mapAppointment(snap) {
        var d = snap.data(), t = d.treatment || null;
        return {
            appointment_id: snap.id,
            appointment_date: d.appointment_date, appointment_time: d.appointment_time,
            status: d.status, created_at: tsToISO(d.created_at),
            patient_id: d.patient_id, patient_name: d.patient_name,
            age: d.patient_age || null, gender: d.patient_gender || null,
            patient_phone: d.patient_phone || null, address: d.patient_address || null,
            doctor_id: d.doctor_id, doctor_name: d.doctor_name, specialization: d.specialization,
            doctor_phone: d.doctor_phone || null,
            treatment_id: t ? snap.id : null,
            diagnosis: t ? t.diagnosis : null, prescription: t ? t.prescription : null,
            treatment_notes: t ? t.treatment_notes : null,
            treatment_cost: t ? t.treatment_cost : null, payment_status: t ? t.payment_status : null
        };
    }
    function mapReport(snap) {
        var d = snap.data();
        return {
            report_id: snap.id, report_type: d.report_type, file_path: d.file_path,
            doctor_id: d.doctor_id || null, uploaded_by: d.uploaded_by || null,
            upload_date: tsToISO(d.upload_date), external_doctor_name: d.external_doctor_name || null,
            patient_id: d.patient_id, patient_name: d.patient_name || null,
            appointment_id: d.appointment_id || null, appointment_date: d.appointment_date || null,
            doctor_name: d.doctor_name || null
        };
    }

    // ---------- file storage (inside Firestore — no Firebase Storage) ---
    // Why: on new projects Firebase Storage now requires the Blaze billing
    // plan, and this project runs on Spark. So report / ID files are stored
    // as documents in the `files` collection, base64-encoded. A Firestore
    // document caps at ~1 MiB and base64 inflates by ~37%, hence the
    // 700 KB per-file limit. `file_path` fields elsewhere hold the file
    // document's id.
    var MAX_FILE_BYTES = 700 * 1024;
    function readFileAsBase64(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () {
                var result = String(reader.result || '');
                var comma = result.indexOf(',');
                resolve(comma >= 0 ? result.slice(comma + 1) : result);
            };
            reader.onerror = function () { reject(new Error('Could not read the selected file')); };
            reader.readAsDataURL(file);
        });
    }
    function storeFile(patientId, kind, file) {
        if (!file) return Promise.reject(new Error('No file uploaded'));
        if (file.size > MAX_FILE_BYTES) {
            return Promise.reject(new Error('File is too large (' + Math.round(file.size / 1024) + ' KB). Because files are stored in the database, the limit is 700 KB — please compress or resize it and try again.'));
        }
        return readFileAsBase64(file).then(function (b64) {
            return db().collection('files').add({
                patient_id: patientId, kind: kind,
                file_name: file.name || 'file', content_type: file.type || 'application/octet-stream',
                size: file.size, data_base64: b64, created_at: serverTs()
            }).then(function (ref) { return ref.id; });
        });
    }
    function deleteFileQuiet(fileId) {
        if (!fileId) return Promise.resolve();
        return db().collection('files').doc(fileId).delete().catch(function () { });
    }
    function base64ToBlob(b64, type) {
        var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: type || 'application/octet-stream' });
    }

    // ---------- session / login ----------
    function sessionPayload(user, extra) {
        return user.getIdToken().then(function (token) {
            return Object.assign({ token: token }, extra);
        });
    }

    // ---------- notifications ----------
    // Fire-and-forget: a notification failure must never fail the action
    // that triggered it (booking, status change, report upload).
    function notify(userId, type, title, message, refId) {
        if (!userId) return Promise.resolve();
        return db().collection('notifications').add({
            user_id: userId, type: type, title: title, message: message,
            ref_id: refId || null, action_done: false,
            is_read: false, created_at: serverTs()
        }).then(function () { }).catch(function () { });
    }
    function mapNotification(snap) {
        var d = snap.data();
        return {
            notification_id: snap.id, type: d.type || 'info', title: d.title || '',
            message: d.message || '', is_read: !!d.is_read, created_at: tsToISO(d.created_at),
            ref_id: d.ref_id || null, action_done: !!d.action_done
        };
    }
    self.getNotifications = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('notifications').where('user_id', '==', user.uid).get()
                    .then(function (qs) {
                        var rows = qs.docs.map(mapNotification);
                        rows.sort(function (a, b) { return (b.created_at || '') < (a.created_at || '') ? -1 : 1; });
                        return rows.slice(0, 50);
                    });
            });
        });
    };
    self.markNotificationRead = function (id) {
        return run(function () {
            return requireUser().then(function () {
                return db().collection('notifications').doc(id).update({ is_read: true })
                    .then(function () { return { message: 'ok' }; });
            });
        });
    };
    self.markNotificationActionDone = function (id) {
        return run(function () {
            return requireUser().then(function () {
                return db().collection('notifications').doc(id).update({ action_done: true, is_read: true })
                    .then(function () { return { message: 'ok' }; });
            });
        });
    };

    // ---------- report access requests ----------
    // A doctor asks a patient for permission to see the patient's
    // previous reports (from other doctors). The patient answers from
    // their notifications; approval adds the doctor to every report's
    // shared_doctor_ids, which the rules honour for reads. One request
    // document per doctor+patient pair: {doctorId}_{patientId}.
    self.requestReportAccess = function (patientId, patientName) {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('doctors').doc(user.uid).get().then(function (dSnap) {
                    var dName = dSnap.exists ? dSnap.data().name : 'Your doctor';
                    var ref = db().collection('reportAccessRequests').doc(user.uid + '_' + patientId);
                    return ref.get().then(function (s) { return s; }, function () { return null; }).then(function (snap) {
                        if (!snap) snap = { exists: false };
                        if (snap.exists && snap.data().status === 'approved') throw new Error('You already have access to this patient\'s previous reports.');
                        if (snap.exists && snap.data().status === 'pending') throw new Error('Your request is already pending with the patient.');
                        var send = snap.exists
                            ? ref.update({ status: 'pending', created_at: serverTs(), decided_at: null })
                            : ref.set({ doctor_id: user.uid, doctor_name: dName, patient_id: patientId, patient_name: patientName || '', status: 'pending', created_at: serverTs(), decided_at: null });
                        return send.then(function () {
                            notify(patientId, 'access_request', 'Report access request',
                                dName + ' is asking permission to view your previous medical reports. You can approve or deny this from your notifications.', ref.id);
                            return { message: 'Request sent to the patient' };
                        });
                    });
                });
            });
        });
    };
    self.getReportAccessStatus = function (patientId) {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('reportAccessRequests').doc(user.uid + '_' + patientId).get()
                    .then(function (snap) {
                        if (!snap.exists) return { status: null, expires_at: null };
                        var d = snap.data(), exp = tsToISO(d.expires_at);
                        var status = d.status;
                        if (status === 'approved' && exp && exp <= new Date().toISOString()) status = 'expired';
                        return { status: status, expires_at: exp };
                    },
                          function () { return { status: null, expires_at: null }; });
            });
        });
    };
    self.getSharedReports = function (patientId) {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('reportAccessRequests').doc(user.uid + '_' + patientId).get()
                    .then(function (snap) {
                        if (!snap.exists || snap.data().status !== 'approved') return [];
                        var e = snap.data().expires_at;
                        if (e && e.toDate && e.toDate().getTime() <= Date.now()) return [];
                        return db().collection('reports').where('shared_doctor_ids', 'array-contains', user.uid).get()
                    .then(function (qs) {
                        var rows = qs.docs.map(mapReport).filter(function (r) { return r.patient_id === patientId; });
                        rows.sort(function (a, b) { return (b.upload_date || '') < (a.upload_date || '') ? -1 : 1; });
                        return rows;
                    });
                    });
            });
        });
    };
    // Patient-side expiry sweep: for every approved-but-expired access
    // grant, mark the request 'expired' and remove the doctor from the
    // shared_doctor_ids of the patient's reports (the doctor's app also
    // hides shared reports the moment the window passes, so access
    // ends on time even before this sweep runs).
    self.expireAccessSweep = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('reportAccessRequests')
                    .where('patient_id', '==', user.uid).where('status', '==', 'approved').get()
                    .then(function (qs) {
                        var now = Date.now();
                        var expired = qs.docs.filter(function (s) {
                            var e = s.data().expires_at;
                            return e && e.toDate && e.toDate().getTime() <= now;
                        });
                        if (!expired.length) return { expired: 0 };
                        return db().collection('reports').where('patient_id', '==', user.uid).get().then(function (rqs) {
                            var batch = db().batch();
                            expired.forEach(function (reqSnap) {
                                var docId = reqSnap.data().doctor_id;
                                batch.update(reqSnap.ref, { status: 'expired' });
                                rqs.forEach(function (r) {
                                    var cur = r.data().shared_doctor_ids || [];
                                    if (cur.indexOf(docId) >= 0) {
                                        batch.update(r.ref, { shared_doctor_ids: fb().firestore.FieldValue.arrayRemove(docId) });
                                    }
                                });
                                notify(docId, 'access_result', 'Report access expired',
                                    'Your 2-day access to ' + (reqSnap.data().patient_name || 'the patient') + '\'s previous reports has expired. You can request permission again from their profile page.');
                            });
                            return batch.commit().then(function () { return { expired: expired.length }; });
                        });
                    });
            });
        });
    };

    self.respondAccessRequest = function (requestId, approve) {
        return run(function () {
            return requireUser().then(function (user) {
                var ref = db().collection('reportAccessRequests').doc(requestId);
                return ref.get().then(function (snap) {
                    if (!snap.exists || snap.data().patient_id !== user.uid) throw new Error('Request not found');
                    var req = snap.data();
                    if (req.status !== 'pending') throw new Error('This request was already answered.');
                    var upd = { status: approve ? 'approved' : 'denied', decided_at: serverTs() };
                    if (approve) {
                        upd.approved_at = serverTs();
                        upd.expires_at = fb().firestore.Timestamp.fromDate(new Date(Date.now() + 2 * 24 * 3600 * 1000));
                    }
                    return ref.update(upd).then(function () {
                        var shareJob = Promise.resolve();
                        if (approve) {
                            shareJob = db().collection('reports').where('patient_id', '==', user.uid).get().then(function (qs) {
                                var batch = db().batch(), n = 0;
                                qs.forEach(function (s) {
                                    var cur = s.data().shared_doctor_ids || [];
                                    if (cur.indexOf(req.doctor_id) < 0) {
                                        batch.update(s.ref, { shared_doctor_ids: fb().firestore.FieldValue.arrayUnion(req.doctor_id) });
                                        n++;
                                    }
                                });
                                return n ? batch.commit() : null;
                            });
                        }
                        return shareJob.then(function () {
                            notify(req.doctor_id, 'access_result', approve ? 'Report access approved' : 'Report access denied',
                                approve ? (req.patient_name || 'The patient') + ' approved your request — you can view their previous reports for the next 2 days from the patient profile page.'
                                        : (req.patient_name || 'The patient') + ' denied your request to view their previous reports.');
                            return { message: approve ? 'Access approved' : 'Access denied' };
                        });
                    });
                });
            });
        });
    };

    self.markAllNotificationsRead = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('notifications').where('user_id', '==', user.uid).get()
                    .then(function (qs) {
                        var batch = db().batch(), n = 0;
                        qs.forEach(function (s) { if (!s.data().is_read) { batch.update(s.ref, { is_read: true }); n++; } });
                        return n ? batch.commit() : null;
                    }).then(function () { return { message: 'ok' }; });
            });
        });
    };
    function lookupUsername(username) {
        return db().collection('usernames').doc(String(username || '').trim().toLowerCase()).get()
            .then(function (snap) {
                if (!snap.exists) throw new Error('Invalid credentials');
                return snap.data();
            });
    }
    function signInByEmail(email, password) {
        return auth().signInWithEmailAndPassword(email, password).then(function (cred) { return cred.user; });
    }

    self.adminLogin = function (data) {
        return run(function () {
            return lookupUsername(data.username).then(function (rec) {
                if (rec.role !== 'admin') throw new Error('Invalid credentials');
                return signInByEmail(rec.email, data.password || '');
            }).then(function (user) {
                return db().collection('accounts').doc(user.uid).get().then(function (snap) {
                    if (!snap.exists || snap.data().role !== 'admin') {
                        return auth().signOut().then(function () { throw new Error('Invalid credentials'); });
                    }
                    return sessionPayload(user, { username: data.username, name: snap.data().name || data.username, role: 'admin' });
                });
            });
        });
    };

    self.doctorLogin = function (data) {
        return run(function () {
            return lookupUsername(data.username).then(function (rec) {
                if (rec.role !== 'doctor') throw new Error('Invalid credentials');
                return signInByEmail(rec.email, data.password || '');
            }).then(function (user) {
                return db().collection('doctors').doc(user.uid).get().then(function (snap) {
                    if (!snap.exists) {
                        return auth().signOut().then(function () { throw new Error('Invalid credentials'); });
                    }
                    var d = snap.data();
                    if (d.is_banned) {
                        // Ban enforcement, same as the fixed backend.
                        return auth().signOut().then(function () {
                            throw { code: 'banned', message: 'This account has been suspended. Please contact the administrator.' };
                        });
                    }
                    return sessionPayload(user, { username: d.username, name: d.name, role: 'doctor', specialization: d.specialization });
                });
            });
        });
    };

    // Forgot password — Firebase sends the reset email. Patients identify
    // by email; doctors/admins by username (resolved via the usernames
    // lookup). The outward response is IDENTICAL whether or not the
    // account exists, so the form can't be used to probe for accounts.
    // Change own password while signed in. Re-authenticates with the
    // current password first (Firebase requires a recent login for this).
    // Google-only accounts have no password to re-authenticate with — they
    // are told to use "Forgot password" on the login page instead.
    self.changePassword = function (currentPassword, newPassword) {
        return run(function () {
            return requireUser().then(function (user) {
                if (!currentPassword) throw new Error('Enter your current password');
                if (!newPassword || !REGEX.password.test(newPassword)) {
                    throw new Error('New password must be at least 8 characters with a letter and a number');
                }
                if (currentPassword === newPassword) {
                    throw new Error('New password must be different from the current one');
                }
                var hasPassword = (user.providerData || []).some(function (p) {
                    return p.providerId === 'password';
                });
                if (!hasPassword) {
                    throw new Error('This account signs in with Google — use "Forgot password" on the login page to set a password first.');
                }
                var credential = fb().auth.EmailAuthProvider.credential(user.email, currentPassword);
                return user.reauthenticateWithCredential(credential).catch(function (e) {
                    if (e && (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential')) {
                        throw new Error('Current password is incorrect');
                    }
                    throw e;
                }).then(function () {
                    return user.updatePassword(newPassword);
                }).then(function () { return { data: { ok: true } }; });
            });
        });
    };

    self.forgotPassword = function (identifier, role) {
        return run(function () {
            var done = { message: 'If an account matches, a password reset link has been sent to its email address.' };
            var emailPromise;
            if (role === 'patient') {
                var email = String(identifier || '').trim().toLowerCase();
                if (!REGEX.email.test(email)) throw new Error('Enter a valid email address');
                emailPromise = Promise.resolve(email);
            } else {
                var uname = String(identifier || '').trim().toLowerCase();
                if (!REGEX.username.test(uname)) throw new Error('Enter a valid username');
                emailPromise = db().collection('usernames').doc(uname).get()
                    .then(function (s) { return s.exists ? s.data().email : null; });
            }
            return emailPromise.then(function (email) {
                if (!email) return done;
                return auth().sendPasswordResetEmail(email)
                    .then(function () { return done; })
                    .catch(function () { return done; });
            });
        });
    };

    self.patientLogin = function (data) {
        return run(function () {
            var email = String((data && data.email) || '').trim().toLowerCase();
            return signInByEmail(email, (data && data.password) || '').then(function (user) {
                return db().collection('patients').doc(user.uid).get().then(function (snap) {
                    if (!snap.exists) {
                        return auth().signOut().then(function () { throw new Error('Invalid credentials'); });
                    }
                    var d = snap.data();
                    return sessionPayload(user, {
                        email: d.email, name: d.name, role: 'patient',
                        profile_complete: !!d.profile_complete
                    });
                });
            });
        });
    };

    self.patientRegister = function (data) {
        return run(function () {
            var name = String(data.name || '').trim();
            var email = String(data.email || '').trim().toLowerCase();
            var phone = String(data.phone || '').trim();
            if (!name || !email || !phone || !data.password) throw new Error('Name, email, phone and password are required');
            if (!REGEX.name.test(name)) throw new Error('Name must be 3-50 characters, letters only');
            if (!isValidEmail(email)) throw new Error('A valid email is required');
            if (!REGEX.phone.test(phone.replace(/[\s-]/g, ''))) throw new Error('Enter a valid 10-digit mobile number');
            if (!REGEX.password.test(String(data.password))) throw new Error('Password must be at least 8 characters with at least one letter and one number');
            return auth().createUserWithEmailAndPassword(email, data.password).then(function (cred) {
                var uid = cred.user.uid;
                var batch = db().batch();
                batch.set(db().collection('patients').doc(uid), {
                    name: name, email: email, phone: phone,
                    age: null, dob: null, gender: null, address: null, id_type: null, id_number: null,
                    id_document_path: null, profile_complete: false, registration_date: serverTs()
                });
                batch.set(db().collection('accounts').doc(uid), { role: 'patient', name: name, email: email });
                return batch.commit().then(function () {
                    return sessionPayload(cred.user, { email: email, name: name, role: 'patient', profile_complete: false });
                });
            });
        });
    };

    // Social sign-in (Google / Apple) — PATIENTS ONLY. Doctors and admins
    // keep username + password (their accounts are provisioned, not
    // self-registered). The provider must be enabled in the Firebase
    // console (Authentication → Sign-in method) or Firebase returns
    // auth/operation-not-allowed, which friendlyError explains.
    // First social sign-in auto-provisions the patient profile, exactly
    // like email registration (profile_complete = false).
    self.patientSocialLogin = function (providerName) {
        return run(function () {
            var provider;
            if (providerName === 'google') {
                // Bind the class first: `new fb().auth.GoogleAuthProvider()`
                // parses as `(new fb()).auth.GoogleAuthProvider()` — a plain
                // CALL of the class, which throws "Class constructor ...
                // cannot be invoked without 'new'".
                var GoogleProvider = fb().auth.GoogleAuthProvider;
                provider = new GoogleProvider();
                provider.setCustomParameters({ prompt: 'select_account' });
            } else {
                throw new Error('Unknown sign-in provider');
            }
            return auth().signInWithPopup(provider).then(function (result) {
                var user = result.user;
                // Both probes below tolerate a DENIED read: for a first-time
                // Google user those documents don't exist yet, and a read
                // the rules can't evaluate comes back as permission-denied
                // instead of "not found" — that denial must mean "new
                // user", not a failed sign-in.
                return db().collection('accounts').doc(user.uid).get()
                    .then(function (s) { return s; }, function () { return null; })
                    .then(function (accSnap) {
                    // A staff account must never fall through into a patient
                    // session (e.g. a doctor pressing the Google button).
                    if (accSnap && accSnap.exists && accSnap.data().role !== 'patient') {
                        return auth().signOut().then(function () {
                            throw new Error('This is a ' + accSnap.data().role + ' account — please use the ' + accSnap.data().role + ' tab with your username and password.');
                        });
                    }
                    var ref = db().collection('patients').doc(user.uid);
                    return ref.get().then(function (s) { return s; }, function () { return null; }).then(function (snap) {
                        if (snap && snap.exists) {
                            var d = snap.data();
                            return sessionPayload(user, {
                                email: d.email, name: d.name, role: 'patient',
                                profile_complete: !!d.profile_complete
                            });
                        }
                        var name = user.displayName || (user.email ? user.email.split('@')[0] : 'Patient');
                        var batch = db().batch();
                        batch.set(ref, {
                            name: name, email: user.email || '', phone: user.phoneNumber || '',
                            age: null, dob: null, gender: null, address: null, id_type: null, id_number: null,
                            id_document_path: null, profile_complete: false, registration_date: serverTs()
                        });
                        batch.set(db().collection('accounts').doc(user.uid), { role: 'patient', name: name, email: user.email || '' });
                        return batch.commit().then(function () {
                            return sessionPayload(user, {
                                email: user.email || '', name: name, role: 'patient', profile_complete: false
                            });
                        });
                    });
                });
            });
        });
    };

    // ---------- generic helpers (used by DoctorController for off-days) --
    self.get = function (url) {
        return run(function () { return offDaysRequest('GET', url); });
    };
    self.post = function (url, data) {
        return run(function () { return offDaysRequest('POST', url, data); });
    };
    self.del = function (url) {
        return run(function () { return offDaysRequest('DELETE', url); });
    };
    function offDaysRequest(method, url, data) {
        // The old REST URLs are translated to Firestore operations.
        if (url.indexOf('/api/doctor/off-days') !== 0) throw new Error('Unsupported URL: ' + url);
        return requireUser().then(function (user) {
            var col = db().collection('doctorOffDays');
            if (method === 'GET') {
                return col.where('doctor_id', '==', user.uid).get().then(function (qs) {
                    var rows = qs.docs.map(function (s) { return { off_day_id: s.id, off_date: s.data().off_date }; });
                    rows.sort(function (a, b) { return (a.off_date || '') < (b.off_date || '') ? -1 : 1; });
                    return rows;
                });
            }
            if (method === 'POST') {
                var fDate = String((data && data.off_date) || '').substring(0, 10);
                if (!isValidDateStr(fDate)) throw new Error('Invalid date');
                var ref = col.doc(user.uid + '_' + fDate);
                return ref.get().then(function (snap) {
                    if (snap.exists) throw new Error('This date is already marked as an off-day.');
                    return ref.set({ doctor_id: user.uid, off_date: fDate }).then(function () {
                        return { message: 'Off-day added', off_date: fDate };
                    });
                });
            }
            // DELETE /api/doctor/off-days/{off_day_id}
            var id = decodeURIComponent(url.split('/').pop());
            return col.doc(id).get().then(function (snap) {
                if (!snap.exists || snap.data().doctor_id !== user.uid) throw new Error('Off-day not found');
                return snap.ref.delete().then(function () { return { message: 'Off-day removed' }; });
            });
        });
    }

    // ---------- ADMIN ----------
    self.adminStats = function () {
        return run(function () {
            var c = db();
            return Promise.all([
                c.collection('patients').count().get(),
                c.collection('doctors').count().get(),
                c.collection('appointments').count().get(),
                c.collection('reports').count().get().catch(function () { return { data: function () { return { count: 0 }; } }; })
            ]).then(function (r) {
                return {
                    patients: r[0].data().count, doctors: r[1].data().count,
                    appointments: r[2].data().count, reports: r[3].data().count
                };
            });
        });
    };

    function validateDoctorFields(data, passwordRequired) {
        if (!data.name || !String(data.name).trim()) return 'Doctor name is required';
        if (!data.specialization || !String(data.specialization).trim()) return 'Specialization is required';
        if (!data.phone || !REGEX.phone.test(String(data.phone).replace(/[\s-]/g, ''))) return 'Enter a valid 10-digit mobile number';
        if (!data.email || !isValidEmail(data.email)) return 'A valid email is required';
        if (!data.username || !REGEX.username.test(String(data.username).trim())) return 'Username must be 3-20 characters (letters, digits, underscore)';
        if (passwordRequired && (!data.password || !REGEX.password.test(String(data.password)))) return 'Password must be at least 8 characters with at least one letter and one number';
        return null;
    }

    // Creating an Auth user from the admin's browser would sign the admin
    // out on the main app instance — use a throwaway secondary app.
    function createAuthUserAsAdmin(email, password) {
        var secondary;
        try { secondary = fb().app('hh-secondary'); }
        catch (e) { secondary = fb().initializeApp(window.HEALTHHUB_FIREBASE_CONFIG, 'hh-secondary'); }
        return secondary.auth().createUserWithEmailAndPassword(email, password).then(function (cred) {
            var uid = cred.user.uid;
            return secondary.auth().signOut().then(function () { return uid; });
        });
    }

    self.createDoctor = function (data) {
        return run(function () {
            var invalid = validateDoctorFields(data, true);
            if (invalid) throw new Error(invalid);
            var email = String(data.email).trim().toLowerCase();
            var username = String(data.username).trim().toLowerCase();
            return db().collection('usernames').doc(username).get().then(function (existing) {
                if (existing.exists) throw new Error('Username or email already exists');
                return createAuthUserAsAdmin(email, data.password).then(function (uid) {
                    var batch = db().batch();
                    batch.set(db().collection('doctors').doc(uid), {
                        name: String(data.name).trim(), specialization: String(data.specialization).trim(),
                        phone: String(data.phone).trim(), email: email, username: username,
                        location_name: data.location_name || null, location_address: data.location_address || null,
                        age: data.age ? Number(data.age) : null,
                        experience_years: data.experience_years ? Number(data.experience_years) : null,
                        is_banned: false, created_at: serverTs()
                    });
                    batch.set(db().collection('accounts').doc(uid), { role: 'doctor', name: String(data.name).trim(), email: email, username: username });
                    batch.set(db().collection('usernames').doc(username), { email: email, role: 'doctor', uid: uid });
                    return batch.commit().then(function () { return { message: 'Doctor created successfully' }; });
                });
            });
        });
    };

    self.updateDoctor = function (id, data) {
        return run(function () {
            var invalid = validateDoctorFields(data, false);
            if (invalid) throw new Error(invalid);
            if (data.password) {
                // A browser client cannot change ANOTHER user's Auth password.
                throw new Error('Doctor passwords are reset from the Firebase console (Authentication → Users → Reset password). Leave the password field blank to save other changes.');
            }
            var ref = db().collection('doctors').doc(id);
            return ref.get().then(function (snap) {
                if (!snap.exists) throw new Error('Doctor not found');
                var old = snap.data();
                var updates = {
                    name: String(data.name).trim(), specialization: String(data.specialization).trim(),
                    phone: String(data.phone).trim(), email: String(data.email).trim().toLowerCase(),
                    username: String(data.username).trim().toLowerCase(),
                    location_name: data.location_name || null, location_address: data.location_address || null,
                    age: data.age ? Number(data.age) : null,
                    experience_years: data.experience_years ? Number(data.experience_years) : null
                };
                var batch = db().batch();
                batch.update(ref, updates);
                batch.update(db().collection('accounts').doc(id), { name: updates.name, email: updates.email, username: updates.username });
                if (old.username !== updates.username) {
                    batch.delete(db().collection('usernames').doc(old.username));
                    batch.set(db().collection('usernames').doc(updates.username), { email: updates.email, role: 'doctor', uid: id });
                } else if (old.email !== updates.email) {
                    batch.update(db().collection('usernames').doc(updates.username), { email: updates.email });
                }
                return batch.commit().then(function () { return { message: 'Doctor updated successfully' }; });
            });
        });
    };

    self.getDoctors = function () {
        return run(function () {
            return db().collection('doctors').orderBy('created_at', 'desc').get()
                .then(function (qs) { return qs.docs.map(mapDoctor); });
        });
    };

    self.banDoctor = function (id, isBanned) {
        return run(function () {
            return db().collection('doctors').doc(id).update({ is_banned: !!isBanned })
                .then(function () { return { message: 'Doctor ban status updated' }; });
        });
    };

    self.getAdminPatients = function (q) {
        return run(function () {
            return db().collection('patients').orderBy('registration_date', 'desc').get().then(function (qs) {
                var rows = qs.docs.map(mapPatient);
                var needle = String(q || '').trim().toLowerCase();
                if (needle) {
                    rows = rows.filter(function (p) {
                        return String(p.name || '').toLowerCase().indexOf(needle) >= 0 || String(p.email || '').toLowerCase().indexOf(needle) >= 0;
                    });
                }
                return rows;
            });
        });
    };

    self.getAdminAppointments = function () {
        return run(function () {
            return db().collection('appointments').orderBy('created_at', 'desc').get()
                .then(function (qs) { return qs.docs.map(mapAppointment); });
        });
    };

    self.getAdminReports = function () {
        return run(function () {
            return db().collection('reports').orderBy('upload_date', 'desc').get()
                .then(function (qs) { return qs.docs.map(mapReport); });
        });
    };

    self.getAdminDoctorOffDays = function (doctorId) {
        return run(function () {
            var q = db().collection('doctorOffDays');
            if (doctorId) q = q.where('doctor_id', '==', doctorId);
            return q.get().then(function (qs) {
                return db().collection('doctors').get().then(function (docs) {
                    var byId = {};
                    docs.forEach(function (s) { byId[s.id] = s.data(); });
                    var rows = qs.docs.map(function (s) {
                        var d = s.data(), doc = byId[d.doctor_id] || {};
                        return {
                            off_day_id: s.id, off_date: d.off_date, doctor_id: d.doctor_id,
                            doctor_name: doc.name || '', specialization: doc.specialization || ''
                        };
                    });
                    rows.sort(function (a, b) { return (a.off_date || '') < (b.off_date || '') ? -1 : 1; });
                    return rows;
                });
            });
        });
    };

    // Cascades (Firestore has none built in — the MySQL version relied on
    // ON DELETE CASCADE + file cleanup, both replicated here).
    function deleteAppointmentCascade(apptSnap) {
        var d = apptSnap.data();
        var jobs = [];
        jobs.push(db().collection('reports').where('appointment_id', '==', apptSnap.id).get().catch(function () { return { docs: [] }; }).then(function (qs) {
            return Promise.all(qs.docs.map(function (r) {
                return deleteFileQuiet(r.data().file_path).then(function () { return r.ref.delete(); });
            }));
        }));
        jobs.push(db().collection('slotLocks').doc(lockIdFor(d.doctor_id, d.appointment_date, d.appointment_time)).delete().catch(function () { }));
        return Promise.all(jobs).then(function () { return apptSnap.ref.delete(); });
    }
    function lockIdFor(doctorId, date, time) { return doctorId + '_' + date + '_' + time; }

    self.adminDelete = function (resource, id) {
        return run(function () {
            if (resource === 'reports') {
                var rref = db().collection('reports').doc(id);
                return rref.get().then(function (snap) {
                    if (!snap.exists) throw new Error('Report not found');
                    return deleteFileQuiet(snap.data().file_path).then(function () { return rref.delete(); })
                        .then(function () { return { message: 'Report deleted' }; });
                });
            }
            if (resource === 'appointments') {
                var aref = db().collection('appointments').doc(id);
                return aref.get().then(function (snap) {
                    if (!snap.exists) throw new Error('Appointment not found');
                    return deleteAppointmentCascade(snap).then(function () { return { message: 'Appointment deleted' }; });
                });
            }
            if (resource === 'patients') {
                var pref = db().collection('patients').doc(id);
                return pref.get().then(function (snap) {
                    if (!snap.exists) throw new Error('Patient not found');
                    var pdata = snap.data();
                    return db().collection('appointments').where('patient_id', '==', id).get().then(function (qs) {
                        return Promise.all(qs.docs.map(deleteAppointmentCascade));
                    }).then(function () {
                        return db().collection('reports').where('patient_id', '==', id).get().catch(function () { return { docs: [] }; });
                    }).then(function (qs) {
                        return Promise.all(qs.docs.map(function (r) {
                            return deleteFileQuiet(r.data().file_path).then(function () { return r.ref.delete(); });
                        }));
                    }).then(function () {
                        return deleteFileQuiet(pdata.id_document_path);
                    }).then(function () {
                        var batch = db().batch();
                        batch.delete(pref);
                        batch.delete(db().collection('accounts').doc(id));
                        return batch.commit();
                    }).then(function () { return { message: 'Patient deleted' }; });
                });
            }
            if (resource === 'doctors') {
                var dref = db().collection('doctors').doc(id);
                return dref.get().then(function (snap) {
                    if (!snap.exists) throw new Error('Doctor not found');
                    var ddata = snap.data();
                    return db().collection('appointments').where('doctor_id', '==', id).get().then(function (qs) {
                        return Promise.all(qs.docs.map(deleteAppointmentCascade));
                    }).then(function () {
                        return db().collection('doctorOffDays').where('doctor_id', '==', id).get();
                    }).then(function (qs) {
                        var batch = db().batch();
                        qs.forEach(function (s) { batch.delete(s.ref); });
                        batch.delete(dref);
                        batch.delete(db().collection('accounts').doc(id));
                        if (ddata.username) batch.delete(db().collection('usernames').doc(ddata.username));
                        return batch.commit();
                    }).then(function () {
                        // Note: the doctor's Firebase Auth login itself can only be
                        // removed from the console (Authentication → Users).
                        return { message: 'Doctor deleted' };
                    });
                });
            }
            throw new Error('Unknown resource: ' + resource);
        });
    };

    // ---------- DOCTOR ----------
    self.doctorAppointments = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('appointments')
                    .where('doctor_id', '==', user.uid).get()
                    .then(function (qs) {
                        var rows = qs.docs.map(mapAppointment);
                        rows.sort(function (a, b) {
                            var ka = (a.appointment_date || '') + ' ' + (a.appointment_time || '');
                            var kb = (b.appointment_date || '') + ' ' + (b.appointment_time || '');
                            return ka < kb ? -1 : 1;
                        });
                        return rows;
                    });
            });
        });
    };

    self.doctorAppointment = function (id) {
        return run(function () {
            return requireUser().then(function (user) {
                var ref = db().collection('appointments').doc(id);
                return ref.get().then(function (snap) {
                    if (!snap.exists || snap.data().doctor_id !== user.uid) throw new Error('Appointment not found');
                    var row = mapAppointment(snap);
                    return db().collection('reports')
                        .where('doctor_id', '==', user.uid).where('appointment_id', '==', id).limit(1).get()
                        .then(function (qs) {
                            row.has_report = !qs.empty;
                            return row;
                        });
                });
            });
        });
    };

    self.updateApptStatus = function (id, status) {
        return run(function () {
            if (['Completed', 'Cancelled'].indexOf(status) < 0) throw new Error('Invalid status. Doctor can only set Completed or Cancelled.');
            return requireUser().then(function (user) {
                var ref = db().collection('appointments').doc(id);
                return ref.get().then(function (snap) {
                    if (!snap.exists || snap.data().doctor_id !== user.uid) throw new Error('Appointment not found');
                    var cur = snap.data().status;
                    if (cur === 'Completed') throw new Error('Appointment is already completed and cannot be changed.');
                    if (cur === 'Cancelled') throw new Error('Appointment is already cancelled and cannot be changed.');
                    var batch = db().batch();
                    batch.update(ref, { status: status });
                    if (status === 'Cancelled') {
                        var d = snap.data();
                        batch.delete(db().collection('slotLocks').doc(lockIdFor(d.doctor_id, d.appointment_date, d.appointment_time)));
                    }
                    var dd = snap.data();
                    return batch.commit().then(function () {
                        notify(dd.patient_id, 'status', 'Appointment ' + status.toLowerCase(),
                            'Your appointment with ' + (dd.doctor_name || 'your doctor') + ' on ' + dd.appointment_date + ' at ' + dd.appointment_time + ' is now ' + status + '.');
                        return { message: 'Status updated' };
                    });
                });
            });
        });
    };

    function saveTreatment(appointmentId, data, mustExist) {
        return requireUser().then(function (user) {
            var ref = db().collection('appointments').doc(appointmentId);
            return ref.get().then(function (snap) {
                if (!snap.exists || snap.data().doctor_id !== user.uid) throw new Error('Access denied');
                var st = snap.data().status;
                if (st === 'Completed') throw new Error('Cannot modify a completed appointment');
                if (st === 'Cancelled') throw new Error('Cannot modify a cancelled appointment');
                if (mustExist && !snap.data().treatment) throw new Error('Treatment record not found');
                if (data.payment_status && ['Unpaid', 'Paid'].indexOf(data.payment_status) < 0) throw new Error('Invalid payment status');
                if (data.treatment_cost != null && data.treatment_cost !== '' && (isNaN(Number(data.treatment_cost)) || Number(data.treatment_cost) < 0)) throw new Error('Treatment cost must be a non-negative number');
                var treatment = {
                    diagnosis: data.diagnosis || null, prescription: data.prescription || null,
                    treatment_notes: data.treatment_notes || null,
                    treatment_cost: data.treatment_cost ? Number(data.treatment_cost) : 0,
                    payment_status: data.payment_status || 'Unpaid'
                };
                return ref.update({ treatment: treatment }).then(function () { return { message: 'Treatment record saved' }; });
            });
        });
    }
    self.createTreatment = function (data) {
        return run(function () {
            if (!data.appointment_id) throw new Error('appointment_id is required');
            return saveTreatment(data.appointment_id, data, false);
        });
    };
    self.updateTreatment = function (id, data) {
        // In this data model treatment_id == the appointment's id (the
        // treatment is embedded in the appointment document).
        return run(function () { return saveTreatment(id, data, true); });
    };

    self.uploadReport = function (fd) {
        return run(function () {
            return requireUser().then(function (user) {
                var file = fd.get('report_file');
                var patientId = fd.get('patient_id');
                var appointmentId = fd.get('appointment_id');
                var reportType = fd.get('report_type') || 'General';
                if (!file) throw new Error('No file uploaded');
                if (!appointmentId) throw new Error('appointment_id is required');
                if (!patientId) throw new Error('patient_id is required');
                var apptRef = db().collection('appointments').doc(String(appointmentId));
                return apptRef.get().then(function (snap) {
                    if (!snap.exists || snap.data().doctor_id !== user.uid) throw new Error('Access denied: this is not your appointment');
                    var appt = snap.data();
                    if (String(patientId) !== appt.patient_id) throw new Error('patient_id does not match the appointment');
                    if (appt.status === 'Completed') throw new Error('Cannot upload reports to a completed appointment');
                    if (appt.status === 'Cancelled') throw new Error('Cannot upload reports to a cancelled appointment');
                    return db().collection('reports')
                        .where('doctor_id', '==', user.uid).where('appointment_id', '==', String(appointmentId)).limit(1).get()
                        .then(function (qs) {
                            if (!qs.empty) throw new Error('A report has already been submitted for this appointment and cannot be changed.');
                            return storeFile(appt.patient_id, 'report', file).then(function (fileId) {
                                return db().collection('reports').add({
                                    patient_id: appt.patient_id, patient_name: appt.patient_name,
                                    appointment_id: String(appointmentId),
                                    doctor_id: user.uid, doctor_name: appt.doctor_name,
                                    appointment_date: appt.appointment_date,
                                    external_doctor_name: null, report_type: reportType, uploaded_by: 'doctor',
                                    file_path: fileId, upload_date: serverTs()
                                }).then(function () {
                                    notify(appt.patient_id, 'report', 'New report from your doctor',
                                        (appt.doctor_name || 'Your doctor') + ' uploaded a report (' + reportType + ') for your appointment on ' + appt.appointment_date + '.');
                                    return { message: 'Report uploaded successfully', file_path: fileId };
                                });
                            });
                        });
                });
            });
        });
    };

    self.patientHistory = function (patientId) {
        return run(function () {
            return requireUser().then(function (user) {
                var apptCol = db().collection('appointments');
                return apptCol.where('patient_id', '==', patientId).where('doctor_id', '==', user.uid).get()
                    .then(function (allAppts) {
                        var mine = allAppts.docs;
                        if (!mine.length) throw new Error('No access to this patient history');
                        mine.sort(function (a, b) { return (b.data().appointment_date || '') < (a.data().appointment_date || '') ? -1 : 1; });
                        return db().collection('reports').where('doctor_id', '==', user.uid).where('patient_id', '==', patientId).get()
                        .then(function (repQs) {
                            var repDocs = repQs.docs;
                            repDocs.sort(function (a, b) {
                                var ta = a.data().upload_date, tb = b.data().upload_date;
                                var sa = ta && ta.toDate ? ta.toDate().getTime() : 0, sb = tb && tb.toDate ? tb.toDate().getTime() : 0;
                                return sb - sa;
                            });
                            var r = [{ docs: mine }, { docs: repDocs }];
                            var appointments = r[0].docs.map(mapAppointment);
                            var latest = appointments[0] || {};
                            return {
                                patient: {
                                    name: latest.patient_name || '', age: latest.age || null,
                                    gender: latest.gender || null, phone: latest.patient_phone || '',
                                    address: latest.address || ''
                                },
                                appointments: appointments,
                                reports: r[1].docs.map(mapReport)
                            };
                        });
                    });
            });
        });
    };

    // ---------- PATIENT ----------
    self.patientProfile = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('patients').doc(user.uid).get().then(function (snap) {
                    return snap.exists ? mapPatient(snap) : {};
                });
            });
        });
    };

    self.patientCompleteProfile = function (fd) {
        return run(function () {
            return requireUser().then(function (user) {
                var age = fd.get('age'), gender = fd.get('gender'), address = fd.get('address'),
                    idType = fd.get('id_type'), idNumber = fd.get('id_number'), file = fd.get('id_document');
                var dob = fd.get('dob') ? String(fd.get('dob')).substring(0, 10) : null;
                if (!gender || !address || !idType || !idNumber) throw new Error('All profile fields are required');
                // Age is DERIVED from the date of birth whenever one is
                // supplied — the client's age field is never trusted.
                var ageNum;
                if (dob) {
                    if (!isValidDateStr(dob)) throw new Error('Invalid date of birth');
                    if (dob >= toYMD(new Date())) throw new Error('Date of birth must be in the past');
                    var p = dob.split('-').map(Number);
                    var now = new Date();
                    ageNum = now.getFullYear() - p[0];
                    var mDiff = (now.getMonth() + 1) - p[1];
                    if (mDiff < 0 || (mDiff === 0 && now.getDate() < p[2])) ageNum--;
                    if (ageNum < 1 || ageNum > 120) throw new Error('Date of birth gives an age outside 1-120 years');
                } else {
                    if (!age) throw new Error('All profile fields are required');
                    ageNum = Number(age);
                    if (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) throw new Error('Age must be a whole number between 1 and 120');
                }
                if (GENDERS.indexOf(gender) < 0) throw new Error('Invalid gender');
                if (ID_TYPES.indexOf(idType) < 0) throw new Error('Invalid ID type');
                if (!REGEX.idNumber[idType].test(String(idNumber).trim())) {
                    throw new Error(idType === 'Aadhar' ? 'Aadhar number must be 12 digits' :
                        idType === 'Passport' ? 'Passport number must be 1 letter followed by 7 digits' :
                        'Voter ID must be 3 letters followed by 7 digits');
                }
                var ref = db().collection('patients').doc(user.uid);
                return ref.get().then(function (snap) {
                    var oldPath = snap.exists ? snap.data().id_document_path : null;
                    if (!file && !oldPath) throw new Error('An ID document upload is required to complete your profile');
                    function save(path) {
                        var updates = {
                            age: ageNum, gender: gender, address: address,
                            id_type: idType, id_number: idNumber, profile_complete: true
                        };
                        if (dob) updates.dob = dob;
                        if (path) updates.id_document_path = path;
                        return ref.update(updates).then(function () {
                            if (path && oldPath && oldPath !== path) deleteFileQuiet(oldPath);
                            return { message: 'Profile completed successfully', profile_complete: true };
                        });
                    }
                    if (file) {
                        return storeFile(user.uid, 'id_document', file).then(function (fileId) { return save(fileId); });
                    }
                    return save(null);
                });
            });
        });
    };

    // Change own mobile number (Profile card → Phone → Change). Validated
    // with the same REGEX.phone used at registration. Existing appointments
    // keep the phone snapshot taken when they were booked.
    self.patientChangePhone = function (newPhone) {
        return run(function () {
            // requireUser() — NOT authReady's raw value: authReady resolves
            // with the FIRST auth-state callback, which is null on a fresh
            // page load while the session restores (that was the
            // "Cannot read properties of null (reading 'uid')" toast).
            return requireUser().then(function (user) {
                var phone = String(newPhone == null ? '' : newPhone).trim();
                if (!REGEX.phone.test(phone.replace(/[\s-]/g, ''))) {
                    throw new Error('Enter a valid 10-digit mobile number');
                }
                return db().collection('patients').doc(user.uid)
                    .update({ phone: phone })
                    .then(function () { return { data: { phone: phone } }; });
            });
        });
    };

    self.patientAppointments = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('appointments')
                    .where('patient_id', '==', user.uid).get()
                    .then(function (qs) {
                        var rows = qs.docs.map(mapAppointment);
                        rows.sort(function (a, b) {
                            var ka = (a.appointment_date || '') + ' ' + (a.appointment_time || '');
                            var kb = (b.appointment_date || '') + ' ' + (b.appointment_time || '');
                            return ka > kb ? -1 : 1;
                        });
                        return rows;
                    });
            });
        });
    };

    self.bookAppointment = function (data) {
        return run(function () {
            return requireUser().then(function (user) {
                var doctorId = data.doctor_id, fDate = String(data.appointment_date || '').substring(0, 10),
                    fTime = data.appointment_time;
                if (!doctorId || !fDate || !fTime) throw new Error('Doctor, date, and time slot are required');
                if (!isValidDateStr(fDate)) throw new Error('Invalid appointment date');
                if (!isValidSlotTime(fTime)) throw new Error('Please choose a valid time slot (10-minute slots, 10 AM–1 PM or 6 PM–10 PM).');
                fTime = fTime.length === 5 ? fTime + ':00' : fTime;
                var today = toYMD(new Date());
                if (fDate < today) throw new Error('Cannot book an appointment in the past.');
                if (fDate > addDaysYMD(today, MAX_BOOKING_DAYS_AHEAD)) throw new Error('Appointments can be booked at most ' + MAX_BOOKING_DAYS_AHEAD + ' days ahead.');
                if (dayOfWeekUTC(fDate) === 3) throw new Error('Appointments are not available on Wednesdays (universal off-day).');

                var database = db();
                var apptRef = database.collection('appointments').doc();
                var lockRef = database.collection('slotLocks').doc(lockIdFor(doctorId, fDate, fTime));
                return database.collection('patients').doc(user.uid).get().then(function (pSnap) {
                    if (!pSnap.exists || !pSnap.data().profile_complete) throw new Error('PROFILE_INCOMPLETE');
                    var patient = pSnap.data();
                    var doctorData = null;
                    // Capacity + same-time clash checks run as plain queries
                    // BEFORE the transaction: handing Query objects to
                    // tx.get() is what threw "Expected type 'Ju', but it
                    // was: a custom Yu object" and blocked every booking.
                    // The transaction itself only touches document
                    // references, and the exact-slot lock is still created
                    // atomically inside it — a slot can never double-book.
                    var hourQ = database.collection('slotLocks')
                        .where('doctor_id', '==', doctorId).where('appointment_date', '==', fDate)
                        .where('slot_hour', '==', fTime.substring(0, 2));
                    var clashQ = database.collection('slotLocks')
                        .where('patient_id', '==', user.uid).where('appointment_date', '==', fDate)
                        .where('appointment_time', '==', fTime);
                    return hourQ.get().then(function (hourSnap) {
                        if (hourSnap.size >= 6) throw new Error('This time slot is fully booked. Please choose another slot.');
                        return clashQ.get();
                    }).then(function (clashSnap) {
                        if (!clashSnap.empty) throw new Error('You already have an appointment at this time.');
                        return database.runTransaction(function (tx) {
                            var doctorRef = database.collection('doctors').doc(doctorId);
                            var offRef = database.collection('doctorOffDays').doc(doctorId + '_' + fDate);
                            return tx.get(lockRef).then(function (lockSnap) {
                                if (lockSnap.exists) throw new Error('This time slot has just been booked. Please choose another slot.');
                                return tx.get(doctorRef);
                            }).then(function (docSnap) {
                                if (!docSnap.exists) throw new Error('Doctor not found');
                                doctorData = docSnap.data();
                                if (doctorData.is_banned) throw new Error('This doctor is not available for booking.');
                                return tx.get(offRef);
                            }).then(function (offSnap) {
                                if (offSnap.exists) throw new Error('The doctor is not available on this date (off-day).');
                                tx.set(apptRef, {
                                    patient_id: user.uid, patient_name: patient.name,
                                    patient_age: patient.age || null, patient_gender: patient.gender || null,
                                    patient_phone: patient.phone || null, patient_address: patient.address || null,
                                    doctor_id: doctorId, doctor_name: doctorData.name, specialization: doctorData.specialization,
                                    doctor_phone: doctorData.phone || null,
                                    appointment_date: fDate, appointment_time: fTime,
                                    slot_hour: fTime.substring(0, 2), status: 'Pending',
                                    treatment: null, created_at: serverTs()
                                });
                                tx.set(lockRef, {
                                    appointment_id: apptRef.id, patient_id: user.uid, doctor_id: doctorId,
                                    appointment_date: fDate, appointment_time: fTime, slot_hour: fTime.substring(0, 2)
                                });
                            });
                        });
                    }).then(function () {
                        notify(doctorId, 'appointment', 'New appointment booked',
                            patient.name + ' booked an appointment on ' + fDate + ' at ' + fTime + '.');
                        notify(user.uid, 'appointment', 'Appointment booked',
                            'Your appointment with ' + (doctorData ? doctorData.name : 'the doctor') + ' on ' + fDate + ' at ' + fTime + ' is booked (status: Pending).');
                        return { message: 'Appointment booked successfully', appointment_id: apptRef.id };
                    });
                });
            });
        });
    };
    self.getPatientDoctors = function (spec) {
        return run(function () {
            return db().collection('doctors').orderBy('name').get().then(function (qs) {
                var rows = qs.docs.map(mapDoctor).filter(function (d) { return !d.is_banned; });
                if (spec && spec !== 'All') rows = rows.filter(function (d) { return d.specialization === spec; });
                return rows;
            });
        });
    };

    self.getSpecializations = function () {
        return run(function () {
            return db().collection('doctors').get().then(function (qs) {
                var seen = {};
                qs.forEach(function (s) { if (!s.data().is_banned) seen[s.data().specialization] = true; });
                return Object.keys(seen).sort();
            });
        });
    };

    self.getDoctorSlots = function (doctorId, date) {
        return run(function () {
            var fDate = String(date || '').substring(0, 10);
            if (!fDate) throw new Error('Date is required');
            if (!isValidDateStr(fDate)) throw new Error('Invalid date');
            return db().collection('doctors').doc(doctorId).get().then(function (docSnap) {
                if (!docSnap.exists) throw new Error('Doctor not found');
                if (docSnap.data().is_banned) return { off_day: true, reason: 'doctor_unavailable', slots: [] };
                if (dayOfWeekUTC(fDate) === 3) return { off_day: true, reason: 'wednesday', slots: [] };
                return db().collection('doctorOffDays').doc(doctorId + '_' + fDate).get().then(function (offSnap) {
                    if (offSnap.exists) return { off_day: true, reason: 'doctor_leave', slots: [] };
                    return db().collection('slotLocks')
                        .where('doctor_id', '==', doctorId).where('appointment_date', '==', fDate).get()
                        .then(function (qs) {
                            var bookedMap = {}, hourCount = {};
                            qs.forEach(function (s) {
                                var t = s.data().appointment_time;
                                bookedMap[t] = (bookedMap[t] || 0) + 1;
                                var hr = String(t).substring(0, 2);
                                hourCount[hr] = (hourCount[hr] || 0) + 1;
                            });
                            var slots = generateSlots().map(function (slot) {
                                var hr = slot.substring(0, 2);
                                return { time: slot, available: (bookedMap[slot] || 0) === 0 && (hourCount[hr] || 0) < 6 };
                            });
                            return { off_day: false, slots: slots };
                        });
                });
            });
        });
    };

    self.patientReports = function () {
        return run(function () {
            return requireUser().then(function (user) {
                return db().collection('reports')
                    .where('patient_id', '==', user.uid).get()
                    .then(function (qs) {
                        var rows = qs.docs.map(mapReport);
                        rows.sort(function (a, b) { return (b.upload_date || '') < (a.upload_date || '') ? -1 : 1; });
                        return rows;
                    });
            });
        });
    };

    self.patientUploadReport = function (fd) {
        return run(function () {
            return requireUser().then(function (user) {
                var reportType = fd.get('report_type');
                var appointmentId = fd.get('appointment_id');
                var externalName = fd.get('external_doctor_name');
                var file = fd.get('report_file');
                if (!reportType || (!appointmentId && !externalName)) throw new Error('Report type and doctor details are required');
                if (!file) throw new Error('Report file is required');

                function save(appt) {
                    return storeFile(user.uid, 'report', file).then(function (fileId) {
                        return db().collection('patients').doc(user.uid).get().then(function (pSnap) {
                            return db().collection('reports').add({
                                patient_id: user.uid, patient_name: pSnap.exists ? pSnap.data().name : '',
                                appointment_id: appt ? String(appointmentId) : null,
                                doctor_id: appt ? appt.doctor_id : null,
                                doctor_name: appt ? appt.doctor_name : null,
                                appointment_date: appt ? appt.appointment_date : null,
                                external_doctor_name: appt ? null : (externalName || null),
                                report_type: reportType, uploaded_by: 'patient', file_path: fileId, upload_date: serverTs()
                            });
                        });
                    }).then(function () {
                        if (appt) {
                            notify(appt.doctor_id, 'report', 'Report submitted',
                                'A patient submitted a report (' + reportType + ') for the appointment on ' + appt.appointment_date + '.');
                        }
                        return { message: 'Report uploaded successfully' };
                    });
                }

                if (appointmentId && appointmentId !== 'other') {
                    return db().collection('appointments').doc(String(appointmentId)).get().then(function (snap) {
                        if (!snap.exists || snap.data().patient_id !== user.uid) throw new Error('Invalid appointment ID');
                        var appt = snap.data();
                        if (appt.status !== 'Completed') throw new Error('Reports can only be attached to a completed appointment');
                        return db().collection('reports')
                            .where('patient_id', '==', user.uid).where('appointment_id', '==', String(appointmentId)).limit(1).get()
                            .then(function (qs) {
                                if (!qs.empty) throw new Error('A report has already been submitted for this appointment.');
                                return save(appt);
                            });
                    });
                }
                return save(null);
            });
        });
    };

    // ---------- file opening ----------
    // The file document is fetched under the caller's identity, so the
    // firestore.rules decide access; the bytes are decoded locally into a
    // Blob URL and opened. (There is no public link to a stored file —
    // that was one of the original security bugs.)
    self.downloadFile = function (fileId) {
        return run(function () {
            return db().collection('files').doc(fileId).get().then(function (snap) {
                if (!snap.exists) throw new Error('File not found');
                var d = snap.data();
                return URL.createObjectURL(base64ToBlob(d.data_base64, d.content_type));
            });
        });
    };
    self.openFile = function (fileId) {
        return self.downloadFile(fileId).then(function (r) {
            window.open(r.data, '_blank');
        }).catch(function () {
            if (window.HHToast) HHToast.error('Could not open this file.');
        });
    };
}]);
