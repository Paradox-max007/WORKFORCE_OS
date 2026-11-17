# **PRD: Workforce OS – Advanced Excel-Style Timesheet Editor**

**Project:** [WORKFORCE_OS GitHub repository](https://github.com/Paradox-max007/WORKFORCE_OS?utm_source=chatgpt.com)

**Module:** Sites → Timesheet Excel

**Objective:** Upgrade the existing timesheet spreadsheet into a fully functional, Excel-like spreadsheet editor inside Workforce OS, without purchasing Microsoft Excel, third-party subscriptions, or paid spreadsheet APIs.

The goal is not to build a simple editable table. It is to build a controlled version of Excel that supports real spreadsheet operations, formulas, formatting, row and column manipulation, keyboard shortcuts, undo/redo, saving, and PDF/Excel zoom.

The existing timesheet and its business logic must remain intact.

## **1. Important architecture decision**

Do not build the spreadsheet engine from scratch.

Use an open-source spreadsheet/grid engine and integrate it into the existing Sites page. This will significantly reduce development time and prevent bugs in formula calculations, cell selection, keyboard navigation, and resizing.

One important distinction: **free to use does not always mean free for closed-source commercial software.** The developer must verify the exact licence of every dependency before integrating it.

### **Recommended technology**



MIT – free for commercial use

[**FortuneSheet**](https://github.com/ruilisi/fortune-sheet?utm_source=chatgpt.com)



I recommend evaluating FortuneSheet as the primary spreadsheet engine.

It is an open-source React spreadsheet library with:

- Cell editing and formula calculations.
- Multiple cell selection.
- Formatting, fonts, colours and borders.
- Merged cells.
- Row and column operations.
- Copy, cut and paste.
- Undo and redo.
- Excel import/export through its associated plugin.
- APIs for connecting spreadsheet operations to backend storage.

Its repository identifies the project as MIT licensed.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://github.com\&sz=32)

GitHub+1



An alternative worth benchmarking is [OpenSheets](https://opensheets.dev/?utm_source=chatgpt.com). It has explicit support for row/column resizing, virtualized rendering, formula evaluation and undo/redo, and is MIT licensed.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://opensheets.dev\&sz=32)

a spreadsheet component for React+1



**Implementation decision:** Start with a small proof of concept using FortuneSheet. Test it against your actual timesheet, including formulas, merges, formatting and export. If its limitations make the required experience difficult, benchmark OpenSheets before committing. Do not purchase any Pro or Enterprise add-ons.

# **2. Product requirements**

## **2.1 Excel-style interface**

Replace the current basic spreadsheet with a complete spreadsheet workspace.

[Introducing Microsoft Excel: IU Only: Files: Excel: The Basics: All Training Topics: UITS IT Training Content Library: Indiana University](https://images.openai.com/static-rsc-4/Oxj8BCVn4munKW0DglJGILNZyWEYjpDBt3yvfn4-F0tIrQwOHBvEGGRmX2G8VJIc2xPz1urc5AFRxyzpuRKHzFBBiWCC_Wj0lh9ojBwK8wYhO9ysTrxzq0fiO86muRsLY-oDm9yJK4suokDFFfgiYD6jcxRUYR20IWvyzcT173w?purpose=inline)

[Excel Web: Phiên bản Excel online miễn phí dành cho mọi đối tượng](https://images.openai.com/static-rsc-4/a4Ag8ilcDCt933ZGFt_KFcnt69WWQ9GNdcTpMANZT15mzI6OgvZ1H54bfmL8WTd0jNt4qbg6oQkJqJ1B5zQJoz9nkrHgxcLVgd9_HXI47pzYQGPtyfCCAgYRDnC-yeafoWc3SbP75Oae-Mpb9jPm0bY0Lvn62lWagkIipaH8i7g?purpose=inline)

[Learn Text, Alignment, and Reusable Formatting | Presenting Data Like a Pro](https://images.openai.com/static-rsc-4/d_BGCo1WZQP_o1wjtm93bmW3dVw0Ppz56lNh_4pWO6hR_L0Xwks7uhs2dxlObdMGNuyBuaOpI_Rw2wIHKHVhD1kfYX47WF-lMiZVV2S1QKUqyKlZQMV6gxug6Zd448xWDtSEaBIzyWeNv0HFVKx-i2VxTv_wP4kyZyj9tPtxVAo?purpose=inline)

6

The interface should have:

1. Spreadsheet toolbar.
2. Formula bar.
3. Name box (A1, B5, etc.).
4. Column headers (A, B, C...).
5. Row numbers (1, 2, 3...).
6. Editable cells.
7. Sheet tabs.
8. Horizontal and vertical scrolling.
9. Zoom controls.
10. Save status indicator.

The existing Workforce OS theme should be applied. Do not make the spreadsheet look like an external application embedded inside the website.

## **2.2 Right-click context menu**

Right-clicking a cell should open a context menu.

[Format cells | Excel Insights](https://images.openai.com/static-rsc-4/lFuH00BQvmQr2BKSSDPZ4xpc_Yez1mLXIAYfrJOrpflJSIOturF-FOmYg0KE8mbQL-jcwk-ijD6b3Umc1XWg8Z7rRoBXWFb_ZagFHyvzKkKpbYuSNRHpj_t454OVFGDxFbRhP56LK8FcbDgM3PnOb1mSX2SDL43BQyLJvZ2XjH0?purpose=inline)

[excelinsights.net](https://excelinsights.net/web/format-cells-web/?utm_source=chatgpt.com)

Required actions:

| Action              | Expected behaviour                        |
| ------------------- | ----------------------------------------- |
| Insert row above    | Add a row before selected row             |
| Insert row below    | Add a row after selected row              |
| Insert column left  | Add a column before selected column       |
| Insert column right | Add a column after selected column        |
| Delete row          | Delete selected row(s)                    |
| Delete column       | Delete selected column(s)                 |
| Delete cells        | Show appropriate shift options            |
| Cut                 | Cut selected cells                        |
| Copy                | Copy selected cells                       |
| Paste               | Paste copied data                         |
| Clear contents      | Remove values without removing formatting |
| Clear formatting    | Remove formatting without removing values |
| Format cells        | Open formatting options                   |

Additional requirements:

- Support selecting multiple rows or columns.
- Context menu must work with both single cells and selected ranges.
- Confirm destructive operations where necessary.
- Update formula references when inserting or deleting rows and columns.
- Do not allow browser default right-click behaviour inside the spreadsheet.

## **2.3 Keyboard shortcuts**

All shortcuts must work within the spreadsheet without triggering unwanted browser actions.

| Shortcut   | Function                                    |
| ---------- | ------------------------------------------- |
| Ctrl + C   | Copy                                        |
| Ctrl + V   | Paste                                       |
| Ctrl + X   | Cut                                         |
| Ctrl + Z   | Undo                                        |
| Ctrl + Y   | Redo                                        |
| Ctrl + S   | Save                                        |
| Ctrl + A   | Select all cells                            |
| Ctrl + B   | Bold                                        |
| Ctrl + I   | Italic                                      |
| Ctrl + U   | Underline                                   |
| Ctrl + F   | Find                                        |
| Ctrl + H   | Find and replace                            |
| Delete     | Clear cell contents                         |
| Enter      | Edit/confirm cell                           |
| Tab        | Move to next cell                           |
| Arrow keys | Navigate cells                              |
| Ctrl + +   | Insert cells/rows/columns where appropriate |
| Ctrl + -   | Delete cells/rows/columns where appropriate |
| Escape     | Cancel current editing/selection            |

Important:

- Ctrl + Z must reverse the most recent operation, including formatting, row insertion, deletion and resizing.
- Ctrl + S must save to the database, not merely download a file.
- Copy/paste must support multiple cells and ranges.
- Copy/paste from external Excel files should preserve values and, where supported, formatting.
- Clipboard access must have a fallback for browser permission restrictions.

## **2.4 Undo and redo engine**

Every spreadsheet operation must be recorded in a history stack.

Operations include:

- Cell value changes.
- Formula changes.
- Formatting changes.
- Font and colour changes.
- Row and column insertion.
- Row and column deletion.
- Row height changes.
- Column width changes.
- Cell merging and unmerging.
- Copy/paste.
- Sheet changes.

Requirements:

1. Undo must restore the previous state.
2. Redo must restore the undone state.
3. Undo must not affect other timesheets.
4. Saving must not clear undo history during the current editing session.
5. Reloading the page should restore saved data, but does not need to restore the previous session's undo history in the first release.

# **3. Formula engine**

Core requirement

The spreadsheet must behave like a real spreadsheet when entering formulas.

### **3.1 Formula examples**

| Formula                        | Expected result     |
| ------------------------------ | ------------------- |
| `=SUM(A1:A31)`                 | Total of A1 to A31  |
| `=AVERAGE(A1:A31)`             | Average             |
| `=COUNT(A1:A31)`               | Count numeric cells |
| `=MIN(A1:A31)`                 | Minimum             |
| `=MAX(A1:A31)`                 | Maximum             |
| `=IF(A1>0,"Present","Absent")` | Conditional result  |
| `=A1+B1`                       | Addition            |
| `=A1-B1`                       | Subtraction         |
| `=A1*B1`                       | Multiplication      |
| `=A1/B1`                       | Division            |

### **3.2 Live calculation**

Example:

- A1 = 100
- A2 = 200
- A3 = 300
- A4 = `=SUM(A1:A3)`

[Hàm Excel cơ bản thường được sử dụng chi tiết có ví dụ mới nhất 2026](https://images.openai.com/static-rsc-4/7ve69GC3vMML6X7HbKZY0-uBtu8x634OnCqQ6ahjdjYaoVes3nCbjUmsPuP-gERzYiQxvLNhzJpe5RP8hWphMTC8yQ61LPbB4V6xd4H9uQ24e72CVxciTIK1fPP5w_MRDEUVO3fWihZ1ayUSEmwxfKvCfTLS1n4KQLXnP0A7_ZQ?purpose=inline)

[dienmayxanh.com](https://www.dienmayxanh.com/kinh-nghiem-hay/tong-hop-cac-ham-co-ban-trong-excel-thuong-duoc-su-1363094?utm_source=chatgpt.com)

Expected result: A4 displays 600.

If A2 changes from 200 to 500, A4 automatically changes to 900.

### **3.3 Formula requirements**

- Recalculate dependent formulas immediately after cell changes.
- Support cell references.
- Support cell ranges.
- Support absolute references such as `$A$1`.
- Support formulas referencing other sheets.
- Detect circular references.
- Show appropriate formula errors.
- Preserve formulas when exporting and importing Excel files.
- Never silently replace formulas with calculated values during ordinary editing.

**Important:** Do not calculate formulas manually using JavaScript `eval()`. Use the spreadsheet engine's formula evaluator.

# **4. Formatting and Excel-like editing**

The user must be able to format the spreadsheet without restrictions imposed by the old timesheet component.

[Learn Text, Alignment, and Reusable Formatting | Presenting Data Like a Pro](https://images.openai.com/static-rsc-4/d_BGCo1WZQP_o1wjtm93bmW3dVw0Ppz56lNh_4pWO6hR_L0Xwks7uhs2dxlObdMGNuyBuaOpI_Rw2wIHKHVhD1kfYX47WF-lMiZVV2S1QKUqyKlZQMV6gxug6Zd448xWDtSEaBIzyWeNv0HFVKx-i2VxTv_wP4kyZyj9tPtxVAo?purpose=inline)

[codefinity.com](https://codefinity.com/courses/v2/618143fb-7d63-45d6-9f55-ffb93b1bcdbf/a4bb89cb-7ac3-455a-b29f-8e5e6ee732f1/40323149-7a05-4c29-86d8-e722d59e1516?utm_source=chatgpt.com)

### **4.1 Font formatting**

Support:

- Font family.
- Font size.
- Bold.
- Italic.
- Underline.
- Strikethrough.
- Font colour.
- Background/fill colour.
- Text alignment.
- Vertical alignment.
- Text wrapping.
- Text rotation.

### **4.2 Borders**

Support:

- All borders.
- Outside borders.
- Inside borders.
- Top border.
- Bottom border.
- Left border.
- Right border.
- Border colour.
- Border thickness and style.

### **4.3 Cell operations**

Support:

- Merge cells.
- Unmerge cells.
- Merge horizontally.
- Merge vertically.
- Horizontal alignment.
- Vertical alignment.
- Number formats.
- Date formats.
- Currency formats.
- Percentage formats.
- Decimal places.
- Text formatting.

### **4.4 Resize rows and columns**

This is mandatory.

**Column resizing:**

- Drag the boundary between column headers.
- Display the current width while dragging.
- Double-click the boundary to auto-fit contents.
- Save the width to the database.

**Row resizing:**

- Drag the boundary between row numbers.
- Display the current height.
- Double-click to auto-fit row contents.
- Save the height to the database.

The dimensions must remain unchanged after:

- Saving.
- Reloading the page.
- Navigating away and returning.
- Exporting and reopening the Excel file, where supported by the XLSX format.

### **4.5 Additional spreadsheet functionality**

Include:

- Freeze top rows.
- Freeze left columns.
- Hide/unhide rows.
- Hide/unhide columns.
- Find and replace.
- Sort ascending/descending.
- Filter.
- Select multiple ranges.
- Autofill.
- Drag-and-fill cells.
- Sheet rename.
- Add/delete sheets.
- Duplicate sheets.

# **5. Excel file import and export**

The spreadsheet should support standard Excel files.

[Excel File Icon #176932 - Free Icons Library](https://images.openai.com/static-rsc-4/QvlDXJkooYxSWIUnHjybM2_eRaG1ZdtLz6bIFsZQuBFnQ9T6hvU48_zpbIgxyI858rM-JprYEojAc7Hdhn9982KmU00fHcJmQ8RqmJDLauCerROu2MKgzIQdT9DijpfpKOxbrc95RgmniT9In9HQaHHzEtkti6vUvl8TfXC8T-k?purpose=inline)

**Import Excel**

Upload .xlsx files and load their worksheets into the editor.

[Vector green icon XLSX. File format extensions icon.](https://images.openai.com/static-rsc-4/41D78gYBSGVvxdPWoz40Qxq8Sr0kRYPgeHjeLUZSxVYGkD3FLktFB-_P1DGbqvTWV-EgsGxU2LAFks99ZB4lC1HGg7wZPIxK7wNMVB0kGSWhGs-wFmblpYF0LWWXwwMRxfYcT-ECmhIrkfCLjynh1qCZOzKKiSY8qSAxvUzcoRNO1oQxWlszGGkBM1Ltr95O?purpose=inline)

**Export Excel**

Download the edited workbook as a genuine .xlsx file.

### **Import requirements**

Support:

- `.xlsx`
- `.csv`

Import should preserve, where supported:

- Cell values.
- Formulas.
- Font formatting.
- Background colours.
- Borders.
- Merged cells.
- Row heights.
- Column widths.
- Multiple sheets.
- Number formats.

### **Export requirements**

Export must preserve the same workbook properties as far as the selected XLSX library supports them.

Do not generate an Excel file by simply renaming a CSV file to `.xlsx`.

Use a genuine XLSX writer.

# **6. Zoom functionality for Excel and PDF**

Zoom must be implemented independently for the spreadsheet and PDF viewer.

[【エクセルとは】画面構成「名称と機能」をわかりやすく解説｜初心者向き | ちあきめもblog](https://images.openai.com/static-rsc-4/iIlG0jctA7tD9AvibB4ATIFh0jtWnejcJucBcXukbHa2sZX4QzwgKUvXVtLFXLXj4QeoDnDeoH0NN9Dfhf8V-pMI2nJ3LhaIGWq81VF3bixzS8vdoAT_MLFe6sewHHvOWO-XXHlaoY64IDHb4rcoP_7w-V-kl23krd_lJjPx2hM?purpose=inline)

[chiakimemoblog.com](https://chiakimemoblog.com/excel_screenname?utm_source=chatgpt.com)

### **6.1 Excel zoom**

Add controls at the bottom-right of the spreadsheet.

- Zoom out button.
- Zoom percentage display.
- Zoom slider.
- Zoom in button.
- Reset zoom button.

| Property     | Requirement |
| ------------ | ----------- |
| Minimum zoom | 50%         |
| Maximum zoom | 200%        |
| Default zoom | 100%        |
| Step         | 10%         |

Zoom must scale the spreadsheet visually without changing the actual stored row heights, column widths or cell data.

### **6.2 PDF zoom**

[Magnification in ASP.NET Core PDF Viewer | Syncfusion](https://images.openai.com/static-rsc-4/LfIbxR1a88mZ_4NibyFaqvWR0bBUrPG56LI-x9QdFRLJpjNxI9qbc-PcSe-2D3s5_IaUFZMBMQyX3T7agA9yHEX1Lcx4QSLLCu2y73B_TdogxCucPCAbFN4LGlVe6WOaosD_dZBTVI-y4Yf0roTzE7SVL9RFHy_pSAw0rprHTRs?purpose=inline)

[help.syncfusion.com](https://help.syncfusion.com/document-processing/pdf/pdf-viewer/asp-net-core/magnification?utm_source=chatgpt.com)

The PDF viewer should support:

- Zoom in.
- Zoom out.
- Percentage display.
- Fit to width.
- Fit to page.
- Actual size.
- Full-screen view.
- Page navigation.

PDF zoom must not change the Excel zoom setting.

Recommended free PDF rendering technology: Mozilla PDF.js.

# **7. Timesheet business logic – extremely important**

This is where the implementation must be careful.

You are not creating an independent Excel application. You are upgrading the existing Workforce OS timesheet.

The existing timesheet contains business data and calculations used elsewhere in the application.

Therefore, separate the spreadsheet engine from the Workforce OS business rules.

### **7.1 Preserve existing functionality**

The following must continue working:

- Site-based employee listing.
- Employee attendance.
- Daily working hours.
- Monthly timesheets.
- Employee transfers between sites.
- Existing attendance calculations.
- Salary and payroll calculations.
- Existing PDF generation.
- Existing employee information.

### **7.2 Spreadsheet editing versus business data**

Not every cell should automatically be editable.

Introduce three cell categories:

| Category               | Behaviour                                   |
| ---------------------- | ------------------------------------------- |
| Editable cells         | User can modify values and formulas         |
| Calculated cells       | Formula-driven and protected where required |
| System-generated cells | Managed by Workforce OS business logic      |

However, administrators should be able to configure which columns and cells can be edited.

### **7.3 Protect important calculations**

For example:

If employee working hours are generated from attendance records, manually changing a spreadsheet cell must not silently modify the original attendance record.

The application must clearly distinguish between:

- Changing a displayed spreadsheet value.
- Changing the original attendance record.
- Changing a formula.
- Changing a payroll-related value.

Any edit that changes underlying attendance or payroll data must go through the existing authorized business logic and permissions.

This prevents accidental salary and attendance corruption.

# **8. Database architecture – Supabase**

Use the existing Supabase project. Do not create a separate paid database or external spreadsheet service.

I recommend separating workbook configuration, sheet data and revision history.

### **8.1 Proposed database tables**

First inspect the existing timesheet tables and reuse them wherever possible. These are proposed logical structures, not instructions to create duplicate tables.

**A.&#x20;**`timesheet_workbooks`

| Column        | Type        |
| ------------- | ----------- |
| id            | UUID        |
| site_id       | UUID        |
| workbook_name | TEXT        |
| month         | INTEGER     |
| year          | INTEGER     |
| created_by    | UUID        |
| updated_by    | UUID        |
| created_at    | TIMESTAMPTZ |
| updated_at    | TIMESTAMPTZ |
| version       | INTEGER     |

**B.&#x20;**`timesheet_sheets`

| Column            | Type        |
| ----------------- | ----------- |
| id                | UUID        |
| workbook_id       | UUID        |
| sheet_name        | TEXT        |
| sheet_order       | INTEGER     |
| sheet_data        | JSONB       |
| row_dimensions    | JSONB       |
| column_dimensions | JSONB       |
| merged_cells      | JSONB       |
| zoom_level        | NUMERIC     |
| created_at        | TIMESTAMPTZ |
| updated_at        | TIMESTAMPTZ |

**C.&#x20;**`timesheet_revisions`

| Column         | Type        |
| -------------- | ----------- |
| id             | UUID        |
| workbook_id    | UUID        |
| version        | INTEGER     |
| changed_by     | UUID        |
| operation_type | TEXT        |
| changes        | JSONB       |
| created_at     | TIMESTAMPTZ |

### **8.2 Data storage**

The spreadsheet must save:

- Cell values.
- Formulas.
- Formatting.
- Fonts.
- Background colours.
- Borders.
- Merged cells.
- Row heights.
- Column widths.
- Sheet order.
- Hidden rows and columns.
- Frozen rows and columns.

Use JSONB for structured workbook information.

Do not store every cell as an independent database row unless performance testing proves that this is necessary.

### **8.3 Save mechanism**

Implement three saving methods:

1. **Ctrl + S:** Explicit save.
2. **Automatic save:** Save after a short period of inactivity.
3. **Save on navigation:** Attempt to save pending changes before leaving the editor.

Display the following statuses:

- Saving...
- Saved.
- Unsaved changes.
- Save failed.
- Conflict detected.

Never display Saved before the database confirms successful persistence.

### **8.4 Concurrent editing**

For the initial version:

- Track workbook version numbers.
- Use optimistic locking.
- Prevent an older editor session from silently overwriting newer data.
- Show a conflict message if another user has saved changes.
- Provide a reload/reconcile workflow.

Real-time multi-user editing can be introduced later without compromising the first release.

### **8.5 Security**

- Reuse existing authentication.
- Apply Supabase Row Level Security.
- Restrict workbook access according to existing site permissions.
- Only authorized employees can edit.
- Admins can configure spreadsheet editing permissions.
- Validate all saved operations on the server.
- Do not trust client-side calculated payroll or attendance values.

# **9. Fix the existing Runtime TypeError**

Must fix before integration

Current error:

```
Runtime TypeError
Cannot read properties of undefined (reading '2')

Next.js 16.1.3
Turbopack
```

This means some code is trying to access index `[2]` on a value that is currently `undefined`.

For example:

```
const value = row[2];
```

If `row` is undefined, this produces the reported error.

However, without the stack trace and affected source file, we cannot establish the exact cause. It could be in the existing spreadsheet renderer, formula parser, cell formatting, or data conversion logic.

### **Required debugging instructions**

Ask the developer/AI coding agent to:

1. Reproduce the error using the affected timesheet.
2. Capture the complete browser console stack trace.
3. Identify the exact file and line causing the exception.
4. Inspect the underlying spreadsheet data structure.
5. Check for missing rows, incomplete cell arrays and malformed formatting data.
6. Add appropriate validation and safe defaults.
7. Test empty timesheets, newly created rows, deleted rows and imported Excel files.
8. Fix the underlying issue instead of hiding it with a broad error handler.

Example of defensive handling:

```
const cellValue = Array.isArray(row)
  ? row[2] ?? null
  : null;
```

This is only an illustration, not a confirmed patch for your particular error.

### **Next.js integration requirements**

The spreadsheet engine must be mounted as a client-side component.

- Use `"use client"` where required.
- Dynamically load browser-dependent spreadsheet components.
- Disable server-side rendering for components that require `window`, `document` or canvas APIs.
- Properly initialize and destroy spreadsheet instances.
- Avoid duplicate event listeners.
- Avoid accessing spreadsheet state before initialization.
- Validate imported data before passing it to the spreadsheet engine.

The new spreadsheet must not introduce hydration errors or Turbopack build failures.

# **10. PDF and Excel integration**

Both existing viewers must continue working.

| Functionality          | Excel | PDF                                           |
| ---------------------- | ----- | --------------------------------------------- |
| Open existing document | Yes   | Yes                                           |
| Zoom in/out            | Yes   | Yes                                           |
| Fit to width           | Yes   | Yes                                           |
| Full screen            | Yes   | Yes                                           |
| Save changes           | Yes   | Not required unless annotations are supported |
| Download               | XLSX  | PDF                                           |
| Print                  | Yes   | Yes                                           |

The PDF viewer should remain separate from the spreadsheet engine.

Do not convert PDFs into spreadsheets just to reuse the Excel editor.

# **11. UI layout specification**

The spreadsheet should occupy the available workspace, rather than being squeezed inside a small card.

[Introduction to Microsoft Excel](https://images.openai.com/static-rsc-4/VddWZVJR-ePYfmudnmpbhewiDuPwJSK7Tlaa-68RGMEPb8uuBVtFU0s2HHJ-Jp0qCwrg3GPB6su9MkGzMnznMW1Mxcuw5CVupGaiEdik87Wv_oTbd0Tv-qI2ciLeZyIVpnh-Z8QsQSPBaHCiBLsukpxmEMhK-ecyygJDYsxrzXA?purpose=inline)

[tutorjoes.in](https://www.tutorjoes.in/microsoft_excel_in_365_tutorial/microsoft_excel_in_excel_365?utm_source=chatgpt.com)

### **Top toolbar**

| Area      | Controls                                   |
| --------- | ------------------------------------------ |
| File      | Save, Import, Export, Print                |
| Edit      | Undo, Redo, Cut, Copy, Paste               |
| Font      | Font family, size, bold, italic, underline |
| Colours   | Text colour, fill colour                   |
| Alignment | Left, centre, right, vertical alignment    |
| Borders   | Border options                             |
| Cells     | Merge, wrap text, number format            |
| Structure | Insert, delete, resize                     |
| View      | Freeze, zoom, full screen                  |
| Search    | Find and replace                           |

### **Formula bar**

Show:

- Selected cell reference.
- Current cell value or formula.
- Editable formula input.

Example:

**A31**

Formula bar

`=SUM(A1:A30)`

Illustrative spreadsheet formula bar.

### **Bottom status bar**

Show:

- Current sheet.
- Selected cell count.
- Sum of selected numeric cells.
- Average.
- Zoom percentage.
- Save status.

# **12. Performance requirements**

The timesheets can contain many employees and daily attendance columns.

The spreadsheet must remain responsive.

Requirements:

- Virtualize rows and columns where supported.
- Avoid rerendering the entire spreadsheet after each cell edit.
- Use efficient formula dependency recalculation.
- Debounce automatic saving.
- Do not send one database request for every keystroke.
- Use batch updates.
- Process large Excel imports and exports in Web Workers where practical.
- Avoid unnecessary JSON serialization.
- Load only the workbook being opened.
- Maintain responsive scrolling.

Test with:

| Test case       | Expected behaviour                               |
| --------------- | ------------------------------------------------ |
| 100 employees   | Smooth                                           |
| 500 employees   | Smooth                                           |
| 1,000 employees | Usable without major lag                         |
| 5,000 rows      | No browser crash; performance benchmark required |
| Large formulas  | Recalculate without freezing the UI              |
| Multiple sheets | Switch without losing changes                    |

These are performance targets to verify, not guaranteed capabilities of the selected library.

# **13. Development phases – 0 to 100**

Do not implement everything in one massive change. Build and test each phase before moving forward.

1. **Phase 1 – Existing system audit (0–10%)**
   - Inspect current Sites page.
   - Identify existing spreadsheet component.
   - Trace current timesheet data flow.
   - Identify the Runtime TypeError.
   - Inspect Supabase tables and permissions.
   - Document existing PDF export and generation.
   - Create a backup before modifying anything.
2. **Phase 2 – Spreadsheet engine integration (10–20%)**
   - Test FortuneSheet with actual timesheet data.
   - Create spreadsheet client component.
   - Integrate into Sites page.
   - Implement formula bar and toolbar.
   - Verify Next.js 16 compatibility.
3. **Phase 3 – Excel editing functionality (20–35%)**
   - Cell editing.
   - Multi-cell selection.
   - Right-click context menu.
   - Insert/delete rows and columns.
   - Copy/paste.
   - Keyboard shortcuts.
   - Undo/redo.
4. **Phase 4 – Formatting and dimensions (35–50%)**
   - Fonts and colours.
   - Borders and alignment.
   - Merge/unmerge.
   - Row resizing.
   - Column resizing.
   - Hide/unhide.
   - Freeze panes.
5. **Phase 5 – Formula engine (50–60%)**
   - Formula calculations.
   - SUM and AVERAGE.
   - IF and COUNT.
   - Cell references.
   - Range references.
   - Automatic recalculation.
   - Formula error handling.
6. **Phase 6 – Supabase persistence (60–75%)**
   - Database integration.
   - Workbook saving.
   - Autosave.
   - Ctrl + S.
   - Revision history.
   - Conflict detection.
   - Permission enforcement.
7. **Phase 7 – Excel and PDF functionality (75–85%)**
   - XLSX import/export.
   - CSV import/export.
   - PDF zoom controls.
   - Excel zoom controls.
   - Print and download.
8. **Phase 8 – Timesheet integration (85–95%)**
   - Connect existing attendance data.
   - Preserve employee/site relationships.
   - Protect system-generated calculations.
   - Verify salary and payroll integration.
   - Verify existing PDF output.
9. **Phase 9 – Final testing (95–100%)**
   - Desktop testing.
   - Tablet testing.
   - Mobile responsive testing.
   - Supabase security testing.
   - Formula testing.
   - Data persistence testing.
   - Performance testing.
   - Production deployment.

# **14. Free technology stack**

These are the technologies I would use for this implementation.

| Requirement             | Technology                   | Cost                             |
| ----------------------- | ---------------------------- | -------------------------------- |
| Spreadsheet engine      | FortuneSheet                 | Free, MIT                        |
| Alternative spreadsheet | OpenSheets                   | Free, MIT                        |
| Formula engine          | Built-in FortuneSheet engine | Free                             |
| Frontend                | Existing Next.js             | Existing                         |
| Backend                 | Existing Supabase            | Existing                         |
| Database                | PostgreSQL                   | Existing                         |
| XLSX import/export      | FortuneExcel plugin          | Open-source; verify dependencies |
| PDF rendering           | Mozilla PDF.js               | Free, Apache-2.0                 |
| Hosting                 | Existing Vercel              | Existing free-tier eligibility   |
| Version control         | GitHub                       | Free tier                        |

No Microsoft Excel API, Google Sheets API, paid Handsontable licence, AG Grid Enterprise, paid spreadsheet SDK or external spreadsheet subscription is required.

Note that Vercel and Supabase free plans have usage limits. The software libraries being free does not mean hosting and database usage are unlimited.

# **15. Final acceptance criteria**

The project is not complete until all these requirements pass.

**Implementation checklist**

0/17 completed

Right-click inserts rows above and below.

Right-click inserts columns left and right.

Rows and columns can be deleted.

Ctrl + C and Ctrl + V work for multiple cells.

Ctrl + Z and Ctrl + Y work correctly.

Ctrl + S saves successfully to Supabase.

Formulas such as =SUM(A1:A31) recalculate live.

Cell formatting is saved and restored.

Merged cells are saved and restored.

Row heights and column widths persist.

Excel XLSX files can be imported and exported.

Excel zoom works independently.

PDF zoom works independently.

Existing timesheet attendance data remains correct.

Existing payroll calculations remain correct.

The Runtime TypeError is fixed and regression-tested.

No paid spreadsheet dependencies are introduced.

# **16. Critical instructions for the AI coding agent**

Use the following as the main implementation instruction:

# WORKFORCE OS – EXCEL-STYLE TIMESHEET UPGRADE

Upgrade the existing Timesheet Excel functionality inside the Sites page of Workforce OS.

Repository: [https://github.com/Paradox-max007/WORKFORCE_OS.git](https://github.com/Paradox-max007/WORKFORCE_OS.git)

## Non-negotiable instructions

1. Audit the existing repository before changing any code.
2. Identify and fix the existing `Cannot read properties of undefined (reading '2')` runtime error.
3. Do not replace or damage existing attendance, employee transfer, salary or payroll functionality.
4. Use a free, open-source spreadsheet engine with a commercially compatible licence. Evaluate FortuneSheet first and benchmark OpenSheets if necessary.
5. Do not use paid spreadsheet SDKs or subscriptions.
6. Implement Excel-style editing, context menus, formulas, formatting, resizing, undo/redo, keyboard shortcuts and zoom.
7. Persist all spreadsheet data, formatting, dimensions, formulas and merged cells through the existing Supabase backend.
8. Ensure Ctrl+S performs a genuine database save.
9. Preserve existing site-based timesheet structures and business logic.
10. Protect system-generated attendance and payroll values from unauthorized or accidental modification.
11. Test all features before deployment.
12. Work in small, independently testable phases.

## Expected result

The existing Sites → Timesheet Excel feature should become a controlled Excel-like spreadsheet editor integrated into Workforce OS.

It should feel like using Excel, but all operations, data storage, permissions and business rules must remain controlled by Workforce OS.

Do not stop after creating the interface. Every visible action must actually work.

Do not mark a phase complete until its acceptance tests pass.

**One repository-access note:** I attempted to locate the repository through the connected GitHub integration, but it did not return the repository or its source files. Therefore, this is an implementation-ready PRD based on your requirements, not a verified source-code audit. The first development phase must map the actual existing components, tables and spreadsheet implementation before making changes.

**My strongest recommendation:** Build this as an upgrade to the existing Sites timesheet, not as a separate spreadsheet application. This ensures your attendance, employee transfers and payroll continue to work while gaining the Excel editing experience you want.&#x20;