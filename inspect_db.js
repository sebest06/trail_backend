const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'appradar.db'));

console.log('--- Table: users ---');
console.log(db.prepare('PRAGMA table_info(users)').all());

console.log('\n--- Table: race_runs ---');
console.log(db.prepare('PRAGMA table_info(race_runs)').all());

console.log('\n--- Sample race_runs ---');
console.log(db.prepare('SELECT * FROM race_runs').all());
