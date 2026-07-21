import ExcelJS from 'exceljs';

export interface ContactRow {
    rowNumber: number;
    firstName: string;
    lastname: string;
    company: string;
    email: string;
}

const REQUIRED_COLUMNS = ['first name', 'last name', 'account name', 'email'];

/**
 * Internal helper for readContacts() — opens the workbook and returns the 'Carter' worksheet.
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
 * Internal helper for readRows() — maps each header cell's text (lowercased) to its column number,
 * so field lookups don't depend on hand-counted column letters (some are hidden).
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
 * Internal helper for readContacts() — reads an already-opened worksheet's data rows into
 * ContactRow objects, keyed off the header row rather than hardcoded column letters.
 * Limited to the first 100 rows for now (excluding header).
 * @throws Error if a required column is missing from the header row, or no rows are found.
 */
const readRows = async (worksheet: ExcelJS.Worksheet): Promise<ContactRow[]> => {
    const headers = getHeaders(worksheet);
    for (const name of REQUIRED_COLUMNS) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }
    const rows = worksheet.getRows(2, 200);
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
            email: row.getCell(headers.get('email')!).value?.toString() ?? '',
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


// TODO: writeResults(filePath, results) — writes derived results into columns V-AB (see
// architecture.md §3 "Output columns"), keyed by each result's rowNumber. Existing columns A-U must
// stay untouched (including Contact Status at L — see §3 "Input schema"). Write personId as TEXT,
// not a number, or "14062844524" renders as "1.40628E+10". Called from search.ts once the fallback
// loop + status derivation (see search.ts TODOs) produce a results array to write.

export { readContacts  };
