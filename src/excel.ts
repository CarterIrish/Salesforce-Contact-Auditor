import ExcelJS from 'exceljs';
import type { SearchResult } from './search.js';
export interface ContactRow {
    rowNumber: number;
    firstName: string;
    lastname: string;
    company: string;
    email: string;
}

const REQUIRED_COLUMNS = ['first name', 'last name', 'account name', 'email'];

/**
 * Opens the workbook and returns the 'Carter' worksheet. 
 * Sheet name is temporarily hardcoded.
 * @param filePath Path to the Excel file to read.
 * @returns The 'Carter' worksheet.
 * @throws Error if the file cannot be read or the 'Carter' sheet is not found.
 */
const readExcelSheet = async (filePath: string): Promise<ExcelJS.Worksheet> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if (!workbook) {
        throw new Error(`Failed to read Excel file: ${filePath}`);
    }
    const worksheet = workbook.getWorksheet('Carter');
    if (!worksheet) {
        throw new Error(`Worksheet 'carter' not found in file: ${filePath}`);
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
    for (const name of REQUIRED_COLUMNS) {
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
            email: row.getCell(headers.get('email')!).text ?? '',
        };
        contactRows.push(newRow);
    }

    return contactRows;
}

/**
 * Reads contact information from an Excel file.
 * @param filePath Path to input data
 * @returns A promise resolving to an array of ContactRow objects.
 */
const readContacts = async (filePath: string): Promise<ContactRow[]> => {
    const worksheet = await readExcelSheet(filePath);
    const rows = await readRows(worksheet);
    return rows;
}

/**
 * Writes the output-column header labels into row 1, cells V–AA. Called by writeResults() before
 * the data rows.
 * @param worksheet The worksheet to write the headers into.
 */
const setHeaders = (worksheet: ExcelJS.Worksheet): void => {
    const headerRow = worksheet.getRow(1);
    headerRow.getCell('V').value = 'Contact Status';
    headerRow.getCell('W').value = 'ZoomInfo Person ID';
    headerRow.getCell('X').value = 'ZoomInfo Company Name';
    headerRow.getCell('Y').value = 'ZoomInfo Company ID';
    headerRow.getCell('Z').value = 'ZoomInfo Title';
    headerRow.getCell('AA').value = 'Notes';
}

/**
 * Writes derived results into columns V–AA, keyed by each result's rowNumber. Re-opens the input
 * workbook, writes the results into it (leaving columns A–U and the other tabs intact), and saves to
 * a separate output file. Overwrites any existing output file.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param results Array of SearchResult objects, each with a rowNumber matching the input sheet.
 * @throws Error if inputPath === outputPath, or the workbook cannot be read or written.
 */
const writeResults = async (inputPath: string, outputPath: string, results: SearchResult[]): Promise<void> => {
    if (inputPath === outputPath) {
        throw new Error(`Input and output paths must be different: ${inputPath}`);
    }
    const worksheet = await readExcelSheet(inputPath);
    setHeaders(worksheet);
    for (const result of results) {
        let row = worksheet.getRow(result.rowNumber);
        row.getCell('V').value = result.status;
        row.getCell('W').value = result.personId ?? '';
        row.getCell('X').value = result.zi_company ?? '';
        row.getCell('Y').value = result.zi_company_id?.toString() ?? '';
        row.getCell('Z').value = result.zi_title ?? '';
        row.getCell('AA').value = result.notes ?? '';
    }
    await worksheet.workbook.xlsx.writeFile(outputPath);
}

export { readContacts, writeResults };
