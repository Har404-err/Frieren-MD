import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { DisconnectReason } = require('@adiwajshing/baileys');
import c from 'chalk'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import connectToMongo from '../system/db/mongo.js'
import { syncWithMongo, lid, markDirty } from '../system/db/data.js'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)
const sessionPath = path.join(dirname, '../connect/session')

let retryCount = 0

function evConnect(xp, restart) {

  // --- LID MAPPING HANDLER (Critical for multi-device support) ---
  xp.ev.on('lid-mapping.update', (updates) => {
    const ldb = lid()
    let changed = false
    for (const update of updates) {
        const { jid, metadata } = update
        const otherId = metadata?.pn || metadata?.lid
        if (jid && otherId) {
            const lidId = jid.endsWith('@lid') ? jid : (otherId.endsWith('@lid') ? otherId : null)
            const pnId = jid.endsWith('@s.whatsapp.net') ? jid : (otherId.endsWith('@s.whatsapp.net') ? otherId : null)

            if (lidId && pnId) {
                ldb.key[lidId] = pnId
                if (global.lidReverseMap) global.lidReverseMap.set(lidId, pnId)
                changed = true
            }
        }
    }
    if (changed) markDirty('lid')
  })

  // --- CONNECTION HANDLER ---
  xp.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (connection === 'connecting') {
        console.log(c.yellowBright('🔌 [Socket] Menghubungkan ke WhatsApp...'))
    }

    if (connection === 'open') {
        console.log(c.greenBright.bold('✅ [Socket] Terhubung!'))
        retryCount = 0
        xp.isPairing = false

        connectToMongo().then(() => syncWithMongo()).catch(() => {})

        // Fetch bot profile picture
        try {
            const botJid = xp.decodeJid(xp.user.id)
            xp.profilePictureUrl(botJid, 'image')
                .then(url => {
                    global.botPfp = url
                    console.log(c.blueBright(`🖼️ [System] Bot PFP Updated`))
                })
                .catch(() => {
                    global.botPfp = null
                })
        } catch (e) {
            console.error('PFP Fetch Error:', e)
        }
    }

    if (connection === 'close') {
      const r = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown Reason'

      console.log(c.redBright.bold(`❌ [Socket] Koneksi terputus! (Code: ${r}) - Reason: ${reason}`))

      const isRestartRequired = r === DisconnectReason.restartRequired || r === 515
      const isConnectionLost = r === DisconnectReason.connectionLost || r === 408 || r === 428
      const isLoggedOut = r === DisconnectReason.loggedOut ||
                          r === DisconnectReason.badSession ||
                          r === DisconnectReason.forbidden ||
                          r === DisconnectReason.connectionReplaced ||
                          r === DisconnectReason.multideviceMismatch ||
                          r === 401 || r === 402 || r === 403 || r === 411

      if (isRestartRequired || isConnectionLost) {
          retryCount++
          const delay = isRestartRequired ? 500 : Math.min(retryCount * 2000, 10000)
          console.log(c.greenBright(`🔄 [Socket] Restarting socket. Reconnecting in ${delay}ms...`))
          setTimeout(restart, delay)
      } else if (isLoggedOut) {
          console.log(c.bgRed.white.bold(`CRITICAL: Sesi WhatsApp tidak valid (Code: ${r})! Membersihkan sesi lama...`))
          try {
              fs.rmSync(sessionPath, { recursive: true, force: true })
              console.log(c.green('✅ Folder session lama berhasil dibersihkan.'))
          } catch (err) {}
          console.log(c.yellowBright('Silakan jalankan "npm start" kembali untuk pairing ulang.'))
          process.exit(0)
      } else {
          retryCount++
          const delay = Math.min(retryCount * 2000, 10000)
          console.log(c.yellowBright(`[Socket] Reconnecting in ${delay/1000}s... (Percobaan: ${retryCount})`))
          setTimeout(restart, delay)
      }
    }
  })

  // --- ANTICALL HANDLER ---
  xp.ev.on('call', async (calls) => {
    for (const call of calls) {
        if (call.status === 'offer' && !call.offline && !call.isGroup && global.anticall) {
            try {
                console.log(c.redBright(`📞 [Call] Rejected private call from: ${call.from}`))
                await xp.rejectCall(call.id, call.from)
                await xp.sendMessage(call.from, {
                    text: `⚠️ *AUTOMATIC REJECT*\n\nMaaf, bot tidak dapat menerima panggilan (suara/video).\nSilakan kirim pesan teks saja.\n\n_Panggilan Anda telah ditolak otomatis oleh sistem._`
                })
            } catch (err) {
                console.error(c.red('⚠️ Gagal menolak panggilan:'), err.message)
            }
        }
    }
  })
}

const handleSessionIssue = async (restart) => {
    try {
        fs.rmSync(sessionPath, { recursive: true, force: true })
        console.log(c.green('Session dibersihkan. Merestart...'))
    } catch(e) {
        console.error('Gagal hapus session:', e)
    }
    setTimeout(restart, 2000)
}

export { evConnect, handleSessionIssue }
