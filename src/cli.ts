import 'dotenv/config';
import chalk from 'chalk';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { runSearch } from './search';

const USAGE = 
`
Salesforce Contact Auditor

Usage: npm run dev -- <command> <inputFile>

Commands:
  search <inputFile>   Audit contacts: flag each as ACTIVE / INACTIVE / NOT_FOUND
  enrich <inputFile>   Pull current title/email/phone for verified contacts

Options:
  -h, --help           Show this help message

Example:
  npm run dev -- search data/input/contacts.xlsx
`

const main = async () => {
  console.log(`Salesforce Contact Auditor | Version: ${process.env.npm_package_version}`);
  console.log(`Node.js Version: ${process.version}`);
  console.log('---------------------------------------- \n \n');
  
  const args = process.argv.slice(2);
  const {values, positionals} = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if(values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const [command, inputFile] = positionals;
  switch(command){
    case 'search':
      if(!inputFile) {
        throw new Error('Input file is required for the search command.');
      }
      if(!existsSync(inputFile)) {
        throw new Error(`Input file "${inputFile}" does not exist.`);
      }
      await runSearch(inputFile);
      break;
    case 'enrich':
      throw new Error('The enrich command is not yet implemented.');
    default:
      throw new Error(`Unknown command: ${command}`);
  }

}

main().catch((err) => {
  console.error(err instanceof Error ? chalk.red(err.message) : err);
  console.log(USAGE);
  process.exit(1);
});
