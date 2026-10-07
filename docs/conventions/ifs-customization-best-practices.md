<!-- applies-to: .projection, .client, .fragment, .plsvc, .plsql -->
# IFS Cloud customization: best practices

Applies to IFS Cloud customization files. "Extending on the inside" is invasive and must be done
carefully. When a changed line breaks a rule, report it and name the rule number.

- BP1. Never change core files. Changes go only in customization-layer files whose name contains
  the `-Cust` suffix (e.g. `CCrmCustomerHandling-Cust.projection`). An existing IFS file modified
  without `-Cust` in its name is a violation. Severity high.
- BP2. Never make a customization depend on configuration (for example business logic that uses a
  custom attribute added through configuration - it risks deployment and installation failures).
  Add that attribute as part of the customization itself. Severity medium.
- BP3. Never mark a projection that is added or modified by a customization as a premium API;
  the Premium API class is reserved for IFS. Severity high.
- BP4. Use `@overtake` only as a last resort: it branches the standard code, and the customizer must
  keep that copy updated through every future release and service update. Prefer `@override`.
  Any added `@overtake` is a finding asking whether `@override` would do. Severity medium.
- BP5. Follow the naming guidelines (rules NM1-NM12) for everything added: components, pages,
  entities, attributes and other elements.
