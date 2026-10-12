<!-- applies-to: .sql, .pks, .pkb, .pls, .plsql, .plsvc -->
# Oracle PL/SQL: character sets and collation

Rules from the Oracle PL/SQL Language Reference, "Character Sets". When a changed line breaks one,
report it and name the rule number (e.g. "Rule OC4").

- OC1. Write PL/SQL source (code, identifiers, comments) with only the basic characters: Latin letters
  A-Z and a-z, digits 0-9, whitespace, and the punctuation `( ) < > + - * / = , ; : . ! ? ' " @ % # $ _ |`.
  Source text is stored in the database character set, so a unit containing any other character
  (accented letters, symbols, non-Latin scripts) only compiles in a database whose character set
  supports it. Severity low; medium if such a character is in an identifier.
- OC2. CHAR, VARCHAR2, CLOB and LONG values use the database character set; NCHAR, NVARCHAR2 and NCLOB
  values use the national character set. Report assignments or comparisons that mix the two families
  (for example VARCHAR2 with NVARCHAR2) where characters could be lost in the conversion. Severity low.
- OC3. All data in PL/SQL expressions has the collation USING_NLS_COMP, so `=`, `INSTR` and ordering
  follow the session settings NLS_COMP and NLS_SORT. Report logic that relies on a fixed case- or
  accent-sensitive result without setting or documenting those parameters. Severity low.
- OC4. A package, stored procedure, stored function, trigger or type must have the default collation
  USING_NLS_COMP. A `DEFAULT COLLATION` clause on such a unit that names anything else is a defect.
  Severity medium.
- OC5. SQL embedded in PL/SQL, or built dynamically inside it, fully applies the collation of the
  columns and expressions involved, which can differ from the PL/SQL rule in OC3. Report code that
  assumes the same comparison result in a PL/SQL expression and in a SQL statement. Severity low.

Source: https://docs.oracle.com/en/database/oracle/oracle-database/26/lnpls/character-sets.html
