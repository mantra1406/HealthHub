// Admin Controller — HealthHub
angular.module('healthhubApp').controller('AdminController', [
    '$scope', '$location', 'AuthService', 'ApiService',
    function ($scope, $location, AuthService, ApiService) {
        if (!AuthService.isLoggedIn() || AuthService.getRole() !== 'admin') {
            $location.path('/login'); return;
        }

        $scope.user = { username: AuthService.getName() || AuthService.getUsername(), role: 'admin', letter: 'A' };
        $scope.section = 'overview';
        $scope.loading = false;
        $scope.stats = {};
        $scope.doctors = [];
        $scope.patients = [];
        $scope.appointments = [];
        $scope.reports = [];
        $scope.offDays = [];
        $scope.uniqueOffDayDoctors = [];
        $scope.offDaysFilter = { doctorId: '', month: '' };
        $scope.offSort = { mode: 'smart' };
        $scope.dForm = {};
        $scope.doctorError = '';
        $scope.doctorLoading = false;
        $scope.showAddDoctor = false;
        $scope.patientSearch = { text: '' };


        // ============ NAVIGATION ============
        $scope.setSection = function (s) {
            $scope.section = s;
            loadForSection(s);
        };

        function loadForSection(s) {
            $scope.loading = true;
            if (s === 'overview') {
                ApiService.adminStats().then(function (r) {
                    $scope.stats = r.data;
                }).finally(function () { $scope.loading = false; });
                ApiService.getAdminAppointments().then(function (r) { $scope.appointments = r.data; });
            } else if (s === 'doctors') {
                ApiService.getDoctors().then(function (r) { $scope.doctors = r.data; })
                    .finally(function () { $scope.loading = false; });
            } else if (s === 'patients') {
                ApiService.getAdminPatients('').then(function (r) { $scope.patients = r.data; })
                    .finally(function () { $scope.loading = false; });
            } else if (s === 'appointments') {
                ApiService.getAdminAppointments().then(function (r) { $scope.appointments = r.data; })
                    .finally(function () { $scope.loading = false; });
            } else if (s === 'off-days') {
                ApiService.getAdminDoctorOffDays().then(function (r) {
                    $scope.offDays = r.data;
                    var seen = {};
                    $scope.uniqueOffDayDoctors = r.data.filter(function (od) {
                        if (seen[od.doctor_id]) return false;
                        seen[od.doctor_id] = true;
                        return true;
                    });
                }).finally(function () { $scope.loading = false; });
            } else { $scope.loading = false; }
        }


        // ============ ALL-APPOINTMENTS FILTER ============
        // NOTE: filter state lives on OBJECTS, not primitives — these
        // inputs sit inside ng-if sections (child scopes), and a
        // primitive ng-model there shadows instead of updating the
        // controller value, which silently killed the filter/search.
        $scope.apptFilters = { status: 'All', query: '' };
        $scope.apptFilter = function (a) {
            if ($scope.apptFilters.status !== 'All' && a.status !== $scope.apptFilters.status) return false;
            var q = String($scope.apptFilters.query || '').trim().toLowerCase();
            if (!q) return true;
            return String(a.patient_name || '').toLowerCase().indexOf(q) >= 0
                || String(a.doctor_name || '').toLowerCase().indexOf(q) >= 0;
        };

        // ============ DOCTOR CRUD ============
        $scope.isEditingDoctor = false;
        $scope.editingDoctorId = null;

        $scope.editDoctor = function (d) {
            $scope.dForm = angular.copy(d);
            $scope.dForm.password = ''; // clear password for editing
            $scope.isEditingDoctor = true;
            $scope.editingDoctorId = d.doctor_id;
            $scope.showAddDoctor = true;
            $scope.doctorError = '';
            window.scrollTo({ top: 0, behavior: 'smooth' });
        };

        $scope.cancelEditDoctor = function () {
            $scope.dForm = {};
            $scope.isEditingDoctor = false;
            $scope.editingDoctorId = null;
            $scope.showAddDoctor = false;
            $scope.doctorError = '';
        };

        $scope.saveDoctor = function () {
            $scope.doctorError = '';
            $scope.doctorLoading = true;
            // Capture BEFORE the request: cancelEditDoctor() resets
            // isEditingDoctor to false, so checking it afterwards was
            // always true and the create/update branches were meaningless.
            var wasEditing = $scope.isEditingDoctor;
            var request = wasEditing ? ApiService.updateDoctor($scope.editingDoctorId, $scope.dForm) : ApiService.createDoctor($scope.dForm);

            request.then(function () {
                HHToast.success(wasEditing ? 'Doctor updated successfully!' : 'Doctor account created!');
                $scope.cancelEditDoctor();
                ApiService.getDoctors().then(function (r) { $scope.doctors = r.data; });
                if (!wasEditing) {
                    ApiService.adminStats().then(function (r) { $scope.stats = r.data; });
                }
            }).catch(function (err) {
                $scope.doctorError = (err.data && err.data.error) || 'Failed to save doctor.';
            }).finally(function () { $scope.doctorLoading = false; });
        };

        $scope.toggleBan = function (d) {
            var newStatus = !d.is_banned;
            var actionStr = newStatus ? 'ban' : 'unban';
            if (!confirm('Are you sure you want to ' + actionStr + ' Dr. ' + d.name + '?')) return;
            
            ApiService.banDoctor(d.doctor_id, newStatus).then(function() {
                HHToast.success('Doctor ' + d.name + ' has been ' + actionStr + 'ned.');
                d.is_banned = newStatus;
            }).catch(function() {
                HHToast.error('Failed to change ban status.');
            });
        };

        // ============ PATIENT SEARCH ============
        $scope.searchPatients = function () {
            ApiService.getAdminPatients($scope.patientSearch.text).then(function (r) { $scope.patients = r.data; });
        };

        // ============ GENERIC DELETE ============
        $scope.deleteRecord = function (resource, id, idx) {
            if (!confirm('Are you sure you want to delete this record?')) return;
            ApiService.adminDelete(resource, id).then(function () {
                HHToast.success('Record deleted.');
                if (resource === 'doctors') { $scope.doctors.splice(idx, 1); }
                if (resource === 'patients') { $scope.patients.splice(idx, 1); }
                if (resource === 'appointments') { $scope.appointments.splice(idx, 1); }
                if (resource === 'reports') { $scope.reports.splice(idx, 1); }
                ApiService.adminStats().then(function (r) { $scope.stats = r.data; });
            }).catch(function () { HHToast.error('Delete failed.'); });
        };

        // ============ OFF-DAYS HELPERS ============
        // "Today" must be the LOCAL date. The old code used toISOString()
        // (UTC), which is still yesterday in IST between midnight and
        // 5:30 AM — so "Off Today" was wrong every morning.
        function localYMD(d) {
            return d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
        }

        $scope.isToday = function (dateStr) {
            if (!dateStr) return false;
            return String(dateStr).substring(0, 10) === localYMD(new Date());
        };

        $scope.isPast = function (dateStr) {
            if (!dateStr) return false;
            return String(dateStr).substring(0, 10) < localYMD(new Date());
        };

        $scope.todaysOffCount = function () {
            var today = localYMD(new Date());
            return $scope.offDays.filter(function (od) { return String(od.off_date).substring(0, 10) === today; }).length;
        };

        $scope.thisWeekOffCount = function () {
            var today = new Date();
            var weekEnd = new Date(today); weekEnd.setDate(today.getDate() + 7);
            var todayStr = localYMD(today);
            var weekEndStr = localYMD(weekEnd);
            return $scope.offDays.filter(function (od) {
                var d = String(od.off_date).substring(0, 10);
                return d >= todayStr && d <= weekEndStr;
            }).length;
        };

        $scope.todaysOffDoctors = function () {
            var today = localYMD(new Date());
            return $scope.offDays.filter(function (od) { return String(od.off_date).substring(0, 10) === today; });
        };

        $scope.filteredOffDays = function () {
            // <input type="month"> binds a Date object in AngularJS, not a
            // 'YYYY-MM' string — comparing it with === to a string was
            // always false, so choosing a month emptied the whole list.
            var month = $scope.offDaysFilter.month;
            var monthStr = '';
            if (month instanceof Date) {
                monthStr = month.getFullYear() + '-' + String(month.getMonth() + 1).padStart(2, '0');
            } else if (month) {
                monthStr = String(month).substring(0, 7);
            }
            var rows = $scope.offDays.filter(function (od) {
                var doctorMatch = !$scope.offDaysFilter.doctorId || String(od.doctor_id) === String($scope.offDaysFilter.doctorId);
                var monthMatch = !monthStr || String(od.off_date).substring(0, 7) === monthStr;
                return doctorMatch && monthMatch;
            });
            var mode = ($scope.offSort && $scope.offSort.mode) || 'smart';
            var today = localYMD(new Date());
            function dkey(od) { return String(od.off_date).substring(0, 10); }
            rows.sort(function (a, b) {
                if (mode === 'dateAsc') return dkey(a) < dkey(b) ? -1 : 1;
                if (mode === 'dateDesc') return dkey(a) > dkey(b) ? -1 : 1;
                if (mode === 'name') {
                    var na = String(a.doctor_name || '').toLowerCase(), nb = String(b.doctor_name || '').toLowerCase();
                    if (na !== nb) return na < nb ? -1 : 1;
                    return dkey(a) < dkey(b) ? -1 : 1;
                }
                var ua = dkey(a) >= today ? 0 : 1, ub = dkey(b) >= today ? 0 : 1;
                if (ua !== ub) return ua - ub;
                return ua === 0 ? (dkey(a) < dkey(b) ? -1 : 1) : (dkey(a) > dkey(b) ? -1 : 1);
            });
            return rows;
        };

        // Format "HH:MM:SS" (or mysql2 seconds) as "10:30 AM" — same helper
        // the doctor/patient controllers use; admin needed it for the new
        // appointment Time column.
        $scope.formatTime = function (t) {
            if (!t) return '—';
            var str = t;
            if (typeof t === 'number') {
                var hh = Math.floor(t / 3600);
                var mm = Math.floor((t % 3600) / 60);
                str = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00';
            }
            var parts = String(str).split(':');
            var h = parseInt(parts[0], 10);
            var m = parts[1] || '00';
            var ampm = h >= 12 ? 'PM' : 'AM';
            var h12 = h % 12 || 12;
            return h12 + ':' + m + ' ' + ampm;
        };

        // ============ MISC ============
        // Files require the auth token now — fetch as blob via ApiService.
        $scope.downloadReport = function (fp) { ApiService.openFile(fp); };
        $scope.viewIdDocument = function (fp) { ApiService.openFile(fp); };

        $scope.logout = function () {
            AuthService.logout();
            HHToast.info('Logged out.');
            $location.path('/login');
        };

        // ============ INIT ============
        $scope.setSection('overview');
    }
]);
