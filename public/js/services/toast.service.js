// HealthHub Toast Service
// The message is inserted with textContent, NEVER innerHTML: messages can
// contain user-controlled text (e.g. the name from registration, shown in
// "Welcome back, <name>!"), and innerHTML turned that into a stored-XSS
// hole — a name containing markup would execute in the browser, next to
// the JWT kept in localStorage.
(function () {
    'use strict';
    window.HHToast = {
        show: function (message, type) {
            type = type || 'info';
            var icons = { success: '\u2713', error: '!', info: 'i' };
            var container = document.getElementById('toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'toast-container';
                container.className = 'toast-container';
                document.body.appendChild(container);
            }
            var toast = document.createElement('div');
            toast.className = 'toast toast-' + type;

            var icon = document.createElement('span');
            icon.className = 'toast-icon';
            icon.textContent = icons[type] || 'i';

            var text = document.createElement('span');
            text.className = 'toast-message';
            text.textContent = message == null ? '' : String(message);

            toast.appendChild(icon);
            toast.appendChild(text);
            container.appendChild(toast);
            setTimeout(function () {
                toast.classList.add('hiding');
                setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
            }, 3500);
        },
        success: function (msg) { this.show(msg, 'success'); },
        error: function (msg) { this.show(msg, 'error'); },
        info: function (msg) { this.show(msg, 'info'); }
    };
})();
