import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class LockscreenControl extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dialog = null;
        this._dialogSetup = false;
        this._collapsed = true;
        this._retryId = null;
        this._inhibitCookie = null;
        this._inhibitTimeoutId = null;
        this._blurEffect = null;
        this._dimOverlay = null;
        this._messageLabel = null;

        // reactive:false - stage.grab(dialog) routes all lock-screen input to dialog;
        // clicks on this button are intercepted via the dialog 'event' listener below.
        this._toggleButton = new St.Button({
            label: 'Notifications  ▶',
            reactive: false,
            can_focus: false,
            style: 'font-size: 14px; padding: 6px 16px; color: white; ' +
                   'border: 1px solid rgba(255,255,255,0.3); border-radius: 20px; ' +
                   'background: rgba(0,0,0,0.3);',
        });
        global.stage.add_child(this._toggleButton);
        this._toggleButton.hide();

        this._settings.connectObject(
            'changed::blur-enabled', () => this._syncBlur(),
            'changed::blur-sigma', () => this._syncBlur(),
            'changed::brightness-enabled', () => this._syncDim(),
            'changed::brightness-level', () => this._syncDim(),
            'changed::message-enabled', () => this._syncMessage(),
            'changed::message-text', () => this._syncMessage(),
            'changed::message-size', () => this._syncMessage(),
            'changed::message-color', () => this._syncMessage(),
            this
        );

        Main.sessionMode.connectObject('updated', () => this._onSessionModeUpdated(), this);
        this._onSessionModeUpdated();
    }

    _onSessionModeUpdated() {
        if (Main.sessionMode.currentMode !== 'unlock-dialog') {
            this._toggleButton.hide();
            this._teardownLockScreen();
            return;
        }

        const dialog = Main.screenShield?._dialog;
        if (!dialog) {
            if (this._retryId)
                GLib.source_remove(this._retryId);
            this._retryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._retryId = null;
                this._onSessionModeUpdated();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (this._dialog !== dialog) {
            this._teardownLockScreen();
            this._dialog = dialog;
            this._collapsed = true;
            this._toggleButton.label = 'Notifications  ▶';
            this._setupLockScreen();
        }

        this._syncNotifBox();
        this._positionButton();
        global.stage.set_child_above_sibling(this._toggleButton, null);

        if (this._settings.get_boolean('notifications-collapse'))
            this._toggleButton.show();
        else
            this._toggleButton.hide();
    }

    _setupLockScreen() {
        const monitor = Main.layoutManager.primaryMonitor;
        const bgGroup = Main.screenShield?._backgroundGroup;

        // Blur: apply directly to the background actor group so only the wallpaper is blurred
        if (bgGroup) {
            this._blurEffect = new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                sigma: this._settings.get_int('blur-sigma'),
            });
            bgGroup.add_effect(this._blurEffect);

            // Dim overlay inside the background group so it sits below the dialog
            if (monitor) {
                this._dimOverlay = new St.Widget({
                    reactive: false,
                    can_focus: false,
                    x: 0,
                    y: 0,
                    width: monitor.width,
                    height: monitor.height,
                });
                bgGroup.add_child(this._dimOverlay);
            }
        }

        this._syncBlur();
        this._syncDim();

        // Custom message label
        if (monitor) {
            this._messageLabel = new St.Label({ reactive: false, can_focus: false });
            global.stage.add_child(this._messageLabel);
            this._syncMessage();
        }

        // Notification collapse: listen for clicks via the dialog event handler
        const notifBox = this._dialog._notificationsBox;
        if (notifBox && !this._dialogSetup) {
            this._dialogSetup = true;
            this._dialog.connectObject('event', (_actor, event) => {
                if (event.type() !== Clutter.EventType.BUTTON_PRESS)
                    return Clutter.EVENT_PROPAGATE;
                const [ex, ey] = event.get_coords();
                const [bx, by] = this._toggleButton.get_transformed_position();
                const [bw, bh] = this._toggleButton.get_size();
                if (ex >= bx && ex <= bx + bw && ey >= by && ey <= by + bh) {
                    this._collapsed = !this._collapsed;
                    this._toggleButton.label = this._collapsed
                        ? 'Notifications  ▶' : 'Notifications  ▼';
                    this._syncNotifBox();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            }, this);
        }

        this._setupUnblank();
    }

    _setupUnblank() {
        if (!this._settings.get_boolean('unblank-enabled'))
            return;
        if (this._settings.get_boolean('unblank-ac-only') && !this._isOnAC())
            return;

        try {
            const result = Gio.DBus.session.call_sync(
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager',
                'org.gnome.SessionManager',
                'Inhibit',
                new GLib.Variant('(susu)', [
                    this.uuid,
                    0,
                    'Keep lock screen unblanked',
                    8,
                ]),
                new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            this._inhibitCookie = result.get_child_value(0).get_uint32();
        } catch (_e) {
            // Power management inhibit unavailable
        }

        const minutes = this._settings.get_int('unblank-timeout');
        if (minutes > 0) {
            this._inhibitTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                minutes * 60,
                () => {
                    this._inhibitTimeoutId = null;
                    this._uninhibit();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _uninhibit() {
        if (this._inhibitCookie === null) return;
        try {
            Gio.DBus.session.call_sync(
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager',
                'org.gnome.SessionManager',
                'Uninhibit',
                new GLib.Variant('(u)', [this._inhibitCookie]),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
        } catch (_e) {
            // Failed to uninhibit
        }
        this._inhibitCookie = null;
    }

    _isOnAC() {
        try {
            const result = Gio.DBus.system.call_sync(
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'OnBattery']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            return !result.get_child_value(0).unpack().get_boolean();
        } catch (_e) {
            return true;
        }
    }

    _syncBlur() {
        if (!this._blurEffect) return;
        const enabled = this._settings.get_boolean('blur-enabled');
        this._blurEffect.sigma = enabled ? this._settings.get_int('blur-sigma') : 0;
    }

    _syncDim() {
        if (!this._dimOverlay) return;
        const enabled = this._settings.get_boolean('brightness-enabled');
        if (!enabled) {
            this._dimOverlay.set_style('');
            return;
        }
        const level = this._settings.get_double('brightness-level');
        const alpha = (1.0 - level).toFixed(2);
        this._dimOverlay.set_style(`background-color: rgba(0,0,0,${alpha});`);
    }

    _syncMessage() {
        if (!this._messageLabel) return;
        if (!this._settings.get_boolean('message-enabled')) {
            this._messageLabel.hide();
            return;
        }
        const text = this._settings.get_string('message-text');
        const size = this._settings.get_int('message-size');
        const color = this._settings.get_string('message-color');
        this._messageLabel.set_text(text);
        this._messageLabel.set_style(`font-size: ${size}px; color: ${color};`);

        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            // Position below the lock screen clock (approx 57% down)
            this._messageLabel.set_position(
                monitor.x + Math.floor((monitor.width - this._messageLabel.width) / 2),
                monitor.y + Math.floor(monitor.height * 0.57)
            );
        }
        global.stage.set_child_above_sibling(this._messageLabel, null);
        this._messageLabel.show();
    }

    _syncNotifBox() {
        if (!this._settings.get_boolean('notifications-collapse')) return;
        const notifBox = this._dialog?._notificationsBox;
        if (!notifBox) return;
        // opacity:0 keeps the box in layout so the clock position never shifts
        notifBox.opacity = this._collapsed ? 0 : 255;
        notifBox.reactive = !this._collapsed;
    }

    _positionButton() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;
        const bw = 240, bh = 36;
        this._toggleButton.set_position(
            monitor.x + Math.floor((monitor.width - bw) / 2),
            monitor.y + Math.floor(monitor.height * 0.25)
        );
        this._toggleButton.set_size(bw, bh);
    }

    _teardownLockScreen() {
        this._dialog?.disconnectObject(this);
        this._dialogSetup = false;

        const notifBox = this._dialog?._notificationsBox;
        if (notifBox) {
            notifBox.opacity = 255;
            notifBox.reactive = true;
        }

        const bgGroup = Main.screenShield?._backgroundGroup;
        if (this._blurEffect) {
            bgGroup?.remove_effect(this._blurEffect);
            this._blurEffect = null;
        }

        if (this._dimOverlay) {
            this._dimOverlay.get_parent()?.remove_child(this._dimOverlay);
            this._dimOverlay.destroy();
            this._dimOverlay = null;
        }

        if (this._messageLabel) {
            this._messageLabel.get_parent()?.remove_child(this._messageLabel);
            this._messageLabel.destroy();
            this._messageLabel = null;
        }

        if (this._inhibitTimeoutId) {
            GLib.source_remove(this._inhibitTimeoutId);
            this._inhibitTimeoutId = null;
        }
        this._uninhibit();

        this._dialog = null;
    }

    disable() {
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = null;
        }
        Main.sessionMode.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._teardownLockScreen();

        if (this._toggleButton) {
            this._toggleButton.destroy();
            this._toggleButton = null;
        }
        this._settings = null;
    }
}
