import 'dotenv/config';
import assert from 'node:assert/strict';
import { readExcelSheet } from '../src/excel';

const testReadExcelSheet = async () => {
    const filePath = 'data/input/ContactExport.xlsx';
    const worksheet = await readExcelSheet(filePath);
    assert.ok(worksheet.rowCount > 0, `expected worksheet to have rows, got ${worksheet.rowCount}`);
    assert.equal(worksheet.name, 'Carter', `expected worksheet name to be 'Carter', got ${worksheet.name}`);
    console.log('PASS: readExcelSheet() reads the worksheet successfully');
}

testReadExcelSheet().catch((err) => {
    console.error('FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
});