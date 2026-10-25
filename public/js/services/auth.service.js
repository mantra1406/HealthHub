// HealthHub Auth Service
angular.module('healthhubApp').service('AuthService', function () {
    var self = this;

    self.setSession = function (data) {
        localStorage.setItem('hh_token', data.token);
        localStorage.setItem('hh_role', data.role);
        localStorage.setItem('hh_name', data.name || data.username || '');
        localStorage.setItem('hh_username', data.username || data.email || '');
        localStorage.setItem('hh_email', data.email || '');
        if (typeof data.profile_complete !== 'undefined') {
            localStorage.setItem('hh_profile_complete', data.profile_complete ? '1' : '0');
        }
    };

    self.getToken = function () { return localStorage.getItem('hh_token'); };
    self.getRole = function () { return localStorage.getItem('hh_role'); };
    self.getName = function () { return localStorage.getItem('hh_name'); };
    self.getUsername = function () { return localStorage.getItem('hh_username'); };
    self.getEmail = function () { return localStorage.getItem('hh_email'); };
    self.isLoggedIn = function () { return !!self.getToken(); };

    self.logout = function () {
        ['hh_token', 'hh_role', 'hh_name', 'hh_username', 'hh_email', 'hh_profile_complete'].forEach(function (k) {
            localStorage.removeItem(k);
        });
        // Also end the Firebase Auth session itself (localStorage alone
        // would leave the user still signed in to Firebase).
        try {
            if (window.HEALTHHUB_FIREBASE_READY) window.firebase.auth().signOut();
        } catch (e) { /* already signed out */ }
    };

    self.getAvatarLetter = function () {
        var name = self.getName() || 'U';
        return name.charAt(0).toUpperCase();
    };


});
