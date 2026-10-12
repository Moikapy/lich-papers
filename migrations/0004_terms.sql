-- When the user accepted the Terms of Service and Privacy Policy, and which version.
ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER;
ALTER TABLE users ADD COLUMN terms_version TEXT;
