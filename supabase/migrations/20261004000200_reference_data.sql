-- =====================================================================
-- Reference data required in every environment (not demo data).
-- Values come from the prototype's lists.
-- =====================================================================

insert into designations (name, rank, grants_full_access) values
  ('Junior Accountant', 10, false),
  ('Accountant',        20, false),
  ('Senior Accountant', 30, false),
  ('Manager',           40, false),
  ('Senior Manager',    50, false),
  ('Director',          60, true),
  ('Partner',           70, true);

insert into categories (name, sort_order) values
  ('Mandatory Compliance', 10),
  ('Structured CPD',       20),
  ('Unstructured CPD',     30),
  ('Technical Skills',     40),
  ('Soft Skills',          50),
  ('Ethics',               60),
  ('Regulation & Law',     70);

insert into cpd_types (name, sort_order) values
  ('Structured CPD',       10),
  ('Unstructured CPD',     20),
  ('Mandatory Compliance', 30),
  ('Other',                40);

insert into delivery_types (name, sort_order) values
  ('eLearning',             10),
  ('Internal Training',     20),
  ('Webinar',               30),
  ('External Seminar',      40),
  ('Workshop',              50),
  ('Online Course',         60),
  ('Self-Study / Reading',  70),
  ('Conference',            80);

-- First programme year so the platform is usable immediately.
insert into learning_cycles (year, name, starts_on, ends_on, is_current)
values (2026, '2026 programme', '2026-01-01', '2026-12-31', true);
