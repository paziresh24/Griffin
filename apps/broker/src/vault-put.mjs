// Stores stdin as an emergency vault item: `... | node apps/broker/src/vault-put.mjs <slug>`.
// Prints only the slug and status, never the value.
import { createVault } from "./vault.mjs";
import { genv } from "./env.mjs";

const slug = process.argv[2] || "";
if (!/^[a-z0-9_-]+__[a-z0-9_-]+$/.test(slug)) {
  console.error("usage: vault-put.mjs <service__item> < value");
  process.exit(2);
}

let value = "";
for await (const chunk of process.stdin) value += chunk;

const vault = createVault({ url: genv("BAO_URL"), tokenAge: genv("BAO_TOKEN_AGE"), identity: genv("AGE_IDENTITY") });
try {
  await vault.put(slug, value.trim());
  console.log(`vault: stored ${slug}`);
} catch (error) {
  console.error(`vault: ${slug} not stored: ${error.message}`);
  process.exit(1);
}
