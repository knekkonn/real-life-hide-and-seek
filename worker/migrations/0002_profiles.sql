CREATE TABLE IF NOT EXISTS account_profiles (
  uid TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 18),
  cosmetic_id TEXT NOT NULL DEFAULT 'lime' CHECK(cosmetic_id IN ('lime','cyan','violet','amber','rose')),
  sound_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sound_enabled IN (0,1)),
  haptics_enabled INTEGER NOT NULL DEFAULT 1 CHECK(haptics_enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);
