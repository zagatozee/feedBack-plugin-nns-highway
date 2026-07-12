// Talks to routes.py's pre-computed-sidecar endpoints. The sidecar file
// itself lives next to the song's own chart data (see routes.py's module
// docstring for the exact on-disk layout / hard write constraints) — this
// module only knows the HTTP surface.

const PLUGIN_ID = 'nns_highway';

// Returns { available: true, data } | { available: false } | null (network
// failure). Callers treat both `available: false` and `null` identically —
// "no usable pre-computed file" — the distinction only matters for logging.
export async function fetchPrecomputed(filename, arrangementIndex) {
    try {
        const url = `/api/plugins/${PLUGIN_ID}/nashville/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

// payload must match extract_nashville_numbers.py's extract_song_data()
// schema minus section_markers (the backend fills that in itself by
// re-reading the arrangement's own phrase data — see routes.py — since the
// frontend has no access to phrase names via the WS bundle).
// Returns true on confirmed success, false otherwise (never throws) — the
// caller's contract is "best-effort persistence," not a blocking operation.
export async function savePrecomputed(filename, arrangementIndex, payload) {
    try {
        const url = `/api/plugins/${PLUGIN_ID}/nashville/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return res.ok;
    } catch (e) {
        return false;
    }
}
