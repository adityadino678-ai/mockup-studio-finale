-- Migration 002: Designs and mockups (mirrors local IndexedDB to Supabase)
-- Applied after core auth is working

CREATE TABLE designs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  name TEXT NOT NULL,
  original_asset_id TEXT,
  processed_asset_id TEXT,
  white_ink_asset_id TEXT,
  black_ink_asset_id TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE mockups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  name TEXT NOT NULL,
  category TEXT,
  asset_id TEXT NOT NULL,
  print_area JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mockups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their designs" ON designs
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their mockups" ON mockups
  FOR ALL USING (auth.uid() = user_id);

-- Indexes for sync queries
CREATE INDEX idx_designs_user_id ON designs(user_id);
CREATE INDEX idx_designs_updated_at ON designs(updated_at);
CREATE INDEX idx_mockups_user_id ON mockups(user_id);
CREATE INDEX idx_mockups_updated_at ON mockups(updated_at);
