const { AGENCY_IMPORTER, createAgencyUser, setAgencyAccess } = require("../server/agency-auth.cjs");
const [action, identity] = process.argv.slice(2);

async function main() {
  let user;
  if (action === "create") user = await createAgencyUser(identity, AGENCY_IMPORTER);
  else if (action === "grant") user = await setAgencyAccess(identity, AGENCY_IMPORTER);
  else if (action === "revoke") user = await setAgencyAccess(identity, null);
  else throw new Error("Usage: node scripts/agency-sales-users.cjs create EMAIL | grant USER_ID | revoke USER_ID");
  console.log(`${action}: ${user.id}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
