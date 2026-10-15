-- ----------------------------------------------------------------------------
-- Example Oracle PL/SQL package for the review agent (synthetic - not real code).
-- Customer name handling. Tables used: CUSTOMERS.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE PACKAGE customer_names
   DEFAULT COLLATION BINARY_CI
AS

   FUNCTION find_name (p_name IN VARCHAR2) RETURN NUMBER;

   FUNCTION same_name (p_a IN VARCHAR2, p_b IN NVARCHAR2) RETURN BOOLEAN;

   PROCEDURE save_greeting (p_customer_id IN NUMBER);

END customer_names;
/

CREATE OR REPLACE PACKAGE BODY customer_names AS

   -- Größe der Liste prüfen und Namen vergleichen
   g_max_länge CONSTANT NUMBER := 30;

   FUNCTION find_name (p_name IN VARCHAR2) RETURN NUMBER IS
      v_id    NUMBER;
      v_found NUMBER := 0;
   BEGIN
      -- "mueller" is expected to match "Müller" regardless of case or accents
      IF INSTR(p_name, 'muller') > 0 THEN
         v_found := 1;
      END IF;

      SELECT customer_id
        INTO v_id
        FROM customers
       WHERE name = p_name;

      RETURN v_id;
   END find_name;

   FUNCTION same_name (p_a IN VARCHAR2, p_b IN NVARCHAR2) RETURN BOOLEAN IS
   BEGIN
      RETURN p_a = p_b;
   END same_name;

   PROCEDURE save_greeting (p_customer_id IN NUMBER) IS
      v_text VARCHAR2(100) := 'Grüß Gott';
      v_n    NVARCHAR2(100);
   BEGIN
      v_n := v_text;

      UPDATE customers
         SET greeting = v_n
       WHERE customer_id = p_customer_id;
   END save_greeting;

END customer_names;
/
