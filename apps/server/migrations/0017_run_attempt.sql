-- Each claim of a run is an attempt. The commit and the heartbeat both check
-- the attempt they belong to, so a worker whose lease expired mid-job cannot
-- apply results after a replacement has taken the run over.
ALTER TABLE app.runs ADD COLUMN attempt uuid;
