// system/db/lowdb_adapter.js

import { join, dirname } from 'path'
import { Low, JSONFile } from 'lowdb'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url));

// Inisialisasi adapter untuk setiap file JSON
const fileAdapters = {
    database: new JSONFile(join(__dirname, 'database.json')),
    dataGc: new JSONFile(join(__dirname, 'dataGc.json')),
    stats: new JSONFile(join(__dirname, 'stats.json')),
    requests: new JSONFile(join(__dirname, 'requests.json')),
    lid: new JSONFile(join(__dirname, 'lid.json'))
};

// Buat instance LowDB untuk setiap adapter
const dbs = {
    database: new Low(fileAdapters.database),
    dataGc: new Low(fileAdapters.dataGc),
    stats: new Low(fileAdapters.stats),
    requests: new Low(fileAdapters.requests),
    lid: new Low(fileAdapters.lid)
};

// Fungsi untuk memuat semua database
async function loadDatabases() {
    for (const key in dbs) {
        await dbs[key].read();
        // Tetapkan data default jika file kosong atau tidak ada
        dbs[key].data = dbs[key].data || { key: {} }; 
    }
    console.log('LowDB: All databases loaded.');
}

// Ekspor instance dan fungsi load
export { dbs, loadDatabases };
