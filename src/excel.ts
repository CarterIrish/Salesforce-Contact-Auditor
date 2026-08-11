import ExcelJS from 'exceljs';
import type { SearchResult } from './search.js';
export interface ContactRow {
    rowNumber: number;
    firstName: string;
    lastname: string;
    company: string;
    email: string;
}

export interface EnrichRow {
    rowNumber: number;
    personId: string;
}

// Field names mirror ContactEnrichAttributes so results can be built by spreading the API record.
export interface EnrichResult {
    rowNumber: number;
    email?: string;
    jobTitle?: string;
    phone?: string;
    mobilePhone?: string;
    notes?: string;
}

const SEARCH_INPUT_COLUMNS = {
    firstName: 'first name',
    lastName: 'last name',
    accountName: 'account name',
    email: 'email'
} as const;

const ENRICH_INPUT_COLUMNS = {
    zoomInfoPersonId: 'zoominfo person id',
    inferredContactStatus: 'inferred contact status'
} as const;

const ENRICH_OUTPUT_COLUMNS = {
    email: 'email',
    title: 'title',
    phone: 'phone',
    mobile: 'mobile',
    toolNotes: 'tool notes'
} as const;
const EDITED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE9D9' } };

/**
 * Opens the workbook and returns the named worksheet.
 * @param filePath Path to the Excel file to read.
 * @param worksheetName Name of the worksheet tab to open.
 * @returns The requested worksheet.
 * @throws Error if the file cannot be read or the worksheet is not found.
 */
const readExcelSheet = async (filePath: string, worksheetName: string): Promise<ExcelJS.Worksheet> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.getWorksheet(worksheetName);
    if (!worksheet) {
        const available = workbook.worksheets.map(ws => ws.name).join(', ');
        throw new Error(`Worksheet "${worksheetName}" not found in file: ${filePath}. Available worksheets: ${available}`);
    }
    return worksheet;
}

/**
 * Internal helper for readRows() - Maps each header cell's text (lowercased) to its column number,
 * so field lookups don't depend on hand-counted column letters (some are hidden).
 * @param worksheet The already-opened worksheet to read.
 * @returns A Map of lowercased header text → column number.
 */
const getHeaders = (worksheet: ExcelJS.Worksheet): Map<string, number> => {
    const headerRow = worksheet.getRow(1);
    const headers = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
        headers.set(cell.value?.toString().toLowerCase() ?? '', colNumber);
    })
    return headers;
}


/**
 * Internal helper for readContacts() - reads an already-opened worksheet's data rows into
 * ContactRow objects, keyed off the header row. Reads every data row (rows 2..rowCount).
 * Email is read via cell.text.
 * @param worksheet The already-opened worksheet to read.
 * @returns A promise resolving to an array of ContactRow objects.
 * @throws Error if a required column is missing from the header row, or no rows are found.
 */
const readRows = async (worksheet: ExcelJS.Worksheet): Promise<ContactRow[]> => {
    const headers = getHeaders(worksheet);
    for (const name of Object.values(SEARCH_INPUT_COLUMNS)) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }
    const rows = worksheet.getRows(2, worksheet.rowCount - 1); // skip header row
    if (!rows) {
        throw new Error(`No rows found in worksheet: ${worksheet.name}`);
    }

    let contactRows: ContactRow[] = [];
    for (const row of rows) {
        const newRow: ContactRow = {
            rowNumber: row.number,
            firstName: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.firstName)!).value?.toString() ?? '',
            lastname: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.lastName)!).value?.toString() ?? '',
            company: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.accountName)!).value?.toString() ?? '',
            email: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.email)!).text,
        };
        contactRows.push(newRow);
    }

    return contactRows;
}

/**
 * Reads contact information from an Excel file.
 * @param filePath Path to input data
 * @param worksheetName Name of the worksheet tab to read.
 * @returns A promise resolving to an array of ContactRow objects.
 */
const readContacts = async (filePath: string, worksheetName: string): Promise<ContactRow[]> => {
    const worksheet = await readExcelSheet(filePath, worksheetName);
    const rows = await readRows(worksheet);
    return rows;
}

/**
 * Reads enrichment input rows: each row's ZoomInfo Person ID plus its row number for
 * write-back. Rows with a blank person ID or non "ACTIVE" status are skipped - they cannot or should not be enriched.
 * @param filePath Path to the input Excel file.
 * @param worksheetName Name of the worksheet tab to read.
 * @returns A promise resolving to an array of EnrichRow objects.
 * @throws Error if the ZoomInfo Person ID column or status column is missing, or no rows are found.
 */
const readEnrichRows = async (filePath: string, worksheetName: string): Promise<EnrichRow[]> => {
    const worksheet = await readExcelSheet(filePath, worksheetName);
    const headers = getHeaders(worksheet);
    for (const name of Object.values(ENRICH_INPUT_COLUMNS)) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }
    const excelRows = worksheet.getRows(2, worksheet.rowCount - 1); // skip header row
    if (!excelRows) {
        throw new Error(`No rows found in worksheet: ${worksheet.name}`);
    }

    const enrichRows: EnrichRow[] = [];
    for (const row of excelRows) {
        const personId = row.getCell(headers.get(ENRICH_INPUT_COLUMNS.zoomInfoPersonId)!).text.trim();
        const inferredStatus = row.getCell(headers.get(ENRICH_INPUT_COLUMNS.inferredContactStatus)!).text.trim();
        if (inferredStatus === 'ACTIVE' && personId) {
            enrichRows.push({ rowNumber: row.number, personId });
        }
    }
    return enrichRows;
}

/**
 * Writes the output-column header labels into row 1, cells V–AB. Called by writeResults() before
 * the data rows.
 * @param worksheet The worksheet to write the headers into.
 */
const setHeaders = (worksheet: ExcelJS.Worksheet): void => {
    const headerRow = worksheet.getRow(1);
    headerRow.getCell('V').value = 'Inferred Contact Status';
    headerRow.getCell('W').value = 'ZoomInfo Person ID';
    headerRow.getCell('X').value = 'ZoomInfo Company Name';
    headerRow.getCell('Y').value = 'ZoomInfo Company ID';
    headerRow.getCell('Z').value = 'ZoomInfo Title';
    headerRow.getCell('AA').value = 'Tool Notes';
    headerRow.getCell('AB').value = 'ZoomInfo Rejected Candidates';
}

/**
 * Writes derived results into columns V–AB, keyed by each result's rowNumber. Re-opens the input
 * workbook, writes the results into it (leaving columns A–U and the other tabs intact), and saves to
 * a separate output file. Overwrites any existing output file.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param results Array of SearchResult objects, each with a rowNumber matching the input sheet.
 * @param worksheetName Name of the worksheet tab to write into - must match the tab that was read.
 * @throws Error if inputPath === outputPath, or the workbook cannot be read or written.
 */
const writeSearchResults = async (inputPath: string, outputPath: string, results: SearchResult[], worksheetName: string): Promise<void> => {
    if (inputPath === outputPath) {
        throw new Error(`Input and output paths must be different: ${inputPath}`);
    }
    const worksheet = await readExcelSheet(inputPath, worksheetName);
    setHeaders(worksheet);
    for (const result of results) {
        let row = worksheet.getRow(result.rowNumber);
        row.getCell('V').value = result.status;
        row.getCell('W').value = result.personId ?? '';
        row.getCell('X').value = result.zi_company ?? '';
        row.getCell('Y').value = result.zi_company_id?.toString() ?? '';
        row.getCell('Z').value = result.zi_title ?? '';
        row.getCell('AA').value = result.notes ?? '';
        row.getCell('AB').value = result.rejectedCandidates ?? '';
    }
    await worksheet.workbook.xlsx.writeFile(outputPath);
}

/**
 * Internal helper for writeEnrichResults() - writes a value into a cell and marks it with the
 * edited-cell fill so reviewers can see which cells the run touched.
 * @param row The worksheet row to write into.
 * @param colNumber The column number of the cell.
 * @param value The value to write.
 */
const writeEditedCell = (row: ExcelJS.Row, colNumber: number, value: string): void => {
    const cell = row.getCell(colNumber);
    cell.value = value;
    // Cells loaded from a file can share one style object; setting cell.fill would paint every
    // cell sharing it. Replacing the style object scopes the fill to this cell alone.
    cell.style = { ...cell.style, fill: EDITED_FILL };
}

/**
 * Writes enrichment results into the existing Email / Title / Phone / Mobile columns (located by
 * header name), keyed by each result's rowNumber, highlighting each written cell with EDITED_FILL.
 * A field ZoomInfo didn't return is left untouched
 * so existing data is never blanked; notes go to Tool Notes when present. Re-opens the input
 * workbook (leaving all other cells and tabs intact) and saves to a separate output file.
 * Overwrites any existing output file.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param results Array of EnrichResult objects, each with a rowNumber matching the input sheet.
 * @param worksheetName Name of the worksheet tab to write into - must match the tab that was read.
 * @throws Error if inputPath === outputPath, an output column is missing, or the workbook cannot
 * be read or written.
 */
const writeEnrichResults = async (inputPath: string, outputPath: string, results: EnrichResult[], worksheetName: string): Promise<void> => {
    // Verify file paths are different to avoid overwriting the input file
    if (inputPath === outputPath) {
        throw new Error(`Input and output paths must be different: ${inputPath}`);
    }
    // Open the workbook and get the specified worksheet
    const worksheet = await readExcelSheet(inputPath, worksheetName);
    const headers = getHeaders(worksheet);
    for (const name of Object.values(ENRICH_OUTPUT_COLUMNS)) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }

    // Write each result into its cell, keyed by rowNumber.
    for (const result of results) {
        const row = worksheet.getRow(result.rowNumber);
        if (result.email) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.email)!, result.email);
        if (result.jobTitle) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.title)!, result.jobTitle);
        if (result.phone) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.phone)!, result.phone);
        if (result.mobilePhone) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.mobile)!, result.mobilePhone);
        if (result.notes) {
            const notesCell = row.getCell(headers.get(ENRICH_OUTPUT_COLUMNS.toolNotes)!);
            if(notesCell.text !== '') notesCell.value = notesCell.text + ' | ' + result.notes;
            else notesCell.value = result.notes;
        }
    }
    await worksheet.workbook.xlsx.writeFile(outputPath);
}

export { readContacts, writeSearchResults, readEnrichRows, writeEnrichResults };
