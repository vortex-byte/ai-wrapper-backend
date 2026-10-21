-- 0017 — quota_ledger: allow 'rebase' entry type for policy updates applied to current period
--
-- Rebasing an account's base limit when an admin updates a policy should be tracked in the
-- ledger without being misclassified as an adjustment to adjustment_tokens during reconciliation.

ALTER TABLE quota_ledger
  DROP CONSTRAINT IF EXISTS quota_ledger_entry_type_check;

ALTER TABLE quota_ledger
  ADD CONSTRAINT quota_ledger_entry_type_check
  CHECK (entry_type IN ('period_open','reserve','settle','release','expire_release','adjust','grant','rebase'));
