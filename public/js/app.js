// Dark mode was removed — clear any persisted theme choice so browsers
// that had it enabled settle back on the (single) light theme.
(function () {
    try { localStorage.removeItem('hh-theme'); } catch (e) {}
    document.documentElement.removeAttribute('data-theme');
})();

// HealthHub AngularJS App — Module + Route Config
var app = angular.module('healthhubApp', ['ngRoute']);

app.config(['$routeProvider', '$locationProvider', function ($routeProvider, $locationProvider) {
    $locationProvider.hashPrefix('');

    $routeProvider
        .when('/', {
            templateUrl: 'views/home.html',
            controller: 'LandingController'
        })
        .when('/login', {
            templateUrl: 'views/login.html',
            controller: 'AuthController'
        })
        .when('/register', {
            templateUrl: 'views/register.html',
            controller: 'RegisterController'
        })
        .when('/admin/dashboard', {
            templateUrl: 'views/admin/dashboard.html',
            controller: 'AdminController',
            requireLogin: true
        })
        .when('/doctor/dashboard', {
            templateUrl: 'views/doctor/dashboard.html',
            controller: 'DoctorController',
            requireLogin: true
        })
        .when('/doctor/appointment/:id', {
            templateUrl: 'views/doctor/appointment.html',
            controller: 'DoctorController',
            requireLogin: true
        })
        .when('/doctor/patient/:patient_id', {
            templateUrl: 'views/doctor/patient-detail.html',
            controller: 'DoctorController',
            requireLogin: true
        })
        .when('/patient/dashboard', {
            templateUrl: 'views/patient/dashboard.html',
            controller: 'PatientController',
            requireLogin: true
        })
        .otherwise({ redirectTo: '/' });

    // NOTE: the old $http 401 interceptor is gone — there is no $http/API
    // server anymore. Firebase Auth maintains the session itself, and if it
    // expires, ApiService calls fail and controllers show their error toast;
    // the route guard below still bounces logged-out users to /login.
}]);

// Run block: route guard
app.run(['$rootScope', '$location', 'AuthService', function ($rootScope, $location, AuthService) {
    $rootScope.$on('$routeChangeStart', function (evt, next) {
        // Clean up landing-page class when navigating away
        document.body.classList.remove('landing-page');
        if (next && next.requireLogin && !AuthService.isLoggedIn()) {
            evt.preventDefault();
            $location.path('/login');
        }
    });
}]);

// Landing page controller (navbar wiring)
app.controller('LandingController', ['$scope', 'AuthService', function ($scope, AuthService) {
    // Mark body as landing-page so app.css vars don't interfere
    document.body.classList.add('landing-page');

    // Expose logged-in state so navbar can show "My Dashboard" button
    $scope.isLoggedIn = AuthService.isLoggedIn();
    $scope.userRole   = AuthService.getRole();
    $scope.dashboardUrl = function () {
        var role = AuthService.getRole();
        if (role === 'admin')   return '#/admin/dashboard';
        if (role === 'doctor')  return '#/doctor/dashboard';
        if (role === 'patient') return '#/patient/dashboard';
        return '#/login';
    };

    $scope.mobileOpen = false;
    $scope.closeMobile = function () { $scope.mobileOpen = false; };
    $scope.logout = function () {
        AuthService.logout();
        $scope.isLoggedIn = false;
        $scope.userRole = null;
    };
    $scope.scrollTo = function (id) {
        var el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
}]);

// Simple offers slider controller (used in landing)
app.controller('SliderController', ['$scope', '$interval', function ($scope, $interval) {
    $scope.slides = [
        {
            title: 'New Patient Offer',
            subtitle: 'First Consultation FREE!',
            text: 'Register today and get your first doctor consultation at no cost.',
            cta: 'Register Now →',
            gradient: 'linear-gradient(135deg,#00B4D8,#4361ee)'
        },
        {
            title: 'Dental Camp',
            subtitle: 'Free Dental Checkup Camp',
            text: 'Every Saturday at HealthHub Dental Care, Bangalore. Limited slots available.',
            cta: 'Book Slot →',
            gradient: 'linear-gradient(135deg,#6D28D9,#EC4899)'
        },
        {
            title: 'Heart Health Week',
            subtitle: 'Heart Health Awareness Week',
            text: 'Free ECG & BP check. Consult Dr. Arjun Mehta, Cardiologist.',
            cta: 'Book Now →',
            gradient: 'linear-gradient(135deg,#DC2626,#F59E0B)'
        },
        {
            title: 'Digital Records',
            subtitle: 'Go Paperless with HealthHub',
            text: 'Access all your medical reports, prescriptions & history online.',
            cta: 'Get Started →',
            gradient: 'linear-gradient(135deg,#22C55E,#0EA5E9)'
        }
    ];
    $scope.activeIndex = 0;
    $scope.go = function (i) { $scope.activeIndex = i; };
    $scope.next = function () {
        $scope.activeIndex = ($scope.activeIndex + 1) % $scope.slides.length;
    };
    $scope.prev = function () {
        $scope.activeIndex = ($scope.activeIndex - 1 + $scope.slides.length) % $scope.slides.length;
    };
    var timer = $interval($scope.next, 3000);
    $scope.$on('$destroy', function () { $interval.cancel(timer); });
}]);

// ── Appointment sorting ─────────────────────────────────────────────
// Modes: 'smart' (upcoming first — soonest first, then past most-recent
// first), 'dateAsc', 'dateDesc', 'name' (A–Z by the given name field).
app.filter('apptSort', function () {
    function key(a) { return (a.appointment_date || '') + ' ' + (a.appointment_time || ''); }
    function todayStr() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return function (list, mode, nameField) {
        if (!angular.isArray(list)) return list;
        var out = list.slice();
        var today = todayStr();
        function isUpcoming(a) {
            return (a.appointment_date || '') >= today && a.status !== 'Cancelled' && a.status !== 'Completed';
        }
        if (mode === 'dateAsc') {
            out.sort(function (x, y) { return key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0; });
        } else if (mode === 'dateDesc') {
            out.sort(function (x, y) { return key(x) > key(y) ? -1 : key(x) < key(y) ? 1 : 0; });
        } else if (mode === 'name') {
            out.sort(function (x, y) {
                var nx = (x[nameField] || '').toLowerCase(), ny = (y[nameField] || '').toLowerCase();
                if (nx !== ny) return nx < ny ? -1 : 1;
                return key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0;
            });
        } else {
            out.sort(function (x, y) {
                var ux = isUpcoming(x) ? 0 : 1, uy = isUpcoming(y) ? 0 : 1;
                if (ux !== uy) return ux - uy;
                if (ux === 0) return key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0;
                return key(x) > key(y) ? -1 : key(x) < key(y) ? 1 : 0;
            });
        }
        return out;
    };
});
