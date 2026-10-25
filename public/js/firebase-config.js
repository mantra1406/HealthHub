// ============================================================
// Firebase project configuration — FILL THIS IN.
// Firebase console → Project settings → "Your apps" → Web app.
// These values are NOT secret (they identify the project; security
// comes from firestore.rules), and this exact config
// block is what the console shows you to copy into your web app.
// ============================================================
window.HEALTHHUB_FIREBASE_CONFIG = {
    apiKey: "AIzaSyCEt2B7aONCCG0ExMNHUXxY5mSFe4oo17A",
    authDomain: "health-hub-18677.firebaseapp.com",
    projectId: "health-hub-18677",
    storageBucket: "health-hub-18677.firebasestorage.app",
    messagingSenderId: "73219267997",
    appId: "1:73219267997:web:5f4d706e9d3198bfc1a374",
    measurementId: "G-XXTJC3XHFP"
};

(function () {
    var cfg = window.HEALTHHUB_FIREBASE_CONFIG;
    if (!cfg.apiKey || cfg.apiKey.indexOf('YOUR_') === 0) {
        window.HEALTHHUB_FIREBASE_READY = false;
        console.error('[HealthHub] Firebase is not configured yet — fill in public/js/firebase-config.js (see README, "Firebase setup").');
        return;
    }
    firebase.initializeApp(cfg);
    window.HEALTHHUB_FIREBASE_READY = true;
    // NOTE: no setPersistence() call — LOCAL persistence is already the
    // Firebase Auth default, and explicitly setting it via the compat
    // enum throws "Class constructor ... cannot be invoked without
    // 'new'" in the 10.x compat build, which broke every sign-in
    // (email, Google and Apple alike).
})();
