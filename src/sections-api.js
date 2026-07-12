// Talks to routes.py's backend route, which reads the SPECIFIC arrangement's
// own section markers directly from disk (arrangement XML for loose-folder
// songs, arrangements/<id>.json for sloppak) — see the project brief for why
// this can't be done from the WS bundle alone: `bundle.sections` is
// song-level only, sourced from a single arrangement file chosen by core
// during load (first XML alphabetically / first manifest entry), not
// necessarily the one the player currently has selected.

const PLUGIN_ID = 'nns_highway';

// Returns [{name, time}] on success, or null on any failure (network error,
// 404, unrecognized format, arrangement has no section data at all) — the
// caller's contract is: null means "fall back to bundle.sections and mark
// the result uncertain," never a thrown error the render loop has to guard.
export async function fetchAccurateSections(filename, arrangementIndex) {
    try {
        const url = `/api/plugins/${PLUGIN_ID}/sections/${encodeURIComponent(filename)}?arrangement=${encodeURIComponent(arrangementIndex)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !Array.isArray(data.sections)) return null;
        return data.sections;
    } catch (e) {
        return null;
    }
}
