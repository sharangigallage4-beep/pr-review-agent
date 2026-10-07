<!-- applies-to: .projection, .client, .fragment, .plsvc, .plsql -->
# IFS Cloud customization: comments

Applies to IFS Cloud Projection, Client, Fragment, PLSVC and PLSQL customization files. When a
changed line breaks a rule below, report it and name the rule number (e.g. "Rule CM3").

- CM1. New Projection, Client and PLSVC files keep the header comment generated from cust plsvc:
  Logical unit, Component, "IFS Developer Studio Template Version", and a history line
  `Date  Sign  M-[CRIM-ID]-[JIRA-ID]-[N]: description`. Severity low.
- CM2. Inline comments in Projection and Client files use `//`.
- CM3. All new customized code is wrapped in a start tag and a finish tag:
  `//(+)[YYMMDD] [Sign] M-[CRIM-ID]-[JIRA-ID]-[N](start)` ... `//(+)[YYMMDD] [Sign] M-[CRIM-ID]-[JIRA-ID]-[N](finish)`
  Example: `//(+)230203 damilk M-M001-LPS-2345-1(start)`. New code with no tags, or only one of the
  two tags, is a violation. Severity medium.
- CM4. In PLSVC and PLSQL files the same tags are used with `--` instead of `//`:
  `--(+)230203 damilk M-M001-LPS-2345-1(start)`.
- CM5. Removing existing code: wrap it in `(-)` start/finish tags (`//(-)YYMMDD Sign M-...-N(start)`).
- CM6. Modifying existing code: wrap the change in `(-/+)` start/finish tags (`//(-/+)YYMMDD Sign M-...-N(start)`),
  keep the original lines commented out (`//`) inside the block, and put the new code right below them.
- CM7. The finish tag repeats the date, sign and ID of its start tag.
- CM8. Comments sit on the same indentation level as the code they concern.
- CM9. When an override or overtake comes from an included fragment, add a comment naming the
  fragment and its path, right under the start tag and above the `@Override`/`@Overtake` line:
  `//From RMCOM/ AddBusinessObjectContactAssistant.fragment`. Severity low.

Older tags in untouched code (e.g. `//(+) 191017 SAJILK C_DIS502-11(START)`) are legacy; never flag
lines the diff did not add or change.
