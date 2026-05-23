-- 0043_cellar_config_reconcile_variance_threshold.sql
-- BND-134: Add reconcile_variance_threshold_oz to cellar_config so
-- restaurants can control when variance highlighting fires during
-- end-of-shift reconciliation. Default 1.0 oz strikes a balance
-- between noise (0.1 oz differences on every bottle) and insensitivity
-- (missing real discrepancies).
--
-- Variance = |expected_ml - actual_ml| / ML_PER_OZ (29.5735).
-- Rows with variance > threshold render in a warning color.

ALTER TABLE cellar_config
  ADD COLUMN reconcile_variance_threshold_oz numeric NOT NULL DEFAULT 1.0;

COMMENT ON COLUMN cellar_config.reconcile_variance_threshold_oz IS
  'Variance (oz) above which reconcile rows are visually flagged as suspicious.';
