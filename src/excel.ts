import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SearchResult } from './search.js';
export interface SearchRow {
    rowNumber: number;
    firstName: string;
    lastName: string;
    company: string;
    email: string;
}

export interface EnrichRow {
    rowNumber: number;
    personId: string;
}

// LIMIT_EXCEEDED is kept distinct from NO_DATA: both arrive with no usable fields, but one means
// the account ran out of credits mid-run and the contact still needs enriching.
export type EnrichStatus = 'ENRICHED' | 'NO_DATA' | 'LIMIT_EXCEEDED' | 'ERROR';

// Field names mirror ContactEnrichAttributes so results can be built by spreading the API record.
export interface EnrichResult {
    rowNumber: number;
    status: EnrichStatus;
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

// Search appends its own columns rather than locating existing ones, so each is a fixed letter
// paired with the header label written above it. Keys mirror the header text, as in the consts
// above, so a column addressed by two phases carries the same key in both.
const SEARCH_OUTPUT_COLUMNS = {
    inferredContactStatus: { column: 'V', header: 'Inferred Contact Status' },
    zoomInfoPersonId: { column: 'W', header: 'ZoomInfo Person ID' },
    zoomInfoCompanyName: { column: 'X', header: 'ZoomInfo Company Name' },
    zoomInfoCompanyId: { column: 'Y', header: 'ZoomInfo Company ID' },
    zoomInfoTitle: { column: 'Z', header: 'ZoomInfo Title' },
    toolNotes: { column: 'AA', header: 'Tool Notes' },
    zoomInfoRejectedCandidates: { column: 'AB', header: 'ZoomInfo Rejected Candidates' }
} as const;

const EDITED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE9D9' } };

/**
 * Opens the workbook and returns the named worksheet.
 * @param filePath Path to the Excel file to read.
 * @param worksheetName Name of the worksheet tab to open.
 * @returns The requested worksheet.
 * @throws Error if the file cannot be read or the worksheet is not found.
 */
const openWorksheet = async (filePath: string, worksheetName: string): Promise<ExcelJS.Worksheet> => {
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
 * Maps each header cell's text (lowercased) to its column number and verifies every required
 * column is present, so field lookups don't depend on hand-counted column letters (some are hidden).
 * @param worksheet The already-opened worksheet to inspect.
 * @param columns The required column labels, lowercased, as a name → header-text record.
 * @returns A Map of lowercased header text → column number.
 * @throws Error if a required column is missing from the header row.
 */
const requireColumns = (worksheet: ExcelJS.Worksheet, columns: Readonly<Record<string, string>>): Map<string, number> => {
    const headers = new Map<string, number>();
    worksheet.getRow(1).eachCell((cell, colNumber) => {
        headers.set(cell.value?.toString().toLowerCase() ?? '', colNumber);
    });

    for (const name of Object.values(columns)) {
        if (!headers.has(name)) {
            throw new Error(`Missing expected column "${name}" in worksheet: ${worksheet.name}`);
        }
    }
    return headers;
}

/**
 * Returns the worksheet's data rows (rows 2..rowCount), skipping the header row.
 * @param worksheet The already-opened worksheet to read.
 * @returns The data rows.
 * @throws Error if the worksheet has no data rows.
 */
const getDataRows = (worksheet: ExcelJS.Worksheet): ExcelJS.Row[] => {
    const rows = worksheet.getRows(2, worksheet.rowCount - 1); // skip header row
    if (!rows) {
        throw new Error(`No rows found in worksheet: ${worksheet.name}`);
    }
    return rows;
}

/**
 * Shared write pipeline: re-opens the input workbook, hands the worksheet to `mutate`, and saves the
 * whole workbook to a separate output file, leaving untouched cells and the other tabs intact.
 * Creates the output directory if it does not exist. Overwrites any existing output file.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param worksheetName Name of the worksheet tab to write into - must match the tab that was read.
 * @param mutate Callback that applies one phase's edits to the worksheet. Awaited, so an async
 * callback finishes editing before the save.
 * @throws Error if inputPath === outputPath, or the workbook cannot be read or written.
 */
const writeToOutput = async (
    inputPath: string,
    outputPath: string,
    worksheetName: string,
    mutate: (worksheet: ExcelJS.Worksheet) => void | Promise<void>
): Promise<void> => {
    if (inputPath === outputPath) {
        throw new Error(`Input and output paths must be different: ${inputPath}`);
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    const worksheet = await openWorksheet(inputPath, worksheetName);
    await mutate(worksheet);
    await worksheet.workbook.xlsx.writeFile(outputPath);
}

/**
 * Internal helper for writeSearchResults() - writes the search output header labels into row 1.
 * @param worksheet The worksheet to write the headers into.
 */
const setSearchOutputHeaders = (worksheet: ExcelJS.Worksheet): void => {
    const headerRow = worksheet.getRow(1);
    for (const { column, header } of Object.values(SEARCH_OUTPUT_COLUMNS)) {
        headerRow.getCell(column).value = header;
    }
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
 * Reads search input rows: each row's name, company and email plus its row number for write-back.
 * Reads every data row. Email is read via cell.text.
 * @param filePath Path to the input Excel file.
 * @param worksheetName Name of the worksheet tab to read.
 * @returns A promise resolving to an array of SearchRow objects.
 * @throws Error if a required column is missing from the header row, or no rows are found.
 */
const readSearchRows = async (filePath: string, worksheetName: string): Promise<SearchRow[]> => {
    const worksheet = await openWorksheet(filePath, worksheetName);
    const headers = requireColumns(worksheet, SEARCH_INPUT_COLUMNS);

    const searchRows: SearchRow[] = [];
    for (const row of getDataRows(worksheet)) {
        searchRows.push({
            rowNumber: row.number,
            firstName: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.firstName)!).value?.toString() ?? '',
            lastName: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.lastName)!).value?.toString() ?? '',
            company: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.accountName)!).value?.toString() ?? '',
            email: row.getCell(headers.get(SEARCH_INPUT_COLUMNS.email)!).text,
        });
    }
    return searchRows;
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
    const worksheet = await openWorksheet(filePath, worksheetName);
    const headers = requireColumns(worksheet, ENRICH_INPUT_COLUMNS);

    const enrichRows: EnrichRow[] = [];
    for (const row of getDataRows(worksheet)) {
        const personId = row.getCell(headers.get(ENRICH_INPUT_COLUMNS.zoomInfoPersonId)!).text.trim();
        const inferredStatus = row.getCell(headers.get(ENRICH_INPUT_COLUMNS.inferredContactStatus)!).text.trim();
        if (inferredStatus === 'ACTIVE' && personId) {
            enrichRows.push({ rowNumber: row.number, personId });
        }
    }
    return enrichRows;
}

/**
 * Writes derived results into the search output columns (V-AB), keyed by each result's rowNumber,
 * leaving columns A-U and the other tabs intact.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param results Array of SearchResult objects, each with a rowNumber matching the input sheet.
 * @param worksheetName Name of the worksheet tab to write into - must match the tab that was read.
 * @throws Error if inputPath === outputPath, or the workbook cannot be read or written.
 */
const writeSearchResults = async (inputPath: string, outputPath: string, results: SearchResult[], worksheetName: string): Promise<void> => {
    await writeToOutput(inputPath, outputPath, worksheetName, worksheet => {
        setSearchOutputHeaders(worksheet);
        for (const result of results) {
            const row = worksheet.getRow(result.rowNumber);
            row.getCell(SEARCH_OUTPUT_COLUMNS.inferredContactStatus.column).value = result.status;
            row.getCell(SEARCH_OUTPUT_COLUMNS.zoomInfoPersonId.column).value = result.personId ?? '';
            row.getCell(SEARCH_OUTPUT_COLUMNS.zoomInfoCompanyName.column).value = result.zi_company ?? '';
            row.getCell(SEARCH_OUTPUT_COLUMNS.zoomInfoCompanyId.column).value = result.zi_company_id?.toString() ?? '';
            row.getCell(SEARCH_OUTPUT_COLUMNS.zoomInfoTitle.column).value = result.zi_title ?? '';
            row.getCell(SEARCH_OUTPUT_COLUMNS.toolNotes.column).value = result.notes ?? '';
            row.getCell(SEARCH_OUTPUT_COLUMNS.zoomInfoRejectedCandidates.column).value = result.rejectedCandidates ?? '';
        }
    });
}

/**
 * Writes enrichment results into the existing Email / Title / Phone / Mobile columns (located by
 * header name), keyed by each result's rowNumber, highlighting each written cell with EDITED_FILL.
 * A field ZoomInfo didn't return is left untouched so existing data is never blanked; notes go to
 * Tool Notes when present.
 * @param inputPath Path to the input Excel file (read-only).
 * @param outputPath Path to the output Excel file (written).
 * @param results Array of EnrichResult objects, each with a rowNumber matching the input sheet.
 * @param worksheetName Name of the worksheet tab to write into - must match the tab that was read.
 * @throws Error if inputPath === outputPath, an output column is missing, or the workbook cannot
 * be read or written.
 */
const writeEnrichResults = async (inputPath: string, outputPath: string, results: EnrichResult[], worksheetName: string): Promise<void> => {
    await writeToOutput(inputPath, outputPath, worksheetName, worksheet => {
        const headers = requireColumns(worksheet, ENRICH_OUTPUT_COLUMNS);

        for (const result of results) {
            const row = worksheet.getRow(result.rowNumber);
            if (result.email) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.email)!, result.email);
            if (result.jobTitle) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.title)!, result.jobTitle);
            if (result.phone) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.phone)!, result.phone);
            if (result.mobilePhone) writeEditedCell(row, headers.get(ENRICH_OUTPUT_COLUMNS.mobile)!, result.mobilePhone);
            if (result.notes) {
                const notesCell = row.getCell(headers.get(ENRICH_OUTPUT_COLUMNS.toolNotes)!);
                if (notesCell.text !== '') notesCell.value = notesCell.text + ' | ' + result.notes;
                else notesCell.value = result.notes;
            }
        }
    });
}

export { readSearchRows, writeSearchResults, readEnrichRows, writeEnrichResults };
