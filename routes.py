"""Backend routes for the Nashville Numbers Highway plugin.

Two concerns live here:

1. Arrangement-ACCURATE section markers (`GET .../sections/{filename}`) — see
   the long comment on that route below; unchanged from the original
   implementation.

2. Pre-computed Nashville-number sidecar files (`GET`/`POST
   .../nashville/{filename}`) — the persistent half of the hybrid
   pre-computed/live design. A computed result (song key + every chord's
   Nashville number) is written to a NEW sibling file next to the song's own
   chart data, using the exact JSON schema `extract_nashville_numbers.py`'s
   `extract_song_data()` already emits, so files produced by this plugin and
   files produced by the offline batch tool are interchangeable:

       {"title": str, "detected_key": str|null,
        "chords": [{"symbol": str|null, "time": float,
                     "nashville_number": str|null, "needs_review": bool}],
        "section_markers": [str]}

   HARD CONSTRAINT: the existing chart/arrangement file is never opened in
   write mode. Loose-folder songs get a brand-new sibling file
   (`<xml_stem>.nns.json`) written next to the XML. Sloppak songs get a new
   `arrangements/<id>.nns.json` entry:
     - directory-form sloppak: written directly, same as any other new file
       in that directory.
     - zip-form sloppak: every EXISTING entry is copied byte-for-byte into a
       freshly built archive (plus our one new entry), which then atomically
       replaces the original via `Path.replace()` — core's own established
       pattern for safe zip mutation (see `lib/songmeta.py`'s
       `_rewrite_zip_manifest`); nothing in this codebase ever appends to a
       zip in place. A `.bak` of the pristine original is kept on first
       write, mirroring that same core code. The sidecar is written into the
       actual `.sloppak` archive file itself (not just a transient unpack
       cache) so it survives reinstalls and stays shareable as a single
       file, same as the loose-folder case.

IMPORTANT — no direct imports of core's `lib/` internals (dlc_paths, sloppak,
loosefolder, jsonc, ...). An earlier version of this file did exactly that
(`import dlc_paths`, `import sloppak`, `import loosefolder`, `from jsonc
import load_json`) and it broke plugin loading entirely in a real install
(feedback-desktop) with "No module named 'dlc_paths'" — core's `lib/` is not
a stable, guaranteed-importable surface for plugins (only the documented
`context` dict passed to `setup(app, context)` is; see CLAUDE.md's Plugin
System section). Confirmed empirically: `sloppak`, `loosefolder`, and
`jsonc` fail to import the exact same way once `dlc_paths` is fixed and
Python actually reaches those import lines — the original bug report only
ever showed the FIRST failing import, not the full extent. Every helper
below is self-contained: stdlib (`zipfile`, `json`, `xml.etree`) plus
`PyYAML` (a real installed pip package — safe regardless of `PYTHONPATH`,
unlike a bare `lib/` source file) for `manifest.yaml`. This plugin only ever
needs a narrow slice of what those core modules do (locate an arrangement's
source file, read/write one JSON member) — not full format-parity, so
reimplementing that slice locally is a small, honest trade, not a
duplication of substantial logic.
"""

import json
import os
import shutil
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath

import yaml
from fastapi import Body, FastAPI, HTTPException

PLUGIN_ID = "nns_highway"

_SLOPPAK_EXTS = (".sloppak", ".feedpak")


def _resolve_dlc_path(dlc: Path, filename: str) -> Path | None:
    """Resolve `filename` under DLC_DIR and refuse anything that escapes.

    Local reimplementation of lib/dlc_paths.py's `_resolve_dlc_path` (same
    lexical-containment algorithm: reject `..`/absolute/drive-letter paths,
    then normalize without following symlinks) — see the module docstring
    for why this isn't imported from core directly.
    """
    if not filename:
        return None
    safe = filename.replace("\\", "/")
    if "\x00" in safe:
        return None
    if (PurePosixPath(safe).is_absolute()
            or PureWindowsPath(safe).is_absolute()
            or PureWindowsPath(safe).drive):
        return None
    try:
        root = dlc.resolve()
        candidate = Path(os.path.normpath(root / safe))
        if not candidate.is_relative_to(root):
            return None
    except (ValueError, OSError):
        return None
    return candidate


def _is_sloppak_path(path: Path) -> bool:
    return path.name.lower().endswith(_SLOPPAK_EXTS)


def _load_sloppak_manifest(song_path: Path) -> dict:
    """Read manifest.yaml/.yml from a sloppak, directory or zip form."""
    if song_path.is_dir():
        for name in ("manifest.yaml", "manifest.yml"):
            mf = song_path / name
            if mf.exists():
                return yaml.safe_load(mf.read_text(encoding="utf-8")) or {}
        return {}
    try:
        with zipfile.ZipFile(song_path, "r") as z:
            names = set(z.namelist())
            for name in ("manifest.yaml", "manifest.yml"):
                if name in names:
                    return yaml.safe_load(z.read(name).decode("utf-8")) or {}
    except (zipfile.BadZipFile, OSError):
        pass
    return {}


def _read_sloppak_member(song_path: Path, rel: str) -> bytes | None:
    """Read one member's raw bytes from a sloppak (directory or zip form),
    with containment checking for the directory case (zip member names
    can't escape their own archive the way a filesystem path can)."""
    if song_path.is_dir():
        p = (song_path / rel).resolve()
        try:
            p.relative_to(song_path.resolve())
        except ValueError:
            return None
        if not p.is_file():
            return None
        return p.read_bytes()
    try:
        with zipfile.ZipFile(song_path, "r") as z:
            if rel not in z.namelist():
                return None
            return z.read(rel)
    except (zipfile.BadZipFile, KeyError, OSError):
        return None


# Mirrors lib/song.py::load_song's vocals/showlights skip AND its final
# arrangement-list ordering — kept in sync manually since core doesn't
# expose either as a shared helper. Both matter: `arrangement=N` here must
# resolve to the exact same file core's `song_info.arrangement_index=N`
# refers to, or every route below silently reads/writes the wrong
# arrangement's data.
#
# Getting this wrong is not hypothetical — it happened. An earlier version
# of this helper only replicated the "sorted(rglob) + skip vocals/
# showlights" loop and stopped there, missing `load_song`'s FINAL step:
# `song.arrangements.sort(key=lambda a: priority.get(a.name.lower(), 99))`
# (lib/song.py ~line 1629) — a stable sort that groups arrangements by type
# (Lead first, then Bass, everything else keeps its original relative
# order). Against a real multi-arrangement song (Brown Eyed Girl) this
# silently resolved arrangement=3 to "Keyboard" instead of the real
# "HumStrum" core reports — undetected in earlier testing purely because
# that particular Keyboard arrangement happened to share identical section
# timestamps with the intended HumStrum file, masking the mismatch. Fixed
# here by replicating BOTH steps; see the priority dict below.
_SKIP_ARRANGEMENT_NAMES = {"vocals", "showlights", "jvocals"}

# Verbatim copy of lib/song.py's post-load sort key (~line 1628). Anything
# not listed (HumStrum, Keyboard, Simple, AltRhythm, ...) falls through to
# the 99 default and keeps its relative file-sorted order (Python's sort is
# stable), exactly matching core.
_ARRANGEMENT_TYPE_PRIORITY = {"lead": 0, "combo": 1, "rhythm": 2, "bass": 3}


def _playable_arrangement_xmls(song_path: Path) -> list[Path]:
    entries = []  # (xml_path, arrangement_name) in sorted-file load order
    for xml_path in sorted(song_path.rglob("*.xml")):
        try:
            tree = ET.parse(xml_path)
            root = tree.getroot()
        except ET.ParseError:
            continue
        if root.tag != "song":
            continue
        el = root.find("arrangement")
        name = el.text.strip() if (el is not None and el.text) else ""
        if name.lower() in _SKIP_ARRANGEMENT_NAMES:
            continue
        entries.append((xml_path, name))
    # Stable sort by type priority — mirrors song.arrangements.sort(...).
    entries.sort(key=lambda e: _ARRANGEMENT_TYPE_PRIORITY.get(e[1].lower(), 99))
    return [xml_path for xml_path, _name in entries]


def _parse_sections_from_xml(xml_path: Path) -> list[dict]:
    tree = ET.parse(xml_path)
    root = tree.getroot()
    sections = []
    container = root.find("sections")
    if container is not None:
        for s in container.findall("section"):
            name = s.get("name", "")
            start_time = s.get("startTime")
            if name and start_time is not None:
                sections.append({"name": name, "time": float(start_time)})
    return sections


def _sections_from_sloppak(song_path: Path, arrangement_index: int) -> list[dict] | None:
    manifest = _load_sloppak_manifest(song_path)
    entries = [e for e in (manifest.get("arrangements") or []) if isinstance(e, dict)]
    if not (0 <= arrangement_index < len(entries)):
        return None
    rel_raw = entries[arrangement_index].get("file")
    rel = rel_raw.strip() if isinstance(rel_raw, str) else ""
    if not rel:
        return None

    raw = _read_sloppak_member(song_path, rel)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    raw_sections = data.get("sections") or []
    sections = []
    for s in raw_sections:
        if not isinstance(s, dict):
            continue
        name = str(s.get("name", ""))
        time = s.get("time", s.get("start_time"))
        if name and time is not None:
            sections.append({"name": name, "time": float(time)})
    return sections


# ── Pre-computed Nashville-number sidecar files ─────────────────────────────

def _sidecar_path_for(source_path: Path) -> Path:
    return source_path.with_name(source_path.stem + ".nns.json")


def _sidecar_rel_for_sloppak(rel_arrangement_path: str) -> str:
    # Zip/manifest-internal paths are POSIX-style regardless of host OS.
    p = PurePosixPath(rel_arrangement_path.replace("\\", "/"))
    return str(p.with_name(p.stem + ".nns.json"))


def _read_sidecar_file(sidecar_path: Path) -> dict | None:
    if not sidecar_path.exists():
        return None
    try:
        data = json.loads(sidecar_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("chords"), list):
        return None
    return data


def _read_sidecar_sloppak(song_path: Path, sidecar_rel: str) -> dict | None:
    raw = _read_sloppak_member(song_path, sidecar_rel)
    if raw is None:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("chords"), list):
        return None
    return data


def _parse_phrase_markers(xml_path: Path) -> list[str]:
    # Mirrors extract_nashville_numbers.py::extract_section_markers exactly
    # — <phrases><phrase name> markers, a DIFFERENT source than the
    # <sections> used for verse-vote key detection above. Purely
    # informational in the schema; not consumed by key detection.
    tree = ET.parse(xml_path)
    root = tree.getroot()
    markers = []
    for phrase in root.findall("./phrases/phrase"):
        name = phrase.attrib.get("name")
        if name:
            markers.append(name)
    return markers


def _atomic_write_text(path: Path, content: str) -> None:
    tmp_path = path.with_name(path.name + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def _rebuild_zip_with_entry(zip_path: Path, entry_name: str, entry_bytes: bytes) -> None:
    """Rewrite `zip_path` with `entry_name` added (or replaced if a sidecar
    from a previous run already exists), every OTHER entry copied
    byte-for-byte. Mirrors lib/songmeta.py's `_rewrite_zip_manifest` — no
    code in this codebase ever opens a zip in append ('a') mode; the
    established, proven pattern is always rebuild-to-tmp-then-atomic-replace.
    Backs up the pristine original to `<name>.bak` on first modification
    (skipped if a .bak already exists), same as songmeta.py.
    """
    bak_path = zip_path.with_name(zip_path.name + ".bak")
    if not bak_path.exists():
        shutil.copy2(zip_path, bak_path)

    tmp_path = zip_path.with_name(zip_path.name + ".tmp")
    with zipfile.ZipFile(zip_path, "r") as zin, \
            zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename == entry_name:
                continue  # replaced below — never duplicate an entry name
            zout.writestr(item, zin.read(item.filename))
        zout.writestr(entry_name, entry_bytes)
    tmp_path.replace(zip_path)


def _validate_nashville_payload(body: dict) -> str | None:
    if not isinstance(body, dict):
        return "body must be an object"
    chords = body.get("chords")
    if not isinstance(chords, list):
        return "chords must be an array"
    for c in chords:
        if not isinstance(c, dict) or "time" not in c:
            return "each chord entry must be an object with a time field"
    return None


def setup(app: FastAPI, context: dict) -> None:
    get_dlc_dir = context["get_dlc_dir"]
    log = context["log"]

    def _resolve_song(filename: str, arrangement: int):
        """Shared prelude for every route below: validate + classify the
        song. Returns (song_path, is_slop, is_loose) or raises HTTPException.

        Format detection is deliberately narrower than core's own
        `is_sloppak`/`is_loose_song` (which also check for playable audio —
        irrelevant to this plugin, which only cares whether there's
        arrangement data to read/write): sloppak is a filename-extension
        check, loose-folder is just "a directory that isn't a sloppak" —
        `_playable_arrangement_xmls` already degrades to an empty list
        gracefully for a directory with no usable XML.
        """
        dlc = get_dlc_dir()
        if not dlc:
            raise HTTPException(status_code=404, detail="DLC folder not configured")
        song_path = _resolve_dlc_path(dlc, filename)
        if song_path is None:
            raise HTTPException(status_code=403, detail="forbidden")
        if not song_path.exists():
            raise HTTPException(status_code=404, detail="not found")
        if arrangement < 0:
            raise HTTPException(status_code=400, detail="arrangement index required")
        is_slop = _is_sloppak_path(song_path)
        is_loose = (not is_slop) and song_path.is_dir()
        if not (is_slop or is_loose):
            raise HTTPException(status_code=404, detail="not a chart")
        return song_path, is_slop, is_loose

    @app.get(f"/api/plugins/{PLUGIN_ID}/sections/{{filename:path}}")
    def get_arrangement_sections(filename: str, arrangement: int = -1):
        song_path, is_slop, is_loose = _resolve_song(filename, arrangement)

        try:
            if is_loose:
                xmls = _playable_arrangement_xmls(song_path)
                if not (0 <= arrangement < len(xmls)):
                    return {"sections": None, "source": "loose", "reason": "arrangement index out of range"}
                sections = _parse_sections_from_xml(xmls[arrangement])
            else:
                sections = _sections_from_sloppak(song_path, arrangement)
                if sections is None:
                    return {"sections": None, "source": "sloppak", "reason": "no per-arrangement section data"}
        except Exception:
            # log.warning(exc_info=True), not log.exception (=ERROR) — matches
            # core's own convention for this exact class of situation
            # (lib/routers/song.py's DLC metadata write: best-effort I/O that
            # degrades gracefully, not an app-threatening failure).
            log.warning("nns_highway: failed to read arrangement-accurate sections for %r arrangement=%s", filename, arrangement, exc_info=True)
            return {"sections": None, "source": "sloppak" if is_slop else "loose", "reason": "parse error"}

        return {"sections": sections, "source": "sloppak" if is_slop else "loose"}

    @app.get(f"/api/plugins/{PLUGIN_ID}/nashville/{{filename:path}}")
    def get_precomputed_nashville(filename: str, arrangement: int = -1):
        song_path, is_slop, is_loose = _resolve_song(filename, arrangement)

        try:
            if is_loose:
                xmls = _playable_arrangement_xmls(song_path)
                if not (0 <= arrangement < len(xmls)):
                    return {"available": False, "reason": "arrangement index out of range"}
                data = _read_sidecar_file(_sidecar_path_for(xmls[arrangement]))
            else:
                manifest = _load_sloppak_manifest(song_path)
                entries = [e for e in (manifest.get("arrangements") or []) if isinstance(e, dict)]
                if not (0 <= arrangement < len(entries)):
                    return {"available": False, "reason": "arrangement index out of range"}
                rel_raw = entries[arrangement].get("file")
                rel = rel_raw.strip() if isinstance(rel_raw, str) else ""
                if not rel:
                    return {"available": False, "reason": "arrangement has no file entry"}
                data = _read_sidecar_sloppak(song_path, _sidecar_rel_for_sloppak(rel))
        except Exception:
            log.warning("nns_highway: failed to read precomputed data for %r arrangement=%s", filename, arrangement, exc_info=True)
            return {"available": False, "reason": "read error"}

        if data is None:
            return {"available": False}
        return {"available": True, "data": data, "source": "sloppak" if is_slop else "loose"}

    @app.post(f"/api/plugins/{PLUGIN_ID}/nashville/{{filename:path}}")
    def save_precomputed_nashville(filename: str, arrangement: int = -1, body: dict = Body(...)):
        song_path, is_slop, is_loose = _resolve_song(filename, arrangement)

        err = _validate_nashville_payload(body)
        if err:
            raise HTTPException(status_code=400, detail=err)

        try:
            if is_loose:
                xmls = _playable_arrangement_xmls(song_path)
                if not (0 <= arrangement < len(xmls)):
                    raise HTTPException(status_code=400, detail="arrangement index out of range")
                xml_path = xmls[arrangement]
                payload = {
                    "title": str(body.get("title", "")),
                    "detected_key": body.get("detected_key"),
                    "chords": body["chords"],
                    "section_markers": _parse_phrase_markers(xml_path),
                }
                _atomic_write_text(_sidecar_path_for(xml_path), json.dumps(payload, indent=2))
                return {"ok": True, "source": "loose"}

            manifest = _load_sloppak_manifest(song_path)
            entries = [e for e in (manifest.get("arrangements") or []) if isinstance(e, dict)]
            if not (0 <= arrangement < len(entries)):
                raise HTTPException(status_code=400, detail="arrangement index out of range")
            rel_raw = entries[arrangement].get("file")
            rel = rel_raw.strip() if isinstance(rel_raw, str) else ""
            if not rel:
                raise HTTPException(status_code=400, detail="arrangement has no file entry")

            payload = {
                "title": str(body.get("title", "")),
                "detected_key": body.get("detected_key"),
                "chords": body["chords"],
                # Not reliably recoverable for sloppak — RS2014 phrase names
                # aren't preserved by the sloppak wire format / Phrase
                # dataclass. Left empty rather than guessed at.
                "section_markers": [],
            }
            sidecar_rel = _sidecar_rel_for_sloppak(rel)

            if song_path.is_dir():
                sidecar_path = (song_path / sidecar_rel).resolve()
                try:
                    sidecar_path.relative_to(song_path.resolve())
                except ValueError:
                    raise HTTPException(status_code=403, detail="forbidden")
                sidecar_path.parent.mkdir(parents=True, exist_ok=True)
                _atomic_write_text(sidecar_path, json.dumps(payload, indent=2))
            else:
                # Zip-form: write into the .sloppak archive itself (not just
                # a transient unpack cache) — see module docstring for why.
                _rebuild_zip_with_entry(song_path, sidecar_rel, json.dumps(payload, indent=2).encode("utf-8"))
            return {"ok": True, "source": "sloppak"}
        except HTTPException:
            raise
        except Exception:
            # A failed write (permission denied on a read-only mount, disk
            # full, etc.) is a best-effort-persistence miss, not an
            # app-threatening error — the frontend already has its
            # live-computed result cached and rendering regardless (see
            # main.js: this._cache is set BEFORE the save is attempted).
            # log.warning matches core's own convention for this exact class
            # of situation (lib/routers/song.py's DLC metadata write).
            log.warning("nns_highway: failed to save precomputed data for %r arrangement=%s", filename, arrangement, exc_info=True)
            raise HTTPException(status_code=500, detail="failed to save")
