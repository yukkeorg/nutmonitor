UUID          = nutmonitor@yukke.org
SRC           = src
PO_DIR        = po
BUILD_DIR     = build
INSTALL_DIR   = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA_FILE   = $(SRC)/schemas/org.gnome.shell.extensions.nutmonitor.gschema.xml
JS_SOURCES    = $(SRC)/extension.js $(SRC)/prefs.js $(wildcard $(SRC)/lib/*.js)
PO_FILES      = $(wildcard $(PO_DIR)/*.po)
MOCK_PORT    ?= 13493

.PHONY: all install uninstall pack pot mo test mock nested headless enable disable prefs logs clean

all: mo

## Compile the translations into src/locale so install and pack pick them up.
mo:
	@for po in $(PO_FILES); do \
		lang=$$(basename $$po .po); \
		mkdir -p $(SRC)/locale/$$lang/LC_MESSAGES; \
		msgfmt $$po -o $(SRC)/locale/$$lang/LC_MESSAGES/$(UUID).mo; \
		echo "compiled $$po"; \
	done

install: mo
	rm -rf $(INSTALL_DIR)
	mkdir -p $(INSTALL_DIR)
	cp -r $(SRC)/. $(INSTALL_DIR)/
	glib-compile-schemas $(INSTALL_DIR)/schemas
	@echo "installed into $(INSTALL_DIR)"
	@echo "log out and back in (or use 'make nested') to load it"

uninstall:
	rm -rf $(INSTALL_DIR)
	@echo "removed $(INSTALL_DIR)"

## Build a zip suitable for extensions.gnome.org.
pack: mo
	mkdir -p $(BUILD_DIR)
	gnome-extensions pack $(SRC) \
		--extra-source=lib \
		--extra-source=locale \
		--schema=schemas/$(notdir $(SCHEMA_FILE)) \
		--podir=../$(PO_DIR) \
		--gettext-domain=$(UUID) \
		--out-dir=$(BUILD_DIR) --force
	@# pack ships the schema source only, so add the compiled version for
	@# people who install the zip by hand.
	glib-compile-schemas $(SRC)/schemas
	cd $(SRC) && zip -q $(CURDIR)/$(BUILD_DIR)/$(UUID).shell-extension.zip \
		schemas/gschemas.compiled
	@echo "wrote $(BUILD_DIR)/$(UUID).shell-extension.zip"

## Refresh the translation template and merge it into the existing catalogues.
pot:
	mkdir -p $(PO_DIR)
	xgettext --from-code=UTF-8 --language=JavaScript \
		--keyword=_ --keyword=C_:1c,2 \
		--package-name="NUT UPS Monitor" \
		--copyright-holder="NUT UPS Monitor contributors" \
		-o $(PO_DIR)/$(UUID).pot $(JS_SOURCES)
	@for po in $(PO_FILES); do \
		msgmerge --update --backup=none $$po $(PO_DIR)/$(UUID).pot; \
	done

## Run the mock server in the foreground, e.g. while testing in a nested shell.
mock:
	node tools/mock-nutd.mjs --port $(MOCK_PORT) --sequence "OL,OB,OB LB,OL" --advance 4

## Unit tests for the protocol client, run against a throwaway mock server.
test:
	@node tools/mock-nutd.mjs --port $(MOCK_PORT) & \
	MOCK_PID=$$!; \
	trap "kill $$MOCK_PID 2>/dev/null" EXIT; \
	ready=0; \
	for i in $$(seq 1 50); do \
		if ss -ltn 2>/dev/null | grep -q ":$(MOCK_PORT) "; then ready=1; break; fi; \
		sleep 0.1; \
	done; \
	if [ $$ready -eq 0 ]; then echo "mock server did not start"; exit 1; fi; \
	NUT_MOCK_PORT=$(MOCK_PORT) gjs -m tools/test-nutclient.js; \
	status=$$?; \
	kill $$MOCK_PID 2>/dev/null; \
	exit $$status

## A throwaway shell in a window, to try the extension without logging out.
## GNOME 49 dropped --nested in favour of --devkit; a plain --wayland tries to
## take over the seat and fails with EBUSY inside a running session.
## The nested shell gets its own bus, so it is enabled from in here.
nested: install
	dbus-run-session -- bash -c 'gnome-shell --devkit --wayland & \
		SHELL_PID=$$!; \
		for i in $$(seq 1 60); do \
			gdbus introspect --session --dest org.gnome.Shell \
				--object-path /org/gnome/Shell > /dev/null 2>&1 && break; \
			sleep 0.5; \
		done; \
		gnome-extensions enable $(UUID); \
		wait $$SHELL_PID'

## The same, without a window, for scripted checks.
headless:
	dbus-run-session -- gnome-shell --wayland --headless --virtual-monitor 1280x720

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

prefs:
	gnome-extensions prefs $(UUID)

logs:
	journalctl --user -f -o cat /usr/bin/gnome-shell

clean:
	rm -rf $(BUILD_DIR) $(SRC)/locale $(SRC)/schemas/gschemas.compiled
