-----------------------------------------------------------------------------
--
--  Logical unit: PurchOrderUtil
--  Component:    PURCH
--
--  Example file for the review agent (synthetic - not real IFS code).
--
--  Date    Sign     History
--  ------  ------   ---------------------------------------------------------
--  260101  tester   M-M001-LPS-1000-1: Added Check_Order___
-----------------------------------------------------------------------------

layer Cust;

--(+)260101 tester M-M001-LPS-1000-1(start)
FUNCTION Check_Order___ (
   order_no_ IN VARCHAR2 ) RETURN BOOLEAN
IS
BEGIN
   RETURN order_no_ IS NOT NULL;
END Check_Order___;
--(+)260101 tester M-M001-LPS-1000-1(finish)

//(+)260301 tester M-M001-LPS-2000-1(start)
FUNCTION Is_Open___ (
   order_no_ IN VARCHAR2 ) RETURN BOOLEAN
IS
BEGIN
   RETURN TRUE;
END Is_Open___;
--(+)260301 tester M-M001-LPS-9999-1(finish)

--(+)260302 tester M-M001-LPS-2001-1(start)
PROCEDURE Close_Order___ (
   order_no_ IN VARCHAR2 )
IS
BEGIN
   NULL;
END Close_Order___;
