import { backfillGrantEligibility, eligibilitySecret } from "../src/modules/identity";
import { readConfig } from "../src/platform/config";
import { createDatabase } from "../src/platform/db";

export { backfillGrantEligibility };

if (import.meta.main) {
  const config = readConfig();
  const db = createDatabase(config);
  try {
    const count = await backfillGrantEligibility(db, eligibilitySecret(config));
    console.log(
      `Grant eligibility v1 backfilled for ${count} retained accounts. Deleted/former addresses cannot be recovered from legacy digests.`,
    );
  } finally {
    await db.close();
  }
}
