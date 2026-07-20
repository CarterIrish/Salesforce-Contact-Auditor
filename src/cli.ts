import 'dotenv/config';

const main = async () => {

}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
