import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TIMEOUT_OPTIONS = [
    [0, 'Never'],
    [1, '1 minute'],
    [5, '5 minutes'],
    [10, '10 minutes'],
    [30, '30 minutes'],
];

export default class LockscreenControlPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(600, 700);

        // Notifications page
        const notifPage = new Adw.PreferencesPage({
            title: 'Notifications',
            icon_name: 'preferences-system-notifications-symbolic',
        });
        window.add(notifPage);

        const notifGroup = new Adw.PreferencesGroup({ title: 'Notification Collapse' });
        notifPage.add(notifGroup);

        const collapseRow = new Adw.SwitchRow({
            title: 'Collapse Notifications',
            subtitle: 'Hide notifications behind a toggle button on the lock screen',
        });
        settings.bind('notifications-collapse', collapseRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        notifGroup.add(collapseRow);

        // Display page
        const displayPage = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'video-display-symbolic',
        });
        window.add(displayPage);

        const unblankGroup = new Adw.PreferencesGroup({
            title: 'Screen Blanking',
            description: 'Prevent the lock screen from dimming or turning off the display',
        });
        displayPage.add(unblankGroup);

        const unblankRow = new Adw.SwitchRow({
            title: 'Keep Screen Unblanked',
            subtitle: 'Prevent the display from turning off while locked',
        });
        settings.bind('unblank-enabled', unblankRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        unblankGroup.add(unblankRow);

        const acRow = new Adw.SwitchRow({
            title: 'Only When on AC Power',
            subtitle: 'Only keep the screen on when plugged in',
        });
        settings.bind('unblank-ac-only', acRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('unblank-enabled', acRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        unblankGroup.add(acRow);

        const timeoutModel = new Gtk.StringList({
            strings: TIMEOUT_OPTIONS.map(([, label]) => label),
        });
        const timeoutRow = new Adw.ComboRow({
            title: 'Re-blank After',
            subtitle: 'Allow the screen to blank again after this time',
            model: timeoutModel,
        });
        settings.bind('unblank-enabled', timeoutRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);

        const syncTimeout = () => {
            const val = settings.get_int('unblank-timeout');
            const i = TIMEOUT_OPTIONS.findIndex(([v]) => v === val);
            if (i >= 0 && timeoutRow.selected !== i)
                timeoutRow.selected = i;
        };
        syncTimeout();
        timeoutRow.connect('notify::selected', () => {
            settings.set_int('unblank-timeout', TIMEOUT_OPTIONS[timeoutRow.selected][0]);
        });
        settings.connect('changed::unblank-timeout', syncTimeout);
        unblankGroup.add(timeoutRow);

        // Background page
        const bgPage = new Adw.PreferencesPage({
            title: 'Background',
            icon_name: 'image-x-generic-symbolic',
        });
        window.add(bgPage);

        const blurGroup = new Adw.PreferencesGroup({
            title: 'Background Blur',
            description: 'Apply a blur effect to the lock screen wallpaper',
        });
        bgPage.add(blurGroup);

        const blurRow = new Adw.SwitchRow({
            title: 'Enable Blur',
            subtitle: 'Blur the wallpaper on the lock screen',
        });
        settings.bind('blur-enabled', blurRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        blurGroup.add(blurRow);

        const sigmaRow = new Adw.SpinRow({
            title: 'Blur Radius',
            subtitle: 'Higher values create more blur (default: 30)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 1,
                page_increment: 5,
                value: settings.get_int('blur-sigma'),
            }),
        });
        settings.bind('blur-sigma', sigmaRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('blur-enabled', sigmaRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        blurGroup.add(sigmaRow);

        const dimGroup = new Adw.PreferencesGroup({
            title: 'Background Brightness',
            description: 'Apply a dark overlay to dim the lock screen background',
        });
        bgPage.add(dimGroup);

        const dimRow = new Adw.SwitchRow({
            title: 'Enable Dim Overlay',
            subtitle: 'Darken the background for better readability',
        });
        settings.bind('brightness-enabled', dimRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        dimGroup.add(dimRow);

        const brightnessRow = new Adw.SpinRow({
            title: 'Brightness Level',
            subtitle: '0.0 = fully black, 1.0 = no overlay (default: 0.60)',
            adjustment: new Gtk.Adjustment({
                lower: 0.0,
                upper: 1.0,
                step_increment: 0.05,
                page_increment: 0.1,
                value: settings.get_double('brightness-level'),
            }),
            digits: 2,
        });
        settings.bind('brightness-level', brightnessRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('brightness-enabled', brightnessRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        dimGroup.add(brightnessRow);

        // Message page
        const msgPage = new Adw.PreferencesPage({
            title: 'Message',
            icon_name: 'text-editor-symbolic',
        });
        window.add(msgPage);

        const msgGroup = new Adw.PreferencesGroup({
            title: 'Custom Message',
            description: 'Show a personal text message on the lock screen',
        });
        msgPage.add(msgGroup);

        const msgEnabledRow = new Adw.SwitchRow({
            title: 'Show Message',
            subtitle: 'Display a custom text line on the lock screen',
        });
        settings.bind('message-enabled', msgEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        msgGroup.add(msgEnabledRow);

        const msgTextRow = new Adw.EntryRow({ title: 'Message Text' });
        msgTextRow.set_text(settings.get_string('message-text'));
        msgTextRow.connect('changed', () => settings.set_string('message-text', msgTextRow.get_text()));
        settings.connect('changed::message-text', () => {
            const val = settings.get_string('message-text');
            if (msgTextRow.get_text() !== val)
                msgTextRow.set_text(val);
        });
        settings.bind('message-enabled', msgTextRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        msgGroup.add(msgTextRow);

        const msgSizeRow = new Adw.SpinRow({
            title: 'Font Size (px)',
            adjustment: new Gtk.Adjustment({
                lower: 8,
                upper: 72,
                step_increment: 1,
                page_increment: 4,
                value: settings.get_int('message-size'),
            }),
        });
        settings.bind('message-size', msgSizeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('message-enabled', msgSizeRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        msgGroup.add(msgSizeRow);

        const msgColorRow = new Adw.EntryRow({ title: 'Text Color (hex)' });
        msgColorRow.set_text(settings.get_string('message-color'));
        msgColorRow.connect('changed', () => settings.set_string('message-color', msgColorRow.get_text()));
        settings.connect('changed::message-color', () => {
            const val = settings.get_string('message-color');
            if (msgColorRow.get_text() !== val)
                msgColorRow.set_text(val);
        });
        settings.bind('message-enabled', msgColorRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        msgGroup.add(msgColorRow);
    }
}
