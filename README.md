# NUT UPS Monitor — a GNOME Shell extension

Shows the state of a UPS served by NUT (Network UPS Tools) in the top bar, and
notifies you on power failure, low battery, mains recovery and lost contact.

```
[🔋 100%]                 ← top bar
 ├ myups@localhost
 ├ Mock Power Corp. UPS 1500
 ├ nut-monitor.service   Running
 ├ Status            Online
 ├ Battery charge    100%
 ├ Runtime left      1 h 23 min
 ├ Load              23%
 ├ Input voltage     101.2 V
 ├ Output voltage    101.0 V
 ├ Battery voltage   27.3 V
 ├ Nominal power     900 W
 ├ ──────────────
 ├ Refresh now
 └ Settings…
```

- Speaks the NUT network protocol (TCP 3493) straight from GJS — no `upsc` or
  any other external command.
- Works with a local or a remote `upsd`. Authentication is optional.
- Reports whether the local NUT service (`upsmon`) is running, read from systemd
  over D-Bus. See [The NUT service row](#the-nut-service-row).
- A poll has to finish within the connection timeout, and the socket also gives
  up as soon as the server goes quiet for that long, so a slow server never
  freezes the shell.
- Backs off exponentially (up to 60 s) while the server is unreachable, and
  returns to the normal interval once it answers again.
- English and Japanese.

## Requirements

- GNOME Shell 50
- NUT 2.x `upsd`, local or remote

## Install

```sh
make install
```

This copies the extension to
`~/.local/share/gnome-shell/extensions/nutmonitor@yukke.org/`. GNOME 50 is
Wayland only and the shell cannot be restarted, so **log out and back in**, then:

```sh
gnome-extensions enable nutmonitor@yukke.org   # or: make enable
gnome-extensions prefs  nutmonitor@yukke.org   # or: make prefs
```

`make pack` builds a distributable zip in `build/`.

## The NUT service row

Below the connection line the menu shows the state of the systemd unit that runs
`upsmon`, the NUT client that shuts the machine down when the power goes out.
The state is read from `org.freedesktop.systemd1` on the system bus with
`ListUnitsByNames`, which systemd answers without any authorisation; nothing is
ever started or stopped from here.

The unit names come from upstream NUT, so the same lookup covers every
distribution that ships NUT with systemd:

| Distribution | `upsmon` unit | `upsd` unit |
| --- | --- | --- |
| Debian / Ubuntu | `nut-monitor.service` (alias `nut-client.service`) | `nut-server.service` |
| Fedora / RHEL | `nut-monitor.service` | `nut-server.service` |
| Arch Linux | `nut-monitor.service` | `nut-server.service` |
| openSUSE | `nut-monitor.service` | `nut-server.service` |

`upsmon.service` is tried as well, for older packages that named the unit after
the daemon. The row disappears when none of those units exist, and when systemd
cannot be reached at all — a machine that only watches a remote UPS through this
extension needs no `upsmon` of its own.

Note that this is the *monitoring client*, not the server this extension talks
to. `upsmon` may well be running against a remote `upsd`, so the row is shown
whatever `host` is set to.

## Settings

Change them in the preferences window (`make prefs`) or with `gsettings`.

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `localhost` | Host running `upsd` |
| `port` | `3493` | Port `upsd` listens on |
| `ups-name` | empty | UPS name from `ups.conf`; empty picks the first one the server reports |
| `username` / `password` | empty | Credentials from `upsd.users` (optional) |
| `poll-interval` | `5` | Seconds between polls |
| `connection-timeout` | `5` | Seconds to wait for the server |
| `panel-label` | `charge` | Value shown in the top bar: `charge` / `runtime` / `load` / `status` / `none` |
| `panel-box` | `right` | Section of the top bar: `left` / `center` / `right` |
| `panel-position` | `0` | Slot within that section; 0 is leftmost, anything past the last item goes to the end |
| `show-menu-detail` | `true` | Show voltages and nominal power in the menu |
| `notify-*` | `true` | One switch per kind of notification |

