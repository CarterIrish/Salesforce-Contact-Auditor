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

const SEARCH_INPUT_COLUMNS = ['first name', 'last name', 'account name', 'email'];
const PERSON_ID_COLUMN = 'zoominfo person id';
// 'title' is the Salesforce Title column - stage 1's 'zoominfo title' is deliberately not touched.
const ENRICH_OUTPUT_COLUMNS = ['email', 'title', 'phone', 'mobile', 'tool notes'];

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
    for (const name of SEARCH_INPUT_COLUMNS) {
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
            firstName: row.getCell(headers.get('first name')!).value?.toString() ?? '',
            lastname: row.getCell(headers.get('last name')!).value?.toString() ?? '',
            company: row.getCell(headers.get('account name')!).value?.toString() ?? '',
            email: row.getCell(headers.get('email')!).text,
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
 * Reads enrichment input rows: each data row's ZoomInfo Person ID plus its row number for
 * write-back. Rows with a blank person ID are skipped - they cannot be enriched.
 * @param filePath Path to the input Excel file.
 * @param worksheetName Name of the worksheet tab to read.
 * @returns A promise resolving to an array of EnrichRow objects.
 * @throws Error if the ZoomInfo Person ID column is missing, or no rows are found.
 */
const readEnrichRows = async (filePath: string, worksheetName: string): Promise<EnrichRow[]> => {
    const worksheet = await readExcelSheet(filePath, worksheetName);
    const headers = getHeaders(worksheet);
    if (!headers.has(PERSON_ID_COLUMN)) {
        throw new Error(`Missing expected column "${PERSON_ID_COLUMN}" in worksheet: ${worksheet.name}`);
    }
    const rows = worksheet.getRows(2, worksheet.rowCount - 1); // skip header row
    if (!rows) {
        throw new Error(`No rows found in worksheet: ${worksheet.name}`);
    }

    const enrichRows: EnrichRow[] = [];
    for (const row of rows) {
        const personId = row.getCell(headers.get(PERSON_ID_COLUMN)!).text.trim();
        if (personId) {
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
 * Writes enrichment results into the existing Email / Title / Phone / Mobile columns (located by
 * header name), keyed by each result's rowNumber. A field ZoomInfo didn't return is left untouched
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
    if (inputPath === outputPath) {
        throw new Error(`Input and output paths must be different: ${inputPath}`);
    }
    const worksheet = await readExcelSheet(inputPath, worksheetName);
    const headers = getHeaders(worksheet);
    for (const name of ENRICH_OUTPUT_COLUMNS) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }

    for (const result of results) {
        const row = worksheet.getRow(result.rowNumber);
        if (result.email) row.getCell(headers.get('email')!).value = result.email;
        if (result.jobTitle) row.getCell(headers.get('title')!).value = result.jobTitle;
        if (result.phone) row.getCell(headers.get('phone')!).value = result.phone;
        if (result.mobilePhone) row.getCell(headers.get('mobile')!).value = result.mobilePhone;
        if (result.notes) row.getCell(headers.get('tool notes')!).value = result.notes;
    }
    await worksheet.workbook.xlsx.writeFile(outputPath);
}

export { readContacts, writeSearchResults, readEnrichRows, writeEnrichResults };
