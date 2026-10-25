// Auth Controller — HealthHub
angular.module('healthhubApp').controller('AuthController', [
    '$scope', '$location', 'AuthService', 'ApiService',
    function ($scope, $location, AuthService, ApiService) {
        // If already logged in, redirect to the correct dashboard
        if (AuthService.isLoggedIn()) {
            var role = AuthService.getRole();
            window.location.href = '/#/' + role + '/dashboard';
            return;
        }

        $scope.activeTab = 'patient';
        $scope.loginData = {};
        $scope.loading = false;
        $scope.error = '';

        $scope.setTab = function (tab) {
            $scope.activeTab = tab;
            $scope.error = '';
            $scope.loginData = {};
            $scope.forgot = { open: false, identifier: '', sending: false, msg: '' };
        };

        // Forgot password (all tabs; patients by email, staff by username)
        $scope.forgot = { open: false, identifier: '', sending: false, msg: '' };
        $scope.sendForgot = function () {
            if (!$scope.forgot.identifier) return;
            $scope.forgot.sending = true;
            $scope.forgot.msg = '';
            ApiService.forgotPassword($scope.forgot.identifier, $scope.activeTab).then(function (resp) {
                $scope.forgot.msg = resp.data.message;
                $scope.forgot.identifier = '';
            }).catch(function (err) {
                $scope.error = (err.data && err.data.error) || 'Could not start the reset. Please try again.';
            }).finally(function () { $scope.forgot.sending = false; });
        };

        $scope.login = function () {
            $scope.loading = true;
            $scope.error = '';
            var loginFn;

            if ($scope.activeTab === 'admin') loginFn = ApiService.adminLogin($scope.loginData);
            else if ($scope.activeTab === 'doctor') loginFn = ApiService.doctorLogin($scope.loginData);
            else loginFn = ApiService.patientLogin($scope.loginData);

            loginFn.then(function (resp) {
                AuthService.setSession(resp.data);
                HHToast.success('Welcome back, ' + (resp.data.name || resp.data.username) + '!');
                // Use window.location.href so this works from both login.html and views/login.html (inside index.html)
                setTimeout(function () {
                    window.location.href = '/#/' + resp.data.role + '/dashboard';
                }, 600);
            }).catch(function (err) {
                $scope.error = (err.data && err.data.error) || 'Login failed. Please try again.';
            }).finally(function () {
                $scope.loading = false;
            });
        };

        // Google popup sign-in (patient tab only)
        $scope.socialLogin = function (provider) {
            $scope.loading = true;
            $scope.error = '';
            ApiService.patientSocialLogin(provider).then(function (resp) {
                AuthService.setSession(resp.data);
                HHToast.success('Welcome, ' + (resp.data.name || 'Patient') + '!');
                if (!resp.data.profile_complete) {
                    setTimeout(function () { HHToast.info('Please complete your profile to book appointments.'); }, 700);
                }
                setTimeout(function () {
                    window.location.href = '/#/patient/dashboard';
                }, 600);
            }).catch(function (err) {
                $scope.error = (err.data && err.data.error) || 'Social sign-in failed. Please try again.';
            }).finally(function () {
                $scope.loading = false;
            });
        };
    }
]);

// Register Controller — 4-field quick registration, then auto-login
angular.module('healthhubApp').controller('RegisterController', [
    '$scope', '$location', 'AuthService', 'ApiService',
    function ($scope, $location, AuthService, ApiService) {
        $scope.form = {};
        $scope.loading = false;
        $scope.error = '';

        // Google sign-up: same popup flow as the login page — a Google
        // account is created (or reused) and the session starts at once.
        $scope.socialLogin = function (provider) {
            $scope.loading = true;
            $scope.error = '';
            ApiService.patientSocialLogin(provider).then(function (resp) {
                AuthService.setSession(resp.data);
                HHToast.success('Welcome, ' + (resp.data.name || 'Patient') + '!');
                if (!resp.data.profile_complete) {
                    setTimeout(function () { HHToast.info('Please complete your profile to book appointments.'); }, 700);
                }
                setTimeout(function () {
                    window.location.href = '/#/patient/dashboard';
                }, 600);
            }).catch(function (err) {
                $scope.error = (err.data && err.data.error) || 'Google sign-up failed. Please try again.';
            }).finally(function () {
                $scope.loading = false;
            });
        };

        $scope.register = function () {
            $scope.loading = true;
            $scope.error = '';

            ApiService.patientRegister({
                name: $scope.form.name,
                email: $scope.form.email,
                phone: $scope.form.phone,
                password: $scope.form.password
            }).then(function (resp) {
                // Auto-login: store session and redirect to SPA dashboard
                AuthService.setSession(resp.data);
                HHToast.success('Account created! Welcome to HealthHub, ' + resp.data.name + '!');
                setTimeout(function () {
                    window.location.href = '/#/patient/dashboard';
                }, 600);
            }).catch(function (err) {
                $scope.error = (err.data && err.data.error) || 'Registration failed.';
            }).finally(function () {
                $scope.loading = false;
            });
        };
    }
]);
