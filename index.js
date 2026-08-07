import 'dotenv/config'
import './system/lib/logger.js'
import './config.js'
import './system/global.js'
import c from 'chalk'
import fs from 'fs'
import path from 'path'
import pino from 'pino'
import { fileURLToPath } from 'url'
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baileys = require('@adiwajshing/baileys');
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, makeInMemoryStore, fetchLatestBaileysVersion } = baileys;

console.log(c.blue('[DEBUG] Initializing Store...'))
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) })
if (fs.existsSync('./system/db/store.json')) {
    console.log(c.blue('[DEBUG] Reading Store from file...'))
    store.readFromFile('./system/db/store.json')
}
setInterval(() => {
    store.writeToFile('./system/db/store.json')
}, 10000)

console.log(c.blue('[DEBUG] Importing Modules...'))
import { handleCmd, ev, loadAll, watch } from './cmd/handle.js'
import { signal, jarvis } from './cmd/interactive.js'
import { db, saveDb, saveGc, syncWithMongo, authGc, authUser } from './system/db/data.js'
import { checkToxic, checkVirtext, checkSpamTag, checkAntilink, checkMute, checkAntibot, checkAntisticker, checkAntiwame, checkAutoDelete } from './system/filter.js'
import getMessageContent, { smsg } from './system/msg.js'
import { startReminderSystem } from './system/reminder.js'
import { startAutoBackup } from './system/autobackup.js'
import { startGroupSchedule } from './system/group_scheduler.js'
import { evConnect } from './connect/evConnect.js'
import { messageHandler } from './system/msgHandler.js'
import { getGc } from './system/db/data.js'
import { txtWlc, mode, banned, bangc } from './system/sys.js'
import { getMetadata, replaceLid, saveLidCache, cleanMsg, filterMsg, groupCache, resolveJid } from './system/function.js'
import connectToMongo from './system/db/mongo.js'
import { antiDelaySystem } from './system/antidelay.js'
import { loadAllJadibots } from './system/jadibot.js'
import { rct_key } from './system/reaction.js'

const tempDir = path.join(__dirname, 'temp')
fs.existsSync(tempDir) || fs.mkdirSync(tempDir, { recursive: !0 })

global.lidCache = {}
global.lidReverseMap = new Map()
global.msgCache = {}
const logLevel = pino({ level: 'silent' })
let xp

// --- GLOBAL ERROR HANDLER ---
process.on('uncaughtException', (err) => {
    console.error(c.red.bold('CRITICAL: Uncaught Exception:'), err)
})
process.on('unhandledRejection', (reason, promise) => {
    console.error(c.red.bold('CRITICAL: Unhandled Rejection at:'), promise, 'reason:', reason)
})

const startBot = async () => {
  try {
    console.log(c.green('[DEBUG] Starting startBot()...'))
    const sessionDir = './connect/session'
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const isSessionExist = fs.existsSync(path.join(sessionDir, 'creds.json'))
    
    console.log(c.green('[DEBUG] Fetching Latest WA Version...'))
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`[DEBUG] Using WA Version: ${version.join('.')}${isLatest ? ' (Latest)' : ''}`)

    console.log(c.green('[DEBUG] Initializing WASocket...'))
    xp = makeWASocket({
      logger: logLevel,
      version: [2, 3000, 1033936837],
      browser: ["Ubuntu", "Chrome", "120.0.0.0"],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
    })

    global.xp = xp
    global.store = store
    global.ev = ev
    xp.reactionCache = xp.reactionCache || new Map()
    
    console.log(c.green('[DEBUG] Binding Store...'))
    store.bind(xp.ev)
    xp.ev.on('creds.update', saveCreds)

    // Pindahkan evConnect ke sini agar bisa memantau koneksi sejak awal
    evConnect(xp, startBot)

    xp.decodeJid = (jid) => {
        if (!jid) return jid
        if (/:\d+@/gi.test(jid)) {
            const decode = jid.split(':')
            return decode[0] + '@' + decode[1].split('@')[1]
        }
        return jid
    }

    xp.getName = (jid, withoutContact = false) => {
        const id = xp.decodeJid(jid)
        let v
        if (id.endsWith('@g.us')) {
            v = groupCache.get(id) || {}
            return v.name || v.subject || id.replace('@g.us', '')
        }
        else v = id === '0@s.whatsapp.net' ? { id, name: 'WhatsApp' } : id === xp.decodeJid(xp.user?.id) ? xp.user : (store.contacts[id] || {})
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || id.split('@')[0]
    }

    xp.reply = (jid, text, quoted, options = {}) => xp.sendMessage(jid, { text: String(text), ...options }, { quoted: quoted || null })

    // Pairing Code Logic
    if (!isSessionExist || !state.creds.me || !state.creds.registered) { 
      console.log(c.yellow('Menunggu socket stabil untuk Pairing Code...'))
      // Gunakan delay yang sedikit lebih lama atau tunggu event 'connecting'
      await new Promise(r => setTimeout(r, 5000))

      let phoneNumber = global.nomorBot
      if (!phoneNumber || phoneNumber.length < 10) {
          if (!process.stdin.isTTY) {
              console.error(c.red.bold('CRITICAL: Pairing needed but not in TTY mode. Please set global.nomorBot correctly.'))
              return
          }

          console.log(c.cyan('Masukkan nomor WhatsApp Anda (contoh: 628xxx):'))
          phoneNumber = await global.q('')
          phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
          if (phoneNumber.startsWith('08')) phoneNumber = '62' + phoneNumber.slice(1)
      }

      console.log(c.cyanBright.bold(`Meminta kode pairing untuk: ${phoneNumber}`))
      
      // Berikan tanda bahwa sedang proses pairing agar evConnect tidak agresif
      xp.isPairing = true 
      
      try {
          const code = await xp.requestPairingCode(phoneNumber)
          const show = (code || '').match(/.{1,4}/g)?.join('-') || ''
          console.log(c.greenBright.bold('KODE PAIRING ANDA:'), c.white.bgRed.bold(` ${show} `))
      } catch (err) {
          console.error(c.red.bold('Gagal Pairing:'), err.message)
          // Jika gagal karena koneksi tutup, biasanya akan direstart oleh evConnect
      }
    }

    console.log(c.green('[DEBUG] Initializing Other Handlers...'))
    antiDelaySystem(xp)

    loadAllJadibots(); 
    
    startReminderSystem(xp)
    startAutoBackup(xp)
    startGroupSchedule(xp)
    
    console.log(c.green('[DEBUG] Registering messages.upsert...'))
    xp.ev.on('messages.upsert', (payload) => messageHandler(xp, payload))

    console.log(c.green('[DEBUG] Registering group-participants.update...'))
    xp.ev.on('group-participants.update', async u => {
      try {
          if (!u.id) return
          groupCache.delete(u.id)
          const meta = await getMetadata(u.id, xp),
                g = meta?.subject || 'Grup'

          // --- AUTO WELCOME/LEFT ---
          for (const pid of u.participants) {
            if (u.action === 'add' || u.action === 'remove') {
              const gcData = getGc({ id: u.id }),
                    isAdd = u.action === 'add',
                    cfg = isAdd ? gcData?.filter?.welcome?.welcomeGc : gcData?.filter?.left?.leftGc
              if (!gcData || !cfg) continue
              const { txt } = await txtWlc(xp, { id: u.id })
              const mention = '@' + (pid?.split('@')[0] || pid)
              const text = txt.replace(/@user|%user/gi, mention)
              const welcomeImg = './media/frieren-welcome.jpg'
              if (fs.existsSync(welcomeImg)) await xp.sendMessage(u.id, { image: { url: welcomeImg }, caption: text, mentions: [pid] })
              else await xp.sendMessage(u.id, { text, mentions: [pid] })
            }
          }
      } catch (gpErr) {
          console.error('Error in group-participants.update:', gpErr)
      }
    })

    console.log(c.green('[DEBUG] Registering groups.update...'))
    xp.ev.on('groups.update', u => 
      u.forEach(async v => {
        try {
            if (!v.id) return
            groupCache.delete(v.id)
            const m = await getMetadata(v.id, xp).catch(() => ({})),
                  a = v.participantAlt || v.participant || v.author,
                  f = a && m?.participants?.length ? m.participants.find(p => p.id === a) : 0
            v.author = f?.phoneNumber || a
        } catch (guErr) {
            console.error('Error in groups.update:', guErr)
        }
      })
    )

    console.log(c.green('[DEBUG] startBot() completed successfully.'))
    return xp
  } catch (e) { console.error(c.red.bold('Fatal Error in startBot:'), e) }
}

console.log(c.blue('[DEBUG] Calling startBot()...'))
const botInstance = await startBot()
if (botInstance) {
    console.log(c.blue('[DEBUG] startBot() returned instance. Calling loadAll()...'))
    await loadAll()
    console.log(c.blue('[DEBUG] Calling watch()...'))
    watch()
    console.log(c.green('[DEBUG] Bot startup sequence completed.'))
} else {
    console.error(c.red.bold('[DEBUG] startBot() failed to return an instance. Check logs above.'))
}