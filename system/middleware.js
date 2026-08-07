import { db, saveDb, saveDbDebounced, authUser, authGc, getGc, lid, markDirty } from './db/data.js'
import { normalizeJid } from './msg.js'
import { groupCache, getAdminStatus, getPn } from './function.js'
import moment from 'moment-timezone'

/**
 * Middleware Fixed: Mengatasi bug "Bukan Admin" akibat beda Device ID
 */
export default async function middleware(xp, m, cmd, eventData) {
    const result = { next: true, data: {} }
    
    // --- 1. PREPARE DATA ---
    // Load LID mappings from database if not already in memory
    if (!global.lidReverseMap || (global.lidReverseMap.size === 0 && Object.keys(lid()?.key || {}).length > 0)) {
        global.lidReverseMap = new Map(Object.entries(lid().key))
    }

    const botIdRaw = xp.user.id.includes(':') ? xp.user.id.split(':')[0] + '@s.whatsapp.net' : xp.user.id
    const botId = normalizeJid(botIdRaw)
    
    // STRICT DETECTION
    const remoteJid = m.key.remoteJid
    const isGroup = remoteJid.endsWith('@g.us')
    const isPrivate = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid')
    
    let isOwner = false
    let isCreator = false
    let isAdmin = false
    let isBotAdmin = false

    let sender = m.sender || (isGroup ? (m.key.participant || m.participant) : remoteJid)
    sender = normalizeJid(sender || '')

    // Owner Check (Early) — strip device suffix and resolve LID
    const senderNum = sender.split('@')[0].split(':')[0]
    const ownerNum = Array.isArray(global.ownerNumber)
        ? global.ownerNumber.map(n => n.replace(/[^0-9]/g, ''))
        : [global.ownerNumber?.replace(/[^0-9]/g, '')]

    // Resolve LID to phone number
    let phoneFromLid = await getPn(sender, xp)
    if (!phoneFromLid && sender.endsWith('@lid') && global.lidReverseMap?.has(sender)) {
        phoneFromLid = global.lidReverseMap.get(sender)
    }
    const phoneFromLidNum = phoneFromLid ? phoneFromLid.replace(/[^0-9]/g, '') : null

    isOwner = m.key.fromMe ||
              ownerNum.includes(senderNum) ||
              (phoneFromLidNum && ownerNum.includes(phoneFromLidNum))

    isCreator = m.key.fromMe ||
                senderNum === ownerNum[0] ||
                (phoneFromLidNum && phoneFromLidNum === ownerNum[0])

    // --- 1.1 IGNORE OTHER BOTS (Anti-Loop & Anti-Spam) ---
    const isBotMsg = m.key.id.startsWith('BAE5') || m.key.id.startsWith('AR')
    if (isBotMsg && !isOwner && !m.key.fromMe) {
        if (isPrivate) console.log('[MW] Blocked: Bot Msg')
        return { next: false }
    }
    
    // Ignore message from self ONLY if it's from the bot script itself (Loop protection)
    if (m.key.fromMe && m.key.id.startsWith('BAE5')) {
        if (isPrivate) console.log('[MW] Blocked: Self Bot Loop')
        return { next: false }
    }

    // --- 1.2 MODE CHECK (GC/PC ONLY) ---
    if (!isOwner) {
        if (global.gconly && !isGroup) {
            console.log('[MW] Blocked: Group Only Mode')
            return { next: false } 
        }
        if (global.pconly && !isPrivate) {
            return { next: false }
        }
    }

    // --- RESOLVE TARGET JID ---
    let targetJid = null
    const ctx = m.message?.extendedTextMessage?.contextInfo || m.message?.imageMessage?.contextInfo || m.message?.videoMessage?.contextInfo
    if (ctx?.mentionedJid && ctx.mentionedJid.length > 0) targetJid = ctx.mentionedJid[0]
    else if (ctx?.participant) targetJid = ctx.participant
    
    if (targetJid) targetJid = normalizeJid(targetJid)
    m.targetJid = targetJid

    // Data Awal
    const isCommandValid = eventData && (eventData.cmd || eventData.command)
    const tags = eventData?.tags
    let isRpgCmd = false
    let isEconomyCmd = false
    let isAiCmd = false
    if (Array.isArray(tags)) {
        isRpgCmd = tags.some(t => t.toLowerCase().includes('rpg'))
        isEconomyCmd = tags.some(t => t.toLowerCase().includes('economy'))
        isAiCmd = tags.some(t => t.toLowerCase().includes('ai'))
    } else if (typeof tags === 'string') {
        isRpgCmd = tags.toLowerCase().includes('rpg')
        isEconomyCmd = tags.toLowerCase().includes('economy')
        isAiCmd = tags.toLowerCase().includes('ai')
    }
    if (!isAiCmd && (eventData?.category?.toLowerCase() === 'ai' || eventData?.file?.includes('/ai/'))) {
        isAiCmd = true
    }
    m.isAiResponse = isAiCmd

    result.data = {
        chat: global.chat(m),
        text: m.text || '',
        command: cmd,
        isGroup,
        isPrivate,
        sender,
        isOwner,
        isCreator,
        isAdmin: false,
        isBotAdmin: false,
        isRpgCmd,
        isEconomyCmd
    }

    // --- 2. GROUP METADATA (HANYA JIKA GRUP) ---
    if (isGroup) {
        try {
            let groupMetadata = null
            const forceRefresh = eventData?.admin || eventData?.group
            const cached = groupCache.get(m.key.remoteJid)
            
            if (!forceRefresh && cached) {
                groupMetadata = cached
            } else {
                // Improved Fetch with better timeout and retry
                const fetchMetadata = async () => {
                    let err;
                    for (let i = 0; i < 2; i++) {
                        try {
                            return await xp.groupMetadata(m.key.remoteJid)
                        } catch (e) {
                            err = e
                            await new Promise(r => setTimeout(r, 1500))
                        }
                    }
                    throw err
                }

                groupMetadata = await Promise.race([
                    fetchMetadata(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout Metadata')), 5000))
                ]).catch((e) => {
                    console.error(`[MW] Metadata Error for ${m.key.remoteJid}:`, e.message)
                    return null
                })
            }
            
            if (groupMetadata) {
                if (!groupCache.has(m.key.remoteJid) || forceRefresh) {
                    groupCache.set(m.key.remoteJid, groupMetadata)
                    setTimeout(() => groupCache.delete(m.key.remoteJid), 60000)
                }

                const participants = groupMetadata.participants || []

                isAdmin = getAdminStatus(participants, sender) || getAdminStatus(participants, m.jid)
                isBotAdmin = getAdminStatus(participants, botId)

                result.data.groupMetadata = groupMetadata
                result.data.participants = participants
                result.data.groupName = groupMetadata.subject
                result.data.isAdmin = isAdmin
                result.data.isBotAdmin = isBotAdmin
            } else {
                // Fallback: If metadata fails, we still want to allow basic commands
                // but strictly admin commands will fail unless sender is owner
                result.data.isAdmin = isOwner 
                result.data.isBotAdmin = false
                result.data.groupName = 'Unknown Group'
            }
            
            // --- VALIDASI AKSES COMMAND ---
            if (eventData?.group && !isGroup) {
                if (!eventData.owner) await m.reply('❌ Perintah ini khusus untuk grup!')
                return { next: false }
            }
            
            if (eventData?.admin && !isAdmin && !isOwner) {
                if (!groupMetadata) {
                    await m.reply('⚠️ Gagal memverifikasi status Admin (Gangguan Koneksi). Coba lagi nanti.')
                } else {
                    await m.reply(`❌ Perintah *${cmd}* ini khusus Admin Grup!`)
                }
                return { next: false }
            }

            if (eventData?.botAdmin && !isBotAdmin) {
                await m.reply('❌ Bot harus jadi Admin grup untuk menggunakan perintah ini.')
                return { next: false }
            }

            // Group ban check
            const gcData = getGc(m.key.remoteJid)
            if (isCommandValid && gcData?.ban && !isOwner) {
                await m.reply('⛔ Grup ini telah di-banned oleh Owner Bot.')
                return { next: false }
            }
            // Blacklist check
            if (gcData?.blacklist?.includes(sender)) {
                if (isBotAdmin) {
                    try {
                        await xp.sendMessage(m.key.remoteJid, { text: `⛔ @${sender.split('@')[0]} ada di blacklist!`, mentions: [sender] })
                        await xp.groupParticipantsUpdate(m.key.remoteJid, [sender], 'remove')
                    } catch {}
                }
                return { next: false }
            }
            // Blocked commands per-group
            if (gcData?.cmdBlocked?.includes(cmd) && !isAdmin && !isOwner) {
                await m.reply(`⛔ Command *${cmd}* telah diblokir di grup ini oleh Admin.`)
                return { next: false }
            }
            // Owner-only filter
            if (gcData?.filter?.owneronly && !isOwner) return { next: false }
            
            // --- 4. GROUP FEATURE TOGGLE CHECK ---
            if (gcData?.staySchedule && isBotAdmin) {
                const now = moment().tz('Asia/Jakarta')
                const currentTime = now.format('HH:mm')
                const { close, open } = gcData.staySchedule
                
                const isBetween = (time, start, end) => {
                    const format = 'HH:mm'
                    const cur = moment(time, format)
                    const s = moment(start, format)
                    const e = moment(end, format)
                    if (s.isAfter(e)) return cur.isSameOrAfter(s) || cur.isSameOrBefore(e)
                    else return cur.isBetween(s, e, null, '[]')
                }

                const shouldBeClosed = isBetween(currentTime, close, open)
                const isClosed = groupMetadata?.announce

                if (shouldBeClosed && !isClosed) {
                    try {
                        await xp.groupSettingUpdate(m.key.remoteJid, 'announcement')
                        await xp.sendMessage(m.key.remoteJid, { text: `🌙 *JAM MALAM AKTIF*\n\nSudah jam ${close} WIB, grup ditutup otomatis.\nBuka kembali jam ${open} WIB.` })
                    } catch {}
                } else if (!shouldBeClosed && isClosed) {
                    try {
                        await xp.groupSettingUpdate(m.key.remoteJid, 'not_announcement')
                        await xp.sendMessage(m.key.remoteJid, { text: `☀️ *JAM OPERASIONAL DIMULAI*\n\nSudah jam ${open} WIB, grup dibuka kembali.` })
                    } catch {}
                }
            }

            if (gcData?.settings?.adminOnly && !isAdmin && !isOwner) return { next: false }

            if (gcData?.filter?.disabled) {
                const disabledList = gcData.filter.disabled
                const tag = eventData?.tags ? (Array.isArray(eventData.tags) ? eventData.tags[0] : eventData.tags).toLowerCase() : ''
                const isBlocked = disabledList.some(blocked => cmd === blocked || (tag && tag.includes(blocked)))
                if (isBlocked && !isAdmin && !isOwner) {
                    await m.reply(`⛔ Fitur *${cmd.toUpperCase()}* dimatikan di grup ini oleh Admin.`)
                    return { next: false }
                }
            }

            if (gcData && typeof gcData.rpg !== 'undefined' && !gcData.rpg && isRpgCmd) {
                await m.reply('⛔ *Fitur RPG Dinonaktifkan di Grup Ini.*')
                return { next: false }
            }

            // --- BOT CLOCK (Group Sleep Mode) ---
            const botClock = gcData?.botClock || db().settings?.botClock
            if (isCommandValid && botClock && !isOwner && !isAdmin) {
                const { close, open } = botClock
                if (close && open) {
                    const now = moment().tz('Asia/Jakarta')
                    const currentTime = now.format('HH:mm')
                    let isClosed = false
                    if (close < open) {
                        isClosed = (currentTime >= close && currentTime < open)
                    } else {
                        isClosed = (currentTime >= close || currentTime < open)
                    }
                    if (isClosed) {
                        await m.reply(`💤 *BOT SLEEP MODE (GRUP)* 💤\n\nBot sedang tidak aktif untuk penggunaan di dalam Grup.\nJam Operasional Grup: *${open} - ${close} WIB*\n\nSilakan gunakan kembali pada jam operasional aktif.`)
                        return { next: false }
                    }
                }
            }

            // --- SLOWMODE ---
            if (gcData?.slowmode?.enabled && !isAdmin && !isOwner) {
                try {
                    const { checkSlowmode } = await import('../cmd/command/group/slowmode.js').catch(() => ({ checkSlowmode: null }))
                    if (checkSlowmode) {
                        const smResult = checkSlowmode(m, gcData, isCommandValid)
                        if (smResult) {
                            if (smResult.mode === 'all') {
                                if (isBotAdmin) {
                                    try { await xp.sendMessage(m.chat, { delete: m.key }) } catch {}
                                }
                                return { next: false }
                            } else if (smResult.mode === 'onlycommand' && isCommandValid) {
                                await m.reply(`🐢 *SLOWMODE AKTIF*\n\nMaaf, silakan tunggu *${smResult.remaining} detik* lagi sebelum menggunakan perintah.`)
                                return { next: false }
                            }
                        }
                    }
                } catch {}
            }

        } catch (e) {
            console.error('Middleware Group Error:', e)
            result.data.isAdmin = isOwner
            result.data.isBotAdmin = false
        }
    } else if (isPrivate) {
        // --- JALUR KHUSUS PRIVATE CHAT ---
        if (eventData?.group && !isOwner) {
            await m.reply('❌ Fitur ini khusus untuk Grup!')
            return { next: false }
        }
        // RPG & Economy commands only work in groups
        if ((isRpgCmd || isEconomyCmd) && !isOwner) {
            const allowed = ['me', 'profile', 'dompet', 'wallet', 'ceklimit', 'buy', 'shop', 'toko']
            if (!allowed.includes(cmd)) {
                await m.reply(`❌ Fitur *${(isRpgCmd ? 'RPG' : 'EKONOMI')}* hanya dapat dimainkan di dalam Grup!`)
                return { next: false }
            }
        }
    }

    // --- AUTH & REGISTER ---
    if (!db().key[sender]) {
        await authUser(m, result.data.chat)
    }
    if (isGroup && !getGc(m.key.remoteJid)) {
        await authGc(xp, result.data.chat)
    }
    
    // Pastikan data user diambil ulang setelah pendaftaran (Sync Memory)
    const user = db().key[sender]
    if (!user) {
        // Fallback darurat jika DB gagal tulis agar bot tetap respon
        result.data.user = { jid: sender, level: 1, limit: 20, money: 200000, exp: 0 }
    } else {
        result.data.user = user
    }

    // --- PREMIUM EXPIRATION CHECK ---
    if (user?.premium && user.premiumTime && user.premiumTime > 0) {
        if (Date.now() >= user.premiumTime) {
            user.premium = false
            user.premiumTime = 0
            user.limit = 20
            saveDb()
            try {
                await xp.sendMessage(sender, { text: '✨ *PREMIUM EXPIRED* ✨\n\nMasa berlaku premium Anda telah habis. Terima kasih telah menggunakan layanan premium kami!' })
            } catch (e) {
                console.error('Failed to send premium expiry notice:', e)
            }
        }
    }

    // --- RESTING SYSTEM (Auto Wakeup) ---
    if (user?.isResting) {
        const now = Date.now()
        const durationMs = now - (user.startRest || now)
        const minutes = Math.floor(durationMs / 60000)

        if (minutes >= 1) {
            const hpGain = minutes * 5
            const stamGain = minutes * 10
            user.health = Math.min(user.max_health, (user.health || 0) + hpGain)
            user.stamina = Math.min(user.max_stamina, (user.stamina || 0) + stamGain)
            
            await m.reply(`🌅 *BANGUN TIDUR!*\nAnda telah beristirahat selama *${minutes} menit*.\n❤️ HP Pulih: +${hpGain}\n⚡ Stamina Pulih: +${stamGain}`)
        }
        user.isResting = false
        user.startRest = 0
        saveDbDebounced()
    }
    
    
    // Validasi Limit (TANPA MENGURANGI DI SINI)
    // isCommandValid already computed above

    // --- CHECK BANNED STATUS (ONLY IF COMMAND) ---
    if (isCommandValid && user?.ban && !isOwner) {
        await m.reply('⛔ Maaf, Akun Anda telah di-banned oleh Owner.')
        return { next: false }
    }

    // --- JAIL CHECK (ONLY IF COMMAND) ---
    if (isCommandValid && user?.jailExpired && user.jailExpired > Date.now()) {
        const remaining = user.jailExpired - Date.now()
        const min = Math.ceil(remaining / 60000)
        
        // Allow escape commands
        if (!['kabur', 'cekpenjara', 'suap'].includes(cmd)) {
            await m.reply(`⛓️ *ANDA DI PENJARA* ⛓️\n\nSisa Hukuman: ${min} Menit`)
            return { next: false }
        }
    } else if (user?.jailExpired && user.jailExpired <= Date.now() && user.jailExpired !== 0) {
        // Auto release if expired
        user.jailExpired = 0
        saveDbDebounced()
        await m.reply('🔓 Anda telah bebas dari penjara!')
    }

    // --- KIDNAP CHECK (ONLY IF COMMAND) ---
    if (isCommandValid && user?.kidnapped && user.kidnapped > Date.now()) {
        const remaining = user.kidnapped - Date.now()
        const min = Math.ceil(remaining / 60000)
        
        if (!['tebus', 'cekstatus', 'me', 'profile'].includes(cmd)) {
            await m.reply(`🆘 *ANDA DICULIK!* 🆘\n\nSisa Waktu: ${min} Menit`)
            return { next: false }
        }
    } else if (user?.kidnapped && user.kidnapped <= Date.now() && user.kidnapped !== 0) {
        user.kidnapped = 0
        user.kidnapper = null
        saveDbDebounced()
        await m.reply('🔓 Penculik melepaskan anda karena bosan. Anda bebas!')
    }
    
    // --- 3.5 DISABLED COMMAND CHECK ---
    const disabledCmds = db().settings?.disabledCmd || []
    if (isCommandValid && disabledCmds.includes(cmd) && !isOwner) {
        await m.reply(`⚠️ Fitur *${cmd}* sedang dinonaktifkan oleh Owner.`)
        return { next: false }
    }
    
    // --- 4. OWNER CHECK ---
    if (isCommandValid && (!global.public || eventData?.owner) && !isOwner) {
        return { next: false }
    }

    if (isCommandValid && global.maintenance && !isOwner) {
        await m.reply('🚧 Bot sedang dalam perbaikan (Maintenance).')
        return { next: false }
    }

    // --- AUTO INFLATION CHECK (GLOBAL DAILY) ---
    const settings = db().settings || {}
    if (settings.inflasiMode === 'auto') {
        const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })
        if (settings.lastInflationDate !== today) {
            const cfg = JSON.parse(fs.readFileSync('./system/db/rpg_items.json', 'utf-8'))
            const logic = cfg.logic || {}
            
            // Drifts by -10% to +10% from current multiplier
            const currentMult = settings.rpgPriceMultiplier || 1.0
            const drift = (Math.floor(Math.random() * 21) - 10) / 100 // -0.1 to 0.1
            let newMult = currentMult + drift
            
            // Clamp within bounds
            const maxInf = logic.maxInflation || 3.0
            const minInf = logic.minInflation || 0.5
            newMult = Math.min(maxInf, Math.max(minInf, newMult))
            
            settings.rpgPriceMultiplier = parseFloat(newMult.toFixed(2))
            settings.lastInflationDate = today
            saveDb()
            console.log(`[INFLASI] Market Shift: ${(drift * 100).toFixed(0)}% | Current: ${settings.rpgPriceMultiplier}x`)
        }
    }

    // --- 6. LIMIT SYSTEM (FLAGGING ONLY) ---
    const freeCmd = ['menu', 'help', 'verify', 'daftar', 'claim', 'daily', 'me', 'ceklimit', 'buy', 'shop', 'toko', 'bank', 'atm', 'saldo'] 
    const isFree = freeCmd.includes(cmd)
    const isPrem = user?.premium || false

    // Reset Limit Harian
    if (user) {
        const today = new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' })
        if (user.lastLimitReset !== today) {
            const defaultLimit = 20
            if (user.limit < defaultLimit) user.limit = defaultLimit
            user.lastLimitReset = today
            saveDbDebounced()
        }
    }

    if (isCommandValid && !isFree && !isOwner && !isPrem && user) {
        // Cek jika limit habis, tandai untuk dicek di handle.js setelah validasi prefix
        if (user.limit < 1) {
            result.data.limitExceeded = true
        } else {
            // Tandai untuk dikurangi nanti di handle.js setelah validasi prefix sukses
            result.data.consumeLimit = true
        }
    }

    // --- 7. CHAT COUNT & XP SYSTEM ---
    if (user && !m.key.fromMe && m.text) {
        user.lastSeen = Date.now()

        // Chat count: +1 limit every 15 messages in group
        if (isGroup) {
            user.chatCount = (user.chatCount || 0) + 1
            if (user.chatCount >= 15) {
                user.chatCount = 0
                if (user.limit !== Infinity) {
                    user.limit = (user.limit || 0) + 1
                    saveDbDebounced()
                }
            }
        }

        try {
            if (typeof user.level !== 'number' || user.level < 1) user.level = 1
            if (typeof user.exp !== 'number') user.exp = 0

            const xpAdd = Math.floor(Math.random() * 11) + 5
            user.exp += xpAdd

            let levelUp = false
            const oldLevel = user.level

            while (user.exp >= (user.level * 1000)) {
                user.exp -= (user.level * 1000)
                user.level++
                levelUp = true
            }

            if (levelUp) {
                const moneyReward = (user.level - oldLevel) * 5000
                user.money = (user.money || 0) + moneyReward
                user.max_health += 10
                user.max_stamina += 5
                user.health = user.max_health 

                const txt = `
    🎉  𝐋 𝐄 𝐕 𝐄 𝐋  𝐔 𝐏  🎉

    👤 Name : @${sender.split('@')[0]}
    🆙 Level : ${oldLevel} ➔ ${user.level}
    ✨ XP : ${user.exp} / ${user.level * 1000}

    🎁 *REWARDS:*
    💰 Money: +Rp ${moneyReward.toLocaleString('id-ID')}
    ❤️ Max HP: +10
    ⚡ Max Stamina: +5`

                await xp.sendMessage(result.data.chat.id, { 
                    text: txt, 
                    mentions: [sender] 
                }).catch(e => console.error('LevelUp Send Error:', e))
                saveDb() // Critical save on level up
            } else {
                saveDbDebounced() // Optimized save for normal XP gain
            }
        } catch (e) {
            console.error('Middleware XP Error:', e)
        }
    }

    result.data.user = user
    return result
}