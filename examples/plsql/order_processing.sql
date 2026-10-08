-- ----------------------------------------------------------------------------
-- Example Oracle PL/SQL package for the review agent (synthetic - not real code).
-- Tables used: ORDERS, ORDER_LINES, CUSTOMERS.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE PACKAGE order_processing AS

   PROCEDURE close_orders (p_customer_id IN NUMBER);

   FUNCTION get_order_total (p_order_id IN NUMBER) RETURN NUMBER;

   FUNCTION get_customer_name (p_customer_id IN NUMBER) RETURN VARCHAR2;

   PROCEDURE find_orders_by_status (p_status IN VARCHAR2, p_result OUT SYS_REFCURSOR);

   PROCEDURE archive_old_orders (p_days IN NUMBER);

END order_processing;
/

CREATE OR REPLACE PACKAGE BODY order_processing AS

   g_admin_password CONSTANT VARCHAR2(30) := 'Welcome1';

   FUNCTION get_order_total (p_order_id IN NUMBER) RETURN NUMBER IS
      v_total NUMBER;
   BEGIN
      SELECT SUM(quantity * unit_price)
        INTO v_total
        FROM order_lines
       WHERE order_id = p_order_id;

      RETURN v_total;
   END get_order_total;

   FUNCTION get_customer_name (p_customer_id IN NUMBER) RETURN VARCHAR2 IS
      v_name customers.name%TYPE;
   BEGIN
      SELECT name
        INTO v_name
        FROM customers
       WHERE customer_id = p_customer_id;

      RETURN v_name;
   END get_customer_name;

   PROCEDURE close_orders (p_customer_id IN NUMBER) IS
   BEGIN
      FOR rec IN (SELECT order_id
                    FROM orders
                   WHERE customer_id = p_customer_id
                     AND status = 'OPEN')
      LOOP
         UPDATE orders
            SET status = 'CLOSED',
                closed_date = SYSDATE
          WHERE order_id = rec.order_id;

         COMMIT;
      END LOOP;
   EXCEPTION
      WHEN OTHERS THEN
         NULL;
   END close_orders;

   PROCEDURE find_orders_by_status (p_status IN VARCHAR2, p_result OUT SYS_REFCURSOR) IS
      v_sql VARCHAR2(500);
   BEGIN
      v_sql := 'SELECT order_id, customer_id, status FROM orders WHERE status = ''' || p_status || '''';
      OPEN p_result FOR v_sql;
   END find_orders_by_status;

   PROCEDURE archive_old_orders (p_days IN NUMBER) IS
      v_count NUMBER;
   BEGIN
      SELECT COUNT(*)
        INTO v_count
        FROM orders
       WHERE order_date < SYSDATE - p_days;

      FOR i IN 1 .. v_count LOOP
         DELETE FROM orders
          WHERE order_date < SYSDATE - p_days
            AND ROWNUM = 1;
      END LOOP;

      COMMIT;
   END archive_old_orders;

END order_processing;
/
