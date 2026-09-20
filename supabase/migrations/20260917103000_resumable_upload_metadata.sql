-- Staged metadata support for the gated browser-direct resumable upload path.
-- This file is unapplied and does not change the Storage bucket or billing plan.
-- Keep production RESUMABLE_UPLOAD_ENABLED=false. Before controlled acceptance,
-- add atomic tenant quota enforcement and abandoned-upload cleanup, configure
-- the project and private-bucket limits for the same maximum, and then run the
-- real resume, access, quota and cleanup tests with the feature temporarily on.
-- Enable ordinary production use only after that controlled run passes.

alter table public.client_documents
  drop constraint if exists client_documents_size_bytes_check;

alter table public.client_documents
  add constraint client_documents_size_bytes_check
  check (size_bytes between 1 and 50000000);

comment on constraint client_documents_size_bytes_check on public.client_documents is
  'Allows metadata for files up to 50,000,000 bytes; Storage limits still apply independently.';
