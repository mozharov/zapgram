-- Before this release last_hash stored the last successful donation, not an in-flight invoice.
-- No pending hashes exist yet; clear legacy hashes so they cannot skip the next monthly charge.
UPDATE `users` SET `monthly_donation_last_hash` = NULL;
