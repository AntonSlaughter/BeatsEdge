// Single source of truth for where BeatsEdge's two SQLite files live.
//
// Local dev (no BEATSEDGE_DATA_DIR set): unchanged from before this module
// existed -- resolves to this repo's own ./data directory, exactly the path
// every db-opening file used to hardcode.
//
// Production (BEATSEDGE_DATA_DIR=/var/data, pointed at a Render persistent
// disk mount): resolves there instead, so the databases survive a deploy/
// restart instead of resetting to whatever Git shipped.
//
// Every file that opens beatsedge.db or snapshots.db should get its path
// from here -- never hardcode `path.join(__dirname, '..', 'data', ...)`
// again, so there is exactly one place that knows the rule.

const path = require('path');

const REPO_DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_DIR = process.env.BEATSEDGE_DATA_DIR
  ? path.resolve(process.env.BEATSEDGE_DATA_DIR)
  : REPO_DATA_DIR;

const BEATSEDGE_DB_PATH = path.join(DATA_DIR, 'beatsedge.db');
const SNAPSHOTS_DB_PATH = path.join(DATA_DIR, 'snapshots.db');

// The Git-shipped baseline copy, regardless of where BEATSEDGE_DATA_DIR
// points production at. This is NOT a new file and NOT a new commit --
// it's the same data/beatsedge.db already tracked in this repo, used only
// as a same-once fallback seed source (see ensureDataInitialized below).
const REPO_SEED_BEATSEDGE_DB = path.join(REPO_DATA_DIR, 'beatsedge.db');

module.exports = {
  DATA_DIR,
  BEATSEDGE_DB_PATH,
  SNAPSHOTS_DB_PATH,
  REPO_DATA_DIR,
  REPO_SEED_BEATSEDGE_DB,
  usingCustomDataDir: DATA_DIR !== REPO_DATA_DIR
};
