# Plugins

Pult discovers plugins in `~/.pult/plugins/<id>/`. A plugin is a folder with a
single `pult-plugin.json` manifest:

```json
{
  "$schema": "https://pult.local/schemas/plugin-v1.json",
  "id": "acme.theme",
  "name": "Acme theme",
  "version": "1.0.0",
  "author": "Acme",
  "description": "Warm accent and two commands.",
  "contributes": {
    "commands": [{ "id": "acme.refresh", "title": "Refresh Acme" }],
    "slots": ["composer.footer", "sidebar.footer"],
    "themes": ["acme"]
  }
}
```

Rules:

- `id` is lowercase `a-z`, `0-9`, `-` or `_`, at most 64 characters.
- `version` is informational for now (semver recommended).
- Unknown fields are ignored, so newer plugins load in older Pult builds.

## Security model (current milestone)

Plugins are **declarative**. Pult reads the manifest, lists its commands and
slots, and lets the user enable or disable it in **Settings → Plugins**. No
plugin JavaScript runs, and a plugin never receives `invoke`, shell, network or
raw filesystem access. Enabling a plugin cannot execute code.

Future milestones will add a sandboxed worker with an explicit permission
prompt per capability; until then, treat third-party plugin folders as data,
not as trusted code.

## Where to put a plugin

Create the folder and manifest, then open **Settings → Plugins** and refresh the
page (the footer button opens the folder):

```
~/.pult/plugins/acme.theme/pult-plugin.json
```
