import 'dotenv/config';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { runSearch } from './search';
import { runEnrich } from './enrich';

const USAGE =
  `
Salesforce Contact Auditor

Usage: npm run dev -- <command> <inputFile> [options]

Commands:
  search <inputFile>   Audit contacts: flag each as ACTIVE / INACTIVE / NAME_MISMATCH /
                       NOT_FOUND / ERROR
  enrich <inputFile>   Pull current title/email/phone/mobile for ACTIVE rows

Options:
  -w, --worksheet      Worksheet tab to read (required for both search and enrich)
  -f, --fresh          Ignore cached results and overwrite them with fresh API calls
  -h, --help           Show this help message

Example:
  npm run dev -- search data/input/contacts.xlsx --worksheet Carter
  npm run dev -- enrich data/input/contacts.xlsx --worksheet ACTIVE
`

/**
 * CLI entry point. Parses argv and routes the subcommand: `search <file>` runs the audit, `enrich
 * <file>` pulls current phone/mobile/email/title for ACTIVE rows (after checking the file exists for
 * either), and `--help` or no args prints usage.
 * @throws Error on an unknown command, a missing input file, or a nonexistent input path.
 */
const main = async () => {
  console.log(`Salesforce Contact Auditor | Version: ${process.env.npm_package_version}`);
  console.log(`Node.js Version: ${process.version}`);
  console.log('---------------------------------------- \n \n');

  const args = process.argv.slice(2);
  const { values, positionals } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, worksheet: { type: 'string', short: 'w' }, fresh: { type: 'boolean', short: 'f' } }, allowPositionals: true });
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const [command, inputFile] = positionals;
  switch (command) {
    case 'search':
      if (!inputFile) {
        throw new Error('Input file is required for the search command.');
      }
      if (!existsSync(inputFile)) {
        throw new Error(`Input file "${inputFile}" does not exist.`);
      }
      if (!values.worksheet) {
        throw new Error('The --worksheet option is required for the search command.');
      }
      await runSearch(inputFile, values.worksheet, values.fresh);
      break;
    case 'enrich':
      if (!inputFile) {
        throw new Error('Input file is required for the enrich command.');
      }
      if (!existsSync(inputFile)) {
        throw new Error(`Input file "${inputFile}" does not exist.`);
      }
      if (!values.worksheet) {
        throw new Error('The --worksheet option is required for the enrich command.');
      }
      await runEnrich(inputFile, values.worksheet, values.fresh);
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }

}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.log(USAGE);
  process.exit(1);
});
