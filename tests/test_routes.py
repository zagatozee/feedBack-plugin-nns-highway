"""Regression tests for routes.py's sidecar/section read+write behavior.

Covers both DLC layouts the plugin supports (loose-folder and .sloppak
zip), the path-containment guard, and payload validation -- the
"regression suite" earlier commits referred to as run ad hoc; this makes
it a permanent, re-runnable part of the repo.
"""
import io
import logging
import sys
import zipfile
from pathlib import Path

import pytest
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import routes  # noqa: E402

PLUGIN_ID = routes.PLUGIN_ID

MINIMAL_SONG_XML = """<?xml version="1.0" encoding="utf-8"?>
<song>
    <arrangement>Rhythm</arrangement>
    <sections>
        <section name="verse" startTime="1.5"/>
        <section name="chorus" startTime="10.0"/>
    </sections>
    <phrases>
        <phrase name="verse"/>
        <phrase name="chorus"/>
    </phrases>
</song>
"""


def _make_client(dlc_dir: Path) -> TestClient:
    app = FastAPI()
    context = {"get_dlc_dir": lambda: dlc_dir, "log": logging.getLogger("test")}
    routes.setup(app, context)
    return TestClient(app)


@pytest.fixture
def dlc_dir(tmp_path):
    return tmp_path


# ── loose-folder round trip ──────────────────────────────────────────────

def test_loose_folder_sections_and_sidecar_round_trip(dlc_dir):
    song_dir = dlc_dir / "My Song"
    song_dir.mkdir()
    (song_dir / "Official_Rhythm1_abc.xml").write_text(MINIMAL_SONG_XML, encoding="utf-8")

    client = _make_client(dlc_dir)

    sections_resp = client.get(f"/api/plugins/{PLUGIN_ID}/sections/My Song", params={"arrangement": 0})
    assert sections_resp.status_code == 200
    body = sections_resp.json()
    assert body["source"] == "loose"
    assert body["sections"] == [{"name": "verse", "time": 1.5}, {"name": "chorus", "time": 10.0}]

    # No sidecar yet.
    get_before = client.get(f"/api/plugins/{PLUGIN_ID}/nashville/My Song", params={"arrangement": 0})
    assert get_before.json() == {"available": False}

    payload = {
        "title": "My Song",
        "detected_key": "G",
        "chords": [
            {"symbol": "G", "time": 0.0, "nashville_number": "1", "needs_review": False},
            {"symbol": "D", "time": 1.5, "nashville_number": "5", "needs_review": False},
        ],
    }
    post_resp = client.post(f"/api/plugins/{PLUGIN_ID}/nashville/My Song", params={"arrangement": 0}, json=payload)
    assert post_resp.status_code == 200
    assert post_resp.json() == {"ok": True, "source": "loose"}

    # Sidecar file written as a plain sibling, original XML untouched.
    sidecar_path = song_dir / "Official_Rhythm1_abc.nns.json"
    assert sidecar_path.exists()
    assert (song_dir / "Official_Rhythm1_abc.xml").read_text(encoding="utf-8") == MINIMAL_SONG_XML

    get_after = client.get(f"/api/plugins/{PLUGIN_ID}/nashville/My Song", params={"arrangement": 0})
    data = get_after.json()
    assert data["available"] is True
    assert data["source"] == "loose"
    assert data["data"]["detected_key"] == "G"
    assert data["data"]["chords"] == payload["chords"]
    # section_markers are populated from <phrases> on write, for loose songs.
    assert data["data"]["section_markers"] == ["verse", "chorus"]


# ── sloppak (zip) round trip ─────────────────────────────────────────────

def _make_sloppak_zip(path: Path, arrangement_rel: str, arrangement_json: dict) -> None:
    manifest = {"arrangements": [{"file": arrangement_rel}]}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", yaml.safe_dump(manifest))
        z.writestr(arrangement_rel, __import__("json").dumps(arrangement_json))
        z.writestr("audio.wem", b"fake-audio-bytes")  # unrelated member, must survive untouched


def test_sloppak_sections_and_sidecar_round_trip(dlc_dir):
    song_path = dlc_dir / "My Zip Song.sloppak"
    _make_sloppak_zip(song_path, "rhythm.json", {"sections": [{"name": "verse", "time": 2.0}]})

    client = _make_client(dlc_dir)

    sections_resp = client.get(f"/api/plugins/{PLUGIN_ID}/sections/My Zip Song.sloppak", params={"arrangement": 0})
    assert sections_resp.status_code == 200
    body = sections_resp.json()
    assert body["source"] == "sloppak"
    assert body["sections"] == [{"name": "verse", "time": 2.0}]

    payload = {
        "title": "My Zip Song",
        "detected_key": "C",
        "chords": [{"symbol": "C", "time": 0.0, "nashville_number": "1", "needs_review": False}],
    }
    post_resp = client.post(f"/api/plugins/{PLUGIN_ID}/nashville/My Zip Song.sloppak", params={"arrangement": 0}, json=payload)
    assert post_resp.status_code == 200
    assert post_resp.json() == {"ok": True, "source": "sloppak"}

    # A .bak of the pristine original is kept, and every other zip member
    # (including the unrelated audio file) survives byte-for-byte.
    bak_path = song_path.with_name(song_path.name + ".bak")
    assert bak_path.exists()
    with zipfile.ZipFile(song_path, "r") as z:
        names = set(z.namelist())
        assert "rhythm.nns.json" in names
        assert z.read("audio.wem") == b"fake-audio-bytes"

    get_after = client.get(f"/api/plugins/{PLUGIN_ID}/nashville/My Zip Song.sloppak", params={"arrangement": 0})
    data = get_after.json()
    assert data["available"] is True
    assert data["source"] == "sloppak"
    assert data["data"]["chords"] == payload["chords"]
    # Phrase names aren't recoverable from the sloppak wire format.
    assert data["data"]["section_markers"] == []


def test_sloppak_directory_form_round_trip(dlc_dir):
    # Sloppak "directory form": same manifest/member layout, unpacked on disk
    # rather than zipped -- routes.py branches on song_path.is_dir().
    song_dir = dlc_dir / "Dir Song.sloppak"
    song_dir.mkdir()
    (song_dir / "manifest.yaml").write_text(yaml.safe_dump({"arrangements": [{"file": "bass.json"}]}), encoding="utf-8")
    (song_dir / "bass.json").write_text('{"sections": []}', encoding="utf-8")

    client = _make_client(dlc_dir)
    payload = {"title": "Dir Song", "detected_key": None, "chords": []}
    post_resp = client.post(f"/api/plugins/{PLUGIN_ID}/nashville/Dir Song.sloppak", params={"arrangement": 0}, json=payload)
    assert post_resp.status_code == 200
    assert (song_dir / "bass.nns.json").exists()


# ── path containment / validation guards ─────────────────────────────────

def test_path_traversal_is_rejected(dlc_dir):
    client = _make_client(dlc_dir)
    resp = client.get(f"/api/plugins/{PLUGIN_ID}/sections/..%2F..%2Fetc%2Fpasswd", params={"arrangement": 0})
    assert resp.status_code in (403, 404)


def test_missing_song_returns_404(dlc_dir):
    client = _make_client(dlc_dir)
    resp = client.get(f"/api/plugins/{PLUGIN_ID}/sections/Does Not Exist", params={"arrangement": 0})
    assert resp.status_code == 404


def test_malformed_payload_is_rejected(dlc_dir):
    song_dir = dlc_dir / "My Song"
    song_dir.mkdir()
    (song_dir / "Official_Rhythm1_abc.xml").write_text(MINIMAL_SONG_XML, encoding="utf-8")
    client = _make_client(dlc_dir)

    resp = client.post(f"/api/plugins/{PLUGIN_ID}/nashville/My Song", params={"arrangement": 0}, json={"chords": "not-a-list"})
    assert resp.status_code == 400
