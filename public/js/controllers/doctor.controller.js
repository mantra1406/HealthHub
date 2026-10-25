// Doctor Controller — HealthHub
angular.module('healthhubApp').controller('DoctorController', [
    '$scope', '$location', '$routeParams', 'AuthService', 'ApiService',
    function ($scope, $location, $routeParams, AuthService, ApiService) {
        if (!AuthService.isLoggedIn() || AuthService.getRole() !== 'doctor') {
            $location.path('/login'); return;
        }

        $scope.user = { name: AuthService.getName(), role: 'doctor', letter: AuthService.getAvatarLetter() };
        $scope.appointments = [];
        $scope.pendingAppointments = [];
        $scope.completedAppointments = [];
        $scope.loading = false;
        $scope.reportFile = null;
        $scope.reportForm = {};
        $scope.activeSection = 'pending';
        // ============ NOTIFICATIONS ============
        $scope.notifications = [];
        $scope.notifUnread = 0;
        $scope.loadNotifications = function () {
            ApiService.getNotifications().then(function (r) {
                $scope.notifications = r.data;
                $scope.notifUnread = r.data.filter(function (n) { return !n.is_read; }).length;
            }).catch(function () { });
        };
        $scope.markNotifRead = function (n) {
            if (n.is_read) return;
            n.is_read = true;
            $scope.notifUnread = Math.max(0, $scope.notifUnread - 1);
            ApiService.markNotificationRead(n.notification_id).catch(function () { });
        };
        $scope.markAllNotifsRead = function () {
            $scope.notifications.forEach(function (n) { n.is_read = true; });
            $scope.notifUnread = 0;
            ApiService.markAllNotificationsRead().catch(function () { });
        };
        $scope.loadNotifications();


        // Off-days
        $scope.offDays = [];
        $scope.offDaysLoading = false;
        $scope.offDayLoading = false;
        $scope.offDayError = '';

        // Local-timezone safe date formatter (avoids UTC shift bug)
        function toLocalYMD(d) {
            return d.getFullYear() + '-' +
                String(d.getMonth() + 1).padStart(2, '0') + '-' +
                String(d.getDate()).padStart(2, '0');
        }

        // Store as a plain string — bypass AngularJS Date object handling for type=date inputs
        $scope.newOffDate = toLocalYMD(new Date());

        // Called directly by onchange on the date input — captures the raw string value
        $scope.setOffDate = function (val) {
            $scope.newOffDate = val;
        };

        // ============ HELPERS ============
        // Format "HH:MM:SS" or mysql2 duration as readable "10:30 AM"
        $scope.formatTime = function (t) {
            if (!t) return '';
            var str = t;
            // mysql2 may return time as total seconds (integer)
            if (typeof t === 'number') {
                var hh = Math.floor(t / 3600);
                var mm = Math.floor((t % 3600) / 60);
                str = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':00';
            }
            var parts = str.split(':');
            var h = parseInt(parts[0], 10);
            var m = parts[1] || '00';
            var ampm = h >= 12 ? 'PM' : 'AM';
            var h12 = h % 12 || 12;
            return h12 + ':' + m + ' ' + ampm;
        };

        $scope.getTodayDate = function () {
            return toLocalYMD(new Date());
        };

        // ============ INIT ============
        $scope.init = function () {
            $scope.loadAppointments();
            $scope.loadOffDays();
        };

        // ============ DASHBOARD ============
        $scope.loadAppointments = function () {
            $scope.loading = true;
            ApiService.doctorAppointments().then(function (r) {
                $scope.appointments = r.data;
                // Split into pending vs completed/cancelled
                $scope.pendingAppointments = r.data.filter(function (a) {
                    return a.status === 'Pending';
                });
                $scope.completedAppointments = r.data.filter(function (a) {
                    return a.status === 'Completed' || a.status === 'Cancelled';
                });
            }).catch(function () { HHToast.error('Failed to load appointments.'); })
                .finally(function () { $scope.loading = false; });
        };

        // ============ OFF-DAYS ============
        $scope.loadOffDays = function () {
            $scope.offDaysLoading = true;
            ApiService.get('/api/doctor/off-days').then(function (r) {
                $scope.offDays = r.data;
            }).catch(function () { HHToast.error('Failed to load off-days.'); })
                .finally(function () { $scope.offDaysLoading = false; });
        };

        $scope.addOffDay = function () {
            var dateToSend = $scope.newOffDate ? String($scope.newOffDate).substring(0, 10) : '';
            if (!dateToSend || !/^\d{4}-\d{2}-\d{2}$/.test(dateToSend)) {
                HHToast.error('Please select a date first.');
                return;
            }
            $scope.offDayLoading = true;
            $scope.offDayError = '';
            ApiService.post('/api/doctor/off-days', { off_date: dateToSend })
                .then(function () {
                    HHToast.success('Off-day added for ' + dateToSend);
                    $scope.newOffDate = toLocalYMD(new Date()); // reset to today as string
                    $scope.loadOffDays();
                }).catch(function (err) {
                    $scope.offDayError = (err.data && err.data.error) || 'Failed to add off-day.';
                }).finally(function () { $scope.offDayLoading = false; });
        };

        $scope.removeOffDay = function (offDayId) {
            ApiService.del('/api/doctor/off-days/' + offDayId)
                .then(function () {
                    HHToast.success('Off-day removed.');
                    $scope.loadOffDays();
                }).catch(function () { HHToast.error('Failed to remove off-day.'); });
        };

        // ============ APPOINTMENT DETAIL ============
        $scope.appointmentId = $routeParams.id;
        $scope.appt = null;
        $scope.treatmentForm = {};
        $scope.treatmentExists = false;

        $scope.loadAppointment = function () {
            if (!$scope.appointmentId) return;
            $scope.loading = true;
            ApiService.doctorAppointment($scope.appointmentId).then(function (r) {
                $scope.appt = r.data;
                if (r.data.treatment_id) {
                    $scope.treatmentExists = true;
                    $scope.treatmentForm = {
                        treatment_id: r.data.treatment_id,
                        appointment_id: $scope.appointmentId,
                        diagnosis: r.data.diagnosis,
                        prescription: r.data.prescription,
                        treatment_notes: r.data.treatment_notes,
                        treatment_cost: r.data.treatment_cost,
                        payment_status: r.data.payment_status
                    };
                } else {
                    $scope.treatmentForm = { appointment_id: $scope.appointmentId, payment_status: 'Unpaid' };
                }
                $scope.reportForm.patient_id = r.data.patient_id;
                $scope.reportForm.appointment_id = $scope.appointmentId;
                $scope.loadPatientHistory(r.data.patient_id);
            }).finally(function () { $scope.loading = false; });
        };

        $scope.patientHistory = null;
        $scope.historyLoading = false;
        $scope.showHistory = false;

        $scope.loadPatientHistory = function (patientId) {
            if (!patientId) return;
            $scope.historyLoading = true;
            ApiService.patientHistory(patientId).then(function (r) {
                $scope.patientHistory = r.data;
            }).catch(function () {
                $scope.patientHistory = null;
            }).finally(function () { $scope.historyLoading = false; });
        };

        $scope.toggleHistory = function () { $scope.showHistory = !$scope.showHistory; };

        // ============ PATIENT DETAIL PAGE (/doctor/patient/:patient_id) ============
        $scope.patientDetail = null;
        $scope.detailLoading = false;
        $scope.detailError   = false;

        $scope.loadPatientDetail = function () {
            var pid = $routeParams.patient_id;
            if (!pid) return;
            $scope.detailLoading = true;
            $scope.detailError   = false;
            ApiService.patientHistory(pid).then(function (r) {
                $scope.patientDetail = r.data;
                $scope.loadAccess();
            }).catch(function () {
                $scope.detailError = true;
            }).finally(function () { $scope.detailLoading = false; });
        };

        // ============ REPORT ACCESS (previous reports from other doctors) ============
        $scope.accessStatus = null;
        $scope.accessExpires = null;
        $scope.sharedReports = [];
        $scope.loadAccess = function () {
            var pid = $routeParams.patient_id;
            if (!pid) return;
            ApiService.getReportAccessStatus(pid).then(function (r) {
                $scope.accessStatus = r.data.status;
                $scope.accessExpires = r.data.expires_at;
                if (r.data.status === 'approved') {
                    ApiService.getSharedReports(pid).then(function (rr) { $scope.sharedReports = rr.data; })
                        .catch(function () { });
                }
            }).catch(function () { });
        };
        $scope.requestAccess = function () {
            var pid = $routeParams.patient_id;
            var name = ($scope.patientDetail && $scope.patientDetail.patient) ? $scope.patientDetail.patient.name : '';
            ApiService.requestReportAccess(pid, name).then(function () {
                $scope.accessStatus = 'pending';
                HHToast.success('Request sent — the patient can approve or deny it from their notifications.');
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Could not send the request.');
            });
        };

        // ============ STATUS UPDATE — only Complete or Cancel ============
        $scope.updateStatus = function (status) {
            if (status !== 'Completed' && status !== 'Cancelled') {
                HHToast.error('Invalid status. Doctor can only Complete or Cancel appointments.');
                return;
            }
            ApiService.updateApptStatus($scope.appointmentId, status).then(function () {
                $scope.appt.status = status;
                HHToast.success('Appointment marked as ' + status);
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Failed to update status.');
            });
        };

        $scope.saveTreatment = function () {
            var fn = $scope.treatmentExists
                ? ApiService.updateTreatment($scope.treatmentForm.treatment_id, $scope.treatmentForm)
                : ApiService.createTreatment($scope.treatmentForm);
            fn.then(function () {
                HHToast.success('Treatment record saved!');
                $scope.treatmentExists = true;
                $scope.loadAppointment();
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Failed to save treatment.');
            });
        };

        $scope.handleReportFile = function (el) {
            $scope.reportFile = el.files[0];
            $scope.$apply();
        };

        $scope.uploadReport = function () {
            if (!$scope.reportFile) { HHToast.error('Please select a file first.'); return; }
            var fd = new FormData();
            fd.append('report_file', $scope.reportFile);
            fd.append('patient_id', $scope.reportForm.patient_id);
            fd.append('appointment_id', $scope.reportForm.appointment_id);
            fd.append('report_type', $scope.reportForm.report_type || 'General');
            ApiService.uploadReport(fd).then(function () {
                HHToast.success('Report uploaded!');
                $scope.reportFile = null;
                $scope.reportForm.report_type = '';
                // Lock the upload panel
                $scope.appt.has_report = true;
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Report upload failed.');
            });
        };

        $scope.getStatusClass = function (s) {
            return { Pending: 'pending', Completed: 'completed', Cancelled: 'cancelled' }[s] || '';
        };

        // Files require the auth token now — fetch as blob via ApiService.
        $scope.downloadReport = function (filePath) { ApiService.openFile(filePath); };

        $scope.goBack = function () {
            window.history.back();
        };

        $scope.logout = function () {
            AuthService.logout();
            HHToast.info('Logged out.');
            $location.path('/login');
        };
    }
]);
