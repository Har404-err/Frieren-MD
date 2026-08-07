import { dbs, loadDatabases } from './lowdb_adapter.js'
import { mongoDB } from './mongo.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { normalizeJid } from '#system/msg.js'

// Panggil loadDatabases saat modul di-load
loadDatabases().then(() => {
    migrateDb()
}).catch(console.error);

// Fungsi migrasi database ke JID-based keys
const migrateDb = () => {
  const database = db()
  if (!database || !database.key) return
  
  const newKey = {}
  let migrated = false
  
  for (const k in database.key) {
    const user = database.key[k]
    // Jika key bukan JID (tidak mengandung @) tapi punya property jid
    if (user && user.jid && !k.includes('@')) {
      newKey[user.jid] = user
      migrated = true
    } else if (user) {
      newKey[k] = user
    }
  }
  
  if (migrated) {
    database.key = newKey
    saveDb()
    console.log('[Migration] Database migrated to JID-based keys.')
  }
}

// Fungsi lama yang masih relevan
const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)
const badwordsPath = path.join(dirname, 'badwords.json')
const blacklistPath = path.join(dirname, 'blacklist.json')
const premiumPath = path.join(dirname, 'premium.json')

// Helper untuk load sync
const loadSync = (file) => {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify([], null, 2))
        return []
    }
    return JSON.parse(fs.readFileSync(file))
}

const badwordsData = loadSync(badwordsPath);
let blacklistData = loadSync(blacklistPath);
let premiumData = loadSync(premiumPath);

// --- FUNGSI INTI BARU DENGAN LOWDB ---
const db = () => dbs.database.data
const gc = () => dbs.dataGc.data
const stats = () => dbs.stats?.data || {}
const requests = () => dbs.requests?.data || { key: {} }
const lid = () => dbs.lid?.data || { key: {} }
const badwords = () => badwordsData
const blacklist = () => blacklistData
const premiumList = () => premiumData

let dirtyFlags = { database: false, stats: false, requests: false, dataGc: false, lid: false }

function markDirty(type = 'database') {
    if (Object.prototype.hasOwnProperty.call(dirtyFlags, type)) {
        dirtyFlags[type] = true
    } else {
        dirtyFlags.database = true
    }
    saveDbDebounced()
}

const getGc = chat => {
    const id = typeof chat === 'object' ? chat.id : chat
    return gc()?.key?.[id] || null
}

let saveTimer = null
const saveDbDebounced = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
        await saveDb()
        saveTimer = null
    }, 2000) // 2 seconds idle period before saving
}

const saveDb = async () => {
    if (dbs.database) await dbs.database.write()
    if (dbs.stats) await dbs.stats.write()
    if (dbs.requests) await dbs.requests.write()
    if (dbs.lid) await dbs.lid.write()
    if (dbs.dataGc) await dbs.dataGc.write()
    
    // Reset dirty flags after save
    dirtyFlags = { database: false, stats: false, requests: false, dataGc: false, lid: false }
    
    if (mongoDB.db) {
        await mongoDB.botData.set('database', db())
        if (dbs.stats) await mongoDB.botData.set('stats', stats())
        if (dbs.requests) await mongoDB.botData.set('requests', requests())
        if (dbs.lid) await mongoDB.botData.set('lid', lid())
        await mongoDB.botData.set('dataGc', gc())
    }
}

const saveGc = async () => {
    if (dbs.dataGc) {
        await dbs.dataGc.write()
        if (mongoDB.db) await mongoDB.botData.set('dataGc', gc())
    }
}

const saveRequests = async () => {
    if (dbs.requests) {
        await dbs.requests.write()
        if (mongoDB.db) await mongoDB.botData.set('requests', requests())
    }
}

const saveBadwords = async (data) => {
    fs.writeFileSync(badwordsPath, JSON.stringify(data, null, 2));
}

const saveBlacklist = async (data) => {
    blacklistData = data
    fs.writeFileSync(blacklistPath, JSON.stringify(data, null, 2));
}

const savePremium = async (data) => {
    premiumData = data
    fs.writeFileSync(premiumPath, JSON.stringify(data, null, 2));
}

// --- FUNGSI LAINNYA (authUser, syncWithMongo, dll) ---
// (Fungsi-fungsi ini tidak perlu diubah karena mereka beroperasi pada objek `db()` yang strukturnya tetap sama)

const role = [
  'Gak Kenal', 'Baru Kenal', 'Temen Biasa', 'Temen Ngobrol', 'Temen Gosip', 'Temen Lama',
  'Temen Hangout', 'Temen Dekat', 'Temen Akrab', 'Temen Baik', 'Sahabat', 'Pacar', 'Soulmate'
]

const randomId = m => {
  const letters = 'abcdefghijklmnopqrstuvwxyz',
        pick = s => Array.from({ length: 5 }, () => s[Math.floor(Math.random() * s.length)]),
        jid = (m?.key?.participantAlt || '').replace('@s.whatsapp.net', ''),
        base = [...pick(letters), ...jid.slice(-4)]

  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[base[i], base[j]] = [base[j], base[i]]
  }

  return base.join('')
}

const authUser = async (m, chat) => {
  try {
    if (!m || !m.key) return 
    const rawSender = (m.key.participant || m.key.remoteJid)
    if (!rawSender) return
    
    const sender = normalizeJid(rawSender)
    if (!sender.endsWith('@s.whatsapp.net')) return
    
    // Quick check before proceeding
    if (db().key[sender]) return

    const pushName = (m.pushName || '-').trim().slice(0, 20)
    
    db().key[sender] = {
      jid: sender,
      name: pushName,
      noId: randomId(m),
      ban: !1,
      registered: false,
      cmd: 0,
      limit: 20, 
      money: 200000,
      tokens: 0,
      gold: 0, 
      invest: { active: false, amount: 0, dueDate: 0 },
      crypto: { btc: 0, eth: 0, usdt: 0 },
      level: 1,
      exp: 0,
      health: 100,
      max_health: 100,
      strength: 10,
      defense: 10,
      stamina: 100,
      max_stamina: 100,
      inventory: { potion: 0 },
      rpg_assets: { sword: 0, armor: 0, pickaxe: 0, axe: 0, fishing_rod: 0 },
      lastAdventure: 0,
      lastHunt: 0,
      lastMine: 0,
      lastChop: 0,
      jailExpired: 0,
      jailReason: '',
      jailCount: 0,
      ai: { jarvis: !1, chat: 0, role: role[0] }
    }

    await saveDb()
    console.log(`[Database] Registered new user: ${pushName} (${sender})`)
  } catch (e) {
    console.error('error pada authUser', e)
  }
}

const authGc = async (xp, chat) => {
  try {
    // Strict check: Only proceed if it is a group
    if (!chat.group && !chat.id.endsWith('@g.us')) return
    
    if (getGc(chat.id)) return // Already registered

    const database = gc()
    if (!database.key) database.key = {}

    let meta = {}
    try {
        meta = await xp.groupMetadata(chat.id)
    } catch (e) {
        console.error('Warning: Failed to fetch group metadata during registration:', chat.id)
        meta = { subject: 'Unknown Group', participants: [] }
    }

    // Use Group ID as KEY (More reliable than subject)
    const k = chat.id
    
    database.key[k] = {
      id: chat.id,
      subject: meta.subject || 'Unknown Group',
      ban: false,
      mute: false,
      member: meta.participants?.length || 0,
      filter: {
        welcome: { welcomeGc: false, welcomeText: '' },
        left: { leftText: '' },
        antilink: false,
        antitoxic: false,
        antidelete: false
      }
    }

    await saveGc()
    console.log(`[Database] Registered group: ${meta.subject || chat.id}`)
  } catch (e) {
    console.error('Error auto-registering group:', e)
  }
}

const syncWithMongo = async () => {
    if (!mongoDB.db) return
    console.log('🔄 Syncing database with MongoDB...')

    try {
        const mongoDbData = await mongoDB.botData.get('database')
        if (mongoDbData) {
            console.log('✅ Loaded user database from MongoDB')
            dbs.database.data = mongoDbData
            await dbs.database.write()
        } else {
            console.log('⬆️ Uploading local user database to MongoDB...')
            await mongoDB.botData.set('database', db())
        }

        const mongoGcData = await mongoDB.botData.get('dataGc')
        if (mongoGcData) {
            console.log('✅ Loaded group database from MongoDB')
            dbs.dataGc.data = mongoGcData
            await dbs.dataGc.write()
        } else {
            console.log('⬆️ Uploading local group database to MongoDB...')
            await mongoDB.botData.set('dataGc', gc())
        }
    } catch (e) {
        console.error('❌ Failed to sync with MongoDB:', e)
    }
}

class User {
  constructor(jid) {
    this.jid = jid
  }

  get data() {
    return db().key[this.jid]
  }

  addExp(amount) {
    if (this.data) {
      this.data.exp = (this.data.exp || 0) + amount
      this.save()
    }
  }

  useLimit(amount = 1) {
    if (this.data) {
      this.data.limit = (this.data.limit || 0) - amount
      this.save()
    }
  }

  save() {
    saveDbDebounced()
  }
}

class Group {
  constructor(jid) {
    this.jid = jid
  }

  get data() {
    return gc().key[this.jid]
  }

  save() {
    saveDbDebounced()
  }
}

const user = (jid) => new User(normalizeJid(jid))
const group = (jid) => new Group(jid)

export {
  User,
  Group,
  user,
  group,
  db,
  gc,
  stats,
  requests,
  lid,
  getGc,
  saveDb,
  saveDbDebounced,
  saveGc,
  saveRequests,
  saveBadwords,
  badwords,
  blacklist,
  premiumList,
  saveBlacklist,
  savePremium,
  randomId,
  authUser,
  authGc,
  syncWithMongo,
  markDirty
}