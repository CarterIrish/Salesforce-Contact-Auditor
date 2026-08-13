import 'dotenv/config';
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// Resolves from both src/ (tsx) and dist/ (compiled), which sit one level below the package root.
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

// Marks the failures a user can fix by retyping the command. Only these print USAGE, so a 401 or a
// locked output file surfacing minutes into a run isn't buried under twenty lines of help text.
class UsageError extends Error { }

/**
 * Parses argv, restating anything parseArgs rejects (an unknown option, a missing option value) as
 * a UsageError so it prints the usage text like the checks below it.
 * @param args Raw argv, less the node and script entries.
 */
const parseCliArgs = (args: string[]) => {
  try {
    return parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, worksheet: { type: 'string', short: 'w' }, fresh: { type: 'boolean', short: 'f' } }, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * CLI entry point. Parses argv and routes the subcommand: `search <file>` runs the audit, `enrich
 * <file>` pulls current phone/mobile/email/title for ACTIVE rows, and `--help` or no args prints
 * usage. Both commands take the same three arguments, so they are validated once before dispatch.
 * @throws UsageError on an unknown command, a missing or nonexistent input file, a missing
 * --worksheet, or an option parseArgs rejects. Whatever a phase throws — auth, API, workbook I/O —
 * propagates unchanged.
 */
const main = async () => {
  console.log(`Salesforce Contact Auditor | Version: ${version}`);
  console.log(`Node.js Version: ${process.version}`);
  console.log('---------------------------------------- \n \n');

  const args = process.argv.slice(2);
  const { values, positionals } = parseCliArgs(args);
  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const [command, inputFile] = positionals;
  if (command !== 'search' && command !== 'enrich') {
    throw new UsageError(`Unknown command: ${command}`);
  }
  if (!inputFile) {
    throw new UsageError(`Input file is required for the ${command} command.`);
  }
  if (!existsSync(inputFile)) {
    throw new UsageError(`Input file "${inputFile}" does not exist.`);
  }
  if (!values.worksheet) {
    throw new UsageError(`The --worksheet option is required for the ${command} command.`);
  }

  if (command === 'search') {
    await runSearch(inputFile, values.worksheet, values.fresh);
  } else {
    await runEnrich(inputFile, values.worksheet, values.fresh);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  if (err instanceof UsageError) {
    console.log(USAGE);
  }
  process.exit(1);
});
