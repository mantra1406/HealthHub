// Patient Controller — Calendar Strip Booking Flow
angular.module('healthhubApp').controller('PatientController', [
    '$scope', '$location', 'AuthService', 'ApiService',
    function ($scope, $location, AuthService, ApiService) {
        if (!AuthService.isLoggedIn() || AuthService.getRole() !== 'patient') {
            $location.path('/login'); return;
        }

        // ============ STATE ============
        $scope.user = { name: AuthService.getName(), role: 'patient', letter: AuthService.getAvatarLetter() };
        $scope.activeSection = 'dashboard';
        $scope.loading = false;
        $scope.appointments = [];
        $scope.reports = [];
        $scope.doctors = [];
        $scope.specializations = ['All'];

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
        $scope.respondAccess = function (n, approve) {
            if (!n.ref_id) return;
            ApiService.respondAccessRequest(n.ref_id, approve).then(function () {
                n.action_done = true;
                if (!n.is_read) { n.is_read = true; $scope.notifUnread = Math.max(0, $scope.notifUnread - 1); }
                ApiService.markNotificationActionDone(n.notification_id).catch(function () { });
                HHToast.success(approve ? 'Access approved — the doctor can now view your previous reports.' : 'Request denied.');
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Could not respond to the request.');
            });
        };
        $scope.markAllNotifsRead = function () {
            $scope.notifications.forEach(function (n) { n.is_read = true; });
            $scope.notifUnread = 0;
            ApiService.markAllNotificationsRead().catch(function () { });
        };
        $scope.loadNotifications();
        ApiService.expireAccessSweep().catch(function () { });

        $scope.selectedSpec = 'All';
        // Doctor list predicate: name search AND specialization pill,
        // applied together (the repeat previously ignored the pill).
        $scope.docSearch = { text: '' };
        $scope.doctorFilter = function (doc) {
            var q = String(($scope.docSearch && $scope.docSearch.text) || '').trim().toLowerCase();
            var nameOk = !q || String(doc.name || '').toLowerCase().indexOf(q) >= 0;
            var specOk = !$scope.selectedSpec || $scope.selectedSpec === 'All' || doc.specialization === $scope.selectedSpec;
            return nameOk && specOk;
        };
        $scope.selectedDoctor = null;
        $scope.profile = {};
        $scope.completeForm = {};
        $scope.profileError = '';
        $scope.profileLoading = false;
        $scope.idFile = null;
        $scope.showProfileModal = false;
        $scope.bookingLoading = false;
        $scope.showBookingSuccess = false;
        $scope.lastBookedTime = '';

        // Booking form
        $scope.bookForm = { doctor_id: null, appointment_date: '', appointment_time: '' };

        // Calendar strip
        $scope.calendarOffset = 0;   // 0 = this week, 1 = next week
        $scope.calendarDays  = [];
        $scope.selectedDay   = null;
        $scope.dayOffCache   = {};   // YYYY-MM-DD -> true (doctor-specific off = true)

        // Slot state
        $scope.slots        = [];
        $scope.morningSlots = [];
        $scope.eveningSlots = [];
        $scope.slotsLoading = false;
        $scope.slotOffDay   = false;
        $scope.slotOffDayReason = '';

        // Reports
        $scope.reportFile    = null;
        $scope.uploadForm    = {};
        $scope.uploadLoading = false;
        $scope.showUploadPanel = false;

        // ============ HELPERS ============
        $scope.profileProgress = 30;
        function calcProgress(p) {
            var fields = ['name', 'email', 'phone', 'age', 'gender', 'address', 'id_type', 'id_number'];
            var filled = fields.filter(function (f) { return p && p[f]; }).length;
            return Math.round((filled / fields.length) * 100);
        }

        var DAY_NAMES   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        var MONTH_NAMES = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December'];
        var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        function toYMD(d) {
            return d.getFullYear() + '-' +
                   String(d.getMonth() + 1).padStart(2, '0') + '-' +
                   String(d.getDate()).padStart(2, '0');
        }

        function startOfToday() {
            var d = new Date();
            d.setHours(0, 0, 0, 0);
            return d;
        }

        // ============ CALENDAR STRIP ============
        function buildCalendarDays() {
            var today = startOfToday();
            var startOffset = $scope.calendarOffset * 7;
            $scope.calendarDays = [];
            for (var i = 0; i < 7; i++) {
                var d = new Date(today);
                d.setDate(today.getDate() + startOffset + i);
                var absOffset = startOffset + i;
                var dateStr = toYMD(d);
                var isWed = d.getDay() === 3;
                $scope.calendarDays.push({
                    date:     dateStr,
                    dayName:  DAY_NAMES[d.getDay()],
                    dayNum:   d.getDate(),
                    month:    MONTH_SHORT[d.getMonth()],
                    isToday:  absOffset === 0,
                    isWed:    isWed,
                    isBeyond: absOffset > 13,   // max 2 weeks
                    absOffset: absOffset,
                    // offByDoctor is filled when user clicks that day
                    offByDoctor: !!$scope.dayOffCache[dateStr]
                });
            }
        }

        $scope.getCalHeaderLabel = function () {
            if (!$scope.calendarDays.length) return '';
            var first = new Date($scope.calendarDays[0].date + 'T00:00:00');
            var last  = new Date($scope.calendarDays[6].date + 'T00:00:00');
            if (first.getMonth() === last.getMonth()) {
                return MONTH_NAMES[first.getMonth()] + ' ' + first.getFullYear();
            }
            return MONTH_SHORT[first.getMonth()] + ' – ' + MONTH_SHORT[last.getMonth()] + ' ' + last.getFullYear();
        };

        $scope.prevWeek = function () {
            if ($scope.calendarOffset <= 0) return;
            $scope.calendarOffset--;
            buildCalendarDays();
        };

        $scope.nextWeek = function () {
            if ($scope.calendarOffset >= 1) return;
            $scope.calendarOffset++;
            buildCalendarDays();
        };

        $scope.isDaySelectable = function (day) {
            return !day.isWed && !day.isBeyond && !day.offByDoctor;
        };

        $scope.selectDay = function (day) {
            if (!day || !$scope.selectedDoctor) return;
            if (day.isWed) return;
            if (day.isBeyond) return;
            if (day.offByDoctor) return;

            $scope.selectedDay = day;
            $scope.bookForm.appointment_date = day.date;
            $scope.bookForm.appointment_time = '';
            $scope.slots = [];
            $scope.morningSlots = [];
            $scope.eveningSlots = [];
            $scope.slotOffDay = false;
            $scope.slotOffDayReason = '';
            $scope.slotsLoading = true;

            ApiService.getDoctorSlots($scope.selectedDoctor.doctor_id, day.date).then(function (r) {
                var data = r.data;
                if (data.off_day) {
                    $scope.slotOffDay = true;
                    $scope.slotOffDayReason = data.reason || 'doctor_leave';
                    if (data.reason === 'doctor_leave') {
                        // Cache this so the day card shows OFF without re-fetching
                        $scope.dayOffCache[day.date] = true;
                        day.offByDoctor = true;
                    }
                    return;
                }
                $scope.slots = data.slots || [];
                $scope.morningSlots = $scope.slots.filter(function (s) {
                    return parseInt(s.time.split(':')[0], 10) < 13;
                });
                $scope.eveningSlots = $scope.slots.filter(function (s) {
                    return parseInt(s.time.split(':')[0], 10) >= 18;
                });
            }).catch(function () {
                HHToast.error('Failed to load slots. Please try again.');
            }).finally(function () { $scope.slotsLoading = false; });
        };

        // ============ FORMAT HELPERS ============
        $scope.formatTime = function (t) {
            if (!t) return '';
            var str = t;
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
        $scope.formatSlotLabel = function (t) { return $scope.formatTime(t); };

        $scope.getTodayDate = function () { return toYMD(new Date()); };

        // ============ NAVIGATION ============
        $scope.navigate = function (section) {
            $scope.activeSection = section;
            if (section === 'notifications') $scope.loadNotifications();
            $scope.loadSection(section);
        };

        $scope.loadSection = function (section) {
            $scope.loading = true;
            if (section === 'dashboard' || section === 'profile') {
                ApiService.patientProfile().then(function (r) {
                    $scope.profile = r.data;
                    $scope.profileProgress = calcProgress(r.data);
                    if (section === 'dashboard') { loadAppointments(); loadReports(); }
                }).finally(function () { $scope.loading = false; });
            } else if (section === 'book') {
                ApiService.getSpecializations().then(function (r) {
                    $scope.specializations = ['All'].concat(r.data);
                });
                ApiService.getPatientDoctors('').then(function (r) {
                    $scope.doctors = r.data;
                }).finally(function () { $scope.loading = false; });
            } else if (section === 'history') {
                loadAppointments(function () { $scope.loading = false; });
            } else if (section === 'reports') {
                loadAppointments(function () { loadReports(function () { $scope.loading = false; }); });
            } else { $scope.loading = false; }
        };

        function loadAppointments(cb) {
            ApiService.patientAppointments().then(function (r) {
                $scope.appointments = r.data;
                if (cb) cb();
            }).catch(function () { if (cb) cb(); });
        }
        function loadReports(cb) {
            ApiService.patientReports().then(function (r) {
                $scope.reports = r.data;
                if (cb) cb();
            }).catch(function () { if (cb) cb(); });
        }

        $scope.countByStatus = function (status) {
            return $scope.appointments.filter(function (a) { return a.status === status; }).length;
        };

        // ============ BOOKING ============
        $scope.filterBySpec = function (spec) {
            $scope.selectedSpec = spec;
            $scope.selectedDoctor = null;
            ApiService.getPatientDoctors(spec === 'All' ? '' : spec).then(function (r) {
                $scope.doctors = r.data;
            });
        };

        $scope.selectDoctor = function (doc) {
            $scope.selectedDoctor = doc;
            $scope.bookForm.doctor_id = doc.doctor_id;
            // Reset calendar & slot state
            $scope.calendarOffset = 0;
            $scope.selectedDay = null;
            $scope.dayOffCache = {};
            $scope.bookForm.appointment_date = '';
            $scope.bookForm.appointment_time = '';
            $scope.slots = [];
            $scope.morningSlots = [];
            $scope.eveningSlots = [];
            $scope.slotOffDay = false;
            buildCalendarDays();
        };

        $scope.selectSlot = function (slot) {
            if (!slot.available) return;
            $scope.bookForm.appointment_time = slot.time;
        };

        $scope.resetBooking = function () {
            $scope.selectedDoctor = null;
            $scope.selectedDay = null;
            $scope.dayOffCache = {};
            $scope.calendarOffset = 0;
            $scope.calendarDays = [];
            $scope.bookForm = { doctor_id: null, appointment_date: '', appointment_time: '' };
            $scope.slots = [];
            $scope.morningSlots = [];
            $scope.eveningSlots = [];
            $scope.slotOffDay = false;
        };

        $scope.bookAppointment = function () {
            if (!$scope.bookForm.doctor_id)        { HHToast.error('Please select a doctor.'); return; }
            if (!$scope.bookForm.appointment_date)  { HHToast.error('Please select a date.'); return; }
            if (!$scope.bookForm.appointment_time)  { HHToast.error('Please select a time slot.'); return; }
            if (!$scope.profile.profile_complete)   { $scope.showProfileModal = true; return; }

            $scope.bookingLoading = true;
            ApiService.bookAppointment({
                doctor_id:        $scope.bookForm.doctor_id,
                appointment_date: $scope.bookForm.appointment_date,
                appointment_time: $scope.bookForm.appointment_time
            }).then(function () {
                $scope.lastBookedTime = $scope.formatTime($scope.bookForm.appointment_time);
                $scope.resetBooking();
                $scope.showBookingSuccess = true;
                loadAppointments();
            }).catch(function (err) {
                var msg = (err.data && err.data.error) || 'Booking failed.';
                if (msg === 'PROFILE_INCOMPLETE') { $scope.showProfileModal = true; }
                else { HHToast.error(msg); }
            }).finally(function () { $scope.bookingLoading = false; });
        };

        $scope.closeBookingModal = function (goToHistory) {
            $scope.showBookingSuccess = false;
            if (goToHistory) $scope.navigate('history');
        };

        $scope.goToProfileFromModal = function () {
            $scope.showProfileModal = false;
            $scope.navigate('profile');
        };

        // ============ PROFILE COMPLETION ============
        $scope.handleFile = function (el) { $scope.idFile = el.files[0]; $scope.$apply(); };

        // DOB -> age: picking a date of birth fills the age field instantly.
        // The service recomputes it too, so the stored age can never drift
        // from the stored DOB.
        function calcAge(dobDate) {
            var t = new Date();
            var a = t.getFullYear() - dobDate.getFullYear();
            var m = t.getMonth() - dobDate.getMonth();
            if (m < 0 || (m === 0 && t.getDate() < dobDate.getDate())) a--;
            return a;
        }
        function toYMD(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        }
        $scope.maxDob = toYMD(new Date());
        $scope.updateAgeFromDob = function () {
            var d = $scope.completeForm.dobDate;
            if (d instanceof Date && !isNaN(d)) {
                var a = calcAge(d);
                $scope.completeForm.age = (a >= 0 && a <= 120) ? a : null;
            } else {
                $scope.completeForm.age = null;
            }
        };

        // ── Change mobile number (Profile card) ──
        // Object-held model: this section lives inside ng-if scopes.
        $scope.phoneEdit = { open: false, value: '', saving: false };
        $scope.startPhoneEdit = function () {
            $scope.phoneEdit.value = ($scope.profile && $scope.profile.phone) || '';
            $scope.phoneEdit.open = true;
        };
        $scope.cancelPhoneEdit = function () { $scope.phoneEdit.open = false; };
        $scope.savePhone = function () {
            if ($scope.phoneEdit.saving) return;
            $scope.phoneEdit.saving = true;
            ApiService.patientChangePhone($scope.phoneEdit.value).then(function (resp) {
                $scope.profile.phone = resp.data.phone;
                $scope.phoneEdit.open = false;
                HHToast.success('Mobile number updated.');
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Could not update your mobile number.');
            }).finally(function () {
                $scope.phoneEdit.saving = false;
            });
        };

        // ── Change password (Profile section) ──
        $scope.pwdForm = { current: '', next: '', confirm: '', saving: false };
        $scope.changePassword = function () {
            if ($scope.pwdForm.saving) return;
            if ($scope.pwdForm.next !== $scope.pwdForm.confirm) {
                HHToast.error('New passwords do not match.');
                return;
            }
            $scope.pwdForm.saving = true;
            ApiService.changePassword($scope.pwdForm.current, $scope.pwdForm.next).then(function () {
                $scope.pwdForm = { current: '', next: '', confirm: '', saving: false };
                HHToast.success('Password changed successfully.');
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Could not change your password.');
            }).finally(function () {
                $scope.pwdForm.saving = false;
            });
        };

        $scope.completeProfile = function () {
            // Backend requires an ID document for first-time completion —
            // fail here with a clear message instead of a round-trip error.
            if (!$scope.idFile && !($scope.profile && $scope.profile.id_document_path)) {
                $scope.profileError = 'Please upload your ID document to complete your profile.';
                return;
            }
            if (!$scope.completeForm.dobDate) {
                $scope.profileError = 'Please select your date of birth.';
                return;
            }
            $scope.profileLoading = true;
            $scope.profileError = '';
            var fd = new FormData();
            var payload = angular.copy($scope.completeForm);
            payload.dob = toYMD(payload.dobDate);   // Date object -> 'YYYY-MM-DD'
            delete payload.dobDate;
            Object.keys(payload).forEach(function (k) { fd.append(k, payload[k]); });
            if ($scope.idFile) fd.append('id_document', $scope.idFile);
            ApiService.patientCompleteProfile(fd).then(function () {
                HHToast.success('Profile completed! You can now book appointments.');
                $scope.profile.profile_complete = true;
                $scope.profileProgress = 100;
                ApiService.patientProfile().then(function (r) { $scope.profile = r.data; });
            }).catch(function (err) {
                $scope.profileError = (err.data && err.data.error) || 'Failed to save profile.';
            }).finally(function () { $scope.profileLoading = false; });
        };

        // ============ REPORTS ============
        $scope.openUploadForAppointment = function (id) {
            $scope.navigate('reports');
            $scope.showUploadPanel = true;
            setTimeout(function () { $scope.uploadForm.appointment_id = String(id); $scope.$apply(); }, 500);
        };

        $scope.handleReportFile = function (el) { $scope.reportFile = el.files[0]; $scope.$apply(); };

        $scope.uploadPatientReport = function () {
            if (!$scope.uploadForm.appointment_id) return HHToast.error('Please select an appointment');
            if ($scope.uploadForm.appointment_id === 'other' && !$scope.uploadForm.external_doctor_name) return HHToast.error('Please enter the doctor name');
            if (!$scope.uploadForm.report_type) return HHToast.error('Please enter a report title');
            if (!$scope.reportFile) return HHToast.error('Please select a file');
            $scope.uploadLoading = true;
            var fd = new FormData();
            fd.append('appointment_id', $scope.uploadForm.appointment_id);
            fd.append('report_type', $scope.uploadForm.report_type);
            if ($scope.uploadForm.appointment_id === 'other') fd.append('external_doctor_name', $scope.uploadForm.external_doctor_name);
            fd.append('report_file', $scope.reportFile);
            ApiService.patientUploadReport(fd).then(function () {
                HHToast.success('Report uploaded successfully');
                $scope.uploadForm = {};
                $scope.reportFile = null;
                $scope.showUploadPanel = false;
                loadReports();
            }).catch(function (err) {
                HHToast.error((err.data && err.data.error) || 'Failed to upload report');
            }).finally(function () { $scope.uploadLoading = false; });
        };

        // Files require the auth token now — fetch as blob via ApiService.
        $scope.downloadReport = function (filePath) { ApiService.openFile(filePath); };

        $scope.getStatusClass = function (s) {
            return { Pending: 'pending', Completed: 'completed', Cancelled: 'cancelled' }[s] || '';
        };

        $scope.logout = function () {
            AuthService.logout();
            HHToast.info('Logged out successfully.');
            $location.path('/login');
        };

        // ============ INIT ============
        $scope.navigate('dashboard');
    }
]);
