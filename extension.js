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
        this._authPollId = null;
        this._idleShowId = null;
        this._blurEffect = null;
        this._dimOverlay = null;
        this._messageLabel = null;
        this._inAuthMode = false;
        this._fadeDismissId = null;
        this._unblankTimeoutId = null;
        this._origActivateFade = null;
        this._origResetLockScreen = null;

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
            this._inAuthMode = false;
            this._toggleButton.label = 'Notifications  ▶';
            this._setupLockScreen();
        }

        this._syncOverlayVisibility();
    }

    _setupLockScreen() {
        const monitor = Main.layoutManager.primaryMonitor;
        const bgGroup = Main.screenShield?._backgroundGroup;

        if (bgGroup) {
            this._blurEffect = new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                sigma: this._settings.get_int('blur-sigma'),
            });
            bgGroup.add_effect(this._blurEffect);

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

        if (monitor) {
            this._messageLabel = new St.Label({ reactive: false, can_focus: false });
            // AlignConstraint centers the actor on the x-axis relative to the stage,
            // correctly accounting for the actor's actual rendered width.
            this._messageLabel.add_constraint(new Clutter.AlignConstraint({
                source: global.stage,
                align_axis: Clutter.AlignAxis.X_AXIS,
                factor: 0.5,
            }));
            global.stage.add_child(this._messageLabel);
            this._syncMessage();
        }

        // Poll every 300ms to detect when auth prompt appears/disappears.
        // This avoids depending on private method names that may vary by GNOME version.
        this._inAuthMode = this._detectAuthMode();
        this._authPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            const nowInAuth = this._detectAuthMode();
            if (nowInAuth && !this._inAuthMode) {
                // Entering auth: hide our UI immediately
                if (this._idleShowId) {
                    GLib.source_remove(this._idleShowId);
                    this._idleShowId = null;
                }
                this._inAuthMode = true;
                this._syncOverlayVisibility();
            } else if (!nowInAuth && this._inAuthMode && !this._idleShowId) {
                // Exiting auth: delay before showing so GNOME's exit animation finishes
                this._idleShowId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    this._idleShowId = null;
                    this._inAuthMode = false;
                    this._syncOverlayVisibility();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_CONTINUE;
        });

        // Notification collapse
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

        this._patchShield();
        this._syncOverlayVisibility();
    }

    // Check if the lock screen is currently in password-entry (auth) mode.
    // Tries several properties that may exist depending on the GNOME Shell version.
    _detectAuthMode() {
        const d = this._dialog;
        if (!d) return false;
        // Primary indicator: auth prompt actor is mapped (on-screen and visible)
        if (d._authPrompt) return d._authPrompt.mapped;
        // Fallback: user widget (avatar) is visible
        if (d._userWidget) return d._userWidget.mapped;
        // Fallback: if clock/date group is hidden, we're in auth mode
        if (d._clockGroup) return !d._clockGroup.visible;
        return false;
    }

    // Patch Main.screenShield methods to prevent lock screen blanking.
    // Auth mode detection is handled entirely by the poll — no auth logic here.
    _patchShield() {
        const shield = Main.screenShield;
        const self = this;

        const doUnblank = this._settings.get_boolean('unblank-enabled') &&
                          (!this._settings.get_boolean('unblank-ac-only') || this._isOnAC());

        if (!doUnblank) return;

        if (typeof shield._activateFade === 'function') {
            this._origActivateFade = shield._activateFade.bind(shield);
            shield._activateFade = function (lightbox, time) {
                // Skip the fade entirely when locked so the screen stays lit
                if (Main.sessionMode.currentMode === 'unlock-dialog') {
                    if (this._becameActiveId === 0) {
                        this._becameActiveId = this.idleMonitor.add_user_active_watch(
                            this._onUserBecameActive.bind(this)
                        );
                    }
                    return;
                }
                Main.uiGroup.set_child_above_sibling(lightbox, null);
                lightbox.lightOn(time);
                if (this._becameActiveId === 0) {
                    this._becameActiveId = this.idleMonitor.add_user_active_watch(
                        this._onUserBecameActive.bind(this)
                    );
                }
            };
        }

        if (typeof shield._resetLockScreen === 'function') {
            this._origResetLockScreen = shield._resetLockScreen.bind(shield);
            shield._resetLockScreen = function (params) {
                self._origResetLockScreen.call(this, Object.assign({}, params, { fadeToBlack: false }));
            };
        }

        const minutes = this._settings.get_int('unblank-timeout');
        if (minutes > 0) {
            this._unblankTimeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                minutes * 60,
                () => {
                    this._unblankTimeoutId = null;
                    this._unpatchActivateFade();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _unpatchActivateFade() {
        if (this._origActivateFade) {
            Main.screenShield._activateFade = this._origActivateFade;
            this._origActivateFade = null;
        }
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

    _syncOverlayVisibility() {
        const showOverlay = !this._inAuthMode;

        if (showOverlay && this._settings.get_boolean('notifications-collapse')) {
            this._positionButton();
            global.stage.set_child_above_sibling(this._toggleButton, null);
            this._toggleButton.show();
        } else {
            this._toggleButton.hide();
        }

        // Always hide notifications during auth so the password screen stays clean
        this._syncNotifBox();

        if (this._messageLabel) {
            if (showOverlay && this._settings.get_boolean('message-enabled'))
                this._messageLabel.show();
            else
                this._messageLabel.hide();
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
        this._dimOverlay.set_style(`background-color: rgba(0,0,0,${(1.0 - level).toFixed(2)});`);
    }

    _syncMessage() {
        if (!this._messageLabel) return;
        const text = this._settings.get_string('message-text');
        const size = this._settings.get_int('message-size');
        const color = this._settings.get_string('message-color');
        this._messageLabel.set_text(text);
        this._messageLabel.set_style(`font-size: ${size}px; color: ${color};`);
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor) {
            // Only set y; x is handled by AlignConstraint
            this._messageLabel.set_y(monitor.y + Math.floor(monitor.height * 0.48));
        }
        global.stage.set_child_above_sibling(this._messageLabel, null);
        this._syncOverlayVisibility();
    }

    _syncNotifBox() {
        const notifBox = this._dialog?._notificationsBox;
        if (!notifBox) return;
        if (!this._settings.get_boolean('notifications-collapse')) {
            // Feature disabled: show notifications normally unless in auth mode
            notifBox.opacity = this._inAuthMode ? 0 : 255;
            notifBox.reactive = !this._inAuthMode;
            return;
        }
        // Collapsed or in auth: hide. Expanded and idle: show.
        const hide = this._collapsed || this._inAuthMode;
        notifBox.opacity = hide ? 0 : 255;
        notifBox.reactive = !hide;
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
        if (this._authPollId) {
            GLib.source_remove(this._authPollId);
            this._authPollId = null;
        }
        if (this._idleShowId) {
            GLib.source_remove(this._idleShowId);
            this._idleShowId = null;
        }

        if (this._origResetLockScreen) {
            Main.screenShield._resetLockScreen = this._origResetLockScreen;
            this._origResetLockScreen = null;
        }
        this._unpatchActivateFade();

        if (this._unblankTimeoutId) {
            GLib.source_remove(this._unblankTimeoutId);
            this._unblankTimeoutId = null;
        }

        if (this._fadeDismissId) {
            GLib.source_remove(this._fadeDismissId);
            this._fadeDismissId = null;
        }

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

        this._dialog = null;
        this._inAuthMode = false;
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
