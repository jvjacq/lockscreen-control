# Lockscreen Control

A GNOME Shell extension that gives you full control over the lock screen experience.

## Features

- **Notification Collapse** - hide notifications behind a toggle button to keep the lock screen tidy
- **Screen Unblanking** - prevent the display from turning off while locked, with optional AC-only mode and a re-blank timeout
- **Background Blur** - apply a configurable gaussian blur to the lock screen wallpaper
- **Background Dimming** - apply a dark overlay to improve readability
- **Custom Message** - display a personal text message with configurable size and color

All features are independently toggleable from the preferences window.

## Installation

### From extensions.gnome.org (recommended)

Search for "Lockscreen Control" in [Extension Manager](https://flathub.org/apps/com.mattjakeman.ExtensionManager) or visit the extension page on [extensions.gnome.org](https://extensions.gnome.org).

### Manual

```bash
git clone https://github.com/jvjacq/lockscreen-control ~/.local/share/gnome-shell/extensions/lockscreen-control@jvjacq.com
cd ~/.local/share/gnome-shell/extensions/lockscreen-control@jvjacq.com/schemas
glib-compile-schemas .
gnome-extensions enable lockscreen-control@jvjacq.com
```

## Supported GNOME versions

45, 46, 47, 48, 49, 50

## License

GPL-2.0
