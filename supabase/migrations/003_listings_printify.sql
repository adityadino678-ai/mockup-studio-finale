-- Migration 003: Listings, printify products, and user settings
-- Applied after designs/mockups sync is working

CREATE TABLE listing_drafts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  design_id UUID REFERENCES designs(id),
  title TEXT,
  description TEXT,
  tags TEXT[],
  price_cents INTEGER,
  image_asset_ids TEXT[],
  image_selection_locked BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE printify_products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  listing_draft_id UUID REFERENCES listing_drafts(id),
  printify_product_id TEXT,
  printify_shop_id INTEGER,
  blueprint_id INTEGER,
  print_provider_id INTEGER,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_settings (
  user_id UUID REFERENCES auth.users PRIMARY KEY,
  printify_api_key_encrypted TEXT,
  printify_shop_id INTEGER,
  etsy_keystring_encrypted TEXT,
  ai_provider_config JSONB,
  preferences JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE listing_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE printify_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their listing drafts" ON listing_drafts
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their printify products" ON printify_products
  FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users own their settings" ON user_settings
  FOR ALL USING (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_listing_drafts_user_id ON listing_drafts(user_id);
CREATE INDEX idx_listing_drafts_updated_at ON listing_drafts(updated_at);
CREATE INDEX idx_printify_products_user_id ON printify_products(user_id);
CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);
