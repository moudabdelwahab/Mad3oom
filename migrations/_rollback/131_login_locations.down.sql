-- Rollback for 131_login_locations.sql — removes the login locations table
-- (policies and the index go away with it). Captured locations are deleted
-- with the table; re-applying 131 recreates it empty.
DROP TABLE IF EXISTS public.login_locations;
