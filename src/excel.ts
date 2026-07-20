import ExcelJS from 'exceljs';

const readExcelSheet = async (filePath: string): Promise<ExcelJS.Worksheet> => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    if(!workbook) {
        throw new Error(`Failed to read Excel file: ${filePath}`);
    }
    const worksheet = workbook.getWorksheet('Carter');
    if (!worksheet) {
        throw new Error(`Worksheet 'carter' not found in file: ${filePath}`);
    }
    return worksheet;
}

const readRows = async (worksheet: ExcelJS.Worksheet): Promise<ExcelJS.Row[]> => {
    const rows = worksheet.getRows(0,100); // Read first 100 rows for now
    if (!rows) {
        throw new Error('No rows found in the worksheet.');
    }
    return rows;
}

export { readExcelSheet, readRows };
