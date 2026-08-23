const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sql = fs.readFileSync(path.join(root, "work-session-admin-delete-migration.sql"), "utf8");

assert.match(app, /rpc\("delete_unfinalized_work_session",\{p_session_id:sessionId\}\)/);
assert.match(app, /作業データを削除できるのは管理者のみです/);
assert.match(app, /!isFinalized&&currentUserIsAdmin\(\)/);
assert.match(sql, /create or replace function public\.delete_unfinalized_work_session/);
assert.match(sql, /if not public\.is_master_admin\(\)/);
assert.match(sql, /target_session\.finalized_at is not null/);
assert.match(sql, /from public\.sales_records record/);
assert.match(sql, /delete from public\.work_sessions/);

console.log("Work-session administrator delete tests passed");
