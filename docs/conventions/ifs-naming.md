<!-- applies-to: .projection, .client, .fragment, .plsvc, .plsql -->
# IFS Cloud customization: naming and syntax

Applies to elements, files and branches added in IFS Cloud model files. "C prefix" means a leading
capital `C` on the name; it is required when the element customizes a core element. When a changed
line breaks a rule, report it, name the rule number, and give the corrected name. Severity low.

## Projection elements
- NM1. Entityset: plural of the entity (ShopOrders, People, Companies). If the plural equals the
  singular, add suffix `Set` (InvoiceSeries -> InvoiceSeriesSet). Customization: `C[Name]Set`.
- NM2. Entity / Query: a meaningful name derived from the entity name. Do not use LOV, Query,
  Entity or Qry as prefix or suffix (not `CompanyLov` / `CompanyLovs`; use e.g. `CUserAllowedCompany`
  with entityset `CUserAllowedCompanies`).
- NM3. Attribute: singular, named for its business purpose (Site, not contract; ExpiryDate, not
  ExpDate). Customization: `C[AttributeName]`.
- NM4. Reference: suffix `Ref` (UnitcodeRef). Customization: `C[Name]Ref`.
- NM5. Array: plural; if plural equals singular, suffix `Array`. Customization: `C[Name]Array`.
- NM6. Suffixes, each with C prefix on customizations: Enumeration `Enum`, Structure `Structure`,
  Virtual `Virtual`, Singleton `Singleton`, Summary `Summary`.

## Client elements (all take the C prefix on customizations)
- NM7. Suffix per element: Navigator entry `NavEntry`, Selector `Selector`, Dialog `Dialog`,
  Assistant `Assistant`, Group `Group`, List `List`, Card `Card`, Command `Command`,
  Command group `CmdGroup`, Advanced LOV list `LovList`, Chart `Chart`, Singleton `Singleton`,
  Variable `Var`. Example: `C[ListName]List`.
- NM8. Exception: elements created inside a NEW projection or client that itself starts with `C`
  (e.g. `CCrmCustomerHandling-Cust.projection`, `CCrmCustomer-Cust.client`) do NOT need the C prefix.

## Files
- NM9. Client file `C[ClientName].client`; projection file `C[ClientName]Handling.projection`
  (CCustomerCrm.client, CCustomerCrmHandling.projection).
- NM10. Fragment file `C[FragmentName][FragmentType].fragment`: CPersonDocumentList.fragment (list),
  CEmployeeStatusAssistant.fragment (assistant), CTansferEmployeeDataDialog.fragment (dialog),
  CCustomerLovSelector.fragment (LovView).
- NM11. A projection or fragment created for integration ends with `Service`
  (CMsCrmInterfaceService-Cust.projection).

## Git branch (recommended, not a hard rule - severity low, and only if the branch starts with `topic/`)
- NM12. `topic/[user-id]/M-[CRIM-ID]-[JIRA-ID]-[N]-[Jira_Story_Description]`, e.g.
  `topic/damilk/M-M001-LPS-2345-1-Barcode_Report_Modification`.
