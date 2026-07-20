// Phase 1: read the contact sheet, check each row against ZoomInfo Contact Search,
// derive ACTIVE / INACTIVE / NOT_FOUND, write the annotated sheet.

export const runSearch = async (inputFile: string): Promise<void> => {
  // TODO: excel.readRows -> zoominfo.contactSearch per row -> derive status -> excel.writeResults
  console.log(`search: would audit contacts from ${inputFile}`);
};

export default runSearch;