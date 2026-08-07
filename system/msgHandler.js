import c from 'chalk'
import { handleCmd } from '../cmd/handle.js'
import { signal } from '../cmd/interactive.js'
import { db, getGc } from './db/data.js'
import { 
    checkToxic, 
    checkAntilink, 
    checkMute, 
    checkAutoDelete,
    checkVirtext,
    checkSpamTag,
    checkAntibot,
    checkAntisticker,
    checkAntiwame
} from './filter.js'
import { checkAfk } from './afk.js'
import { smsg } from './msg.js'
import { bangc } from './sys.js'
import { 
    getMetadata, 
    replaceLid, 
    saveLidCache, 
    cleanMsg, 
    filterMsg, 
    groupCache 
} from './function.js'
import { rct_key } from './reaction.js'

function isDuplicate(chatId, msgId) {
    if (!global.msgCacheSet) global.msgCacheSet = new Map()
    if (!global.msgCacheLastSeen) global.msgCacheLastSeen = new Map()

    const now = Date.now()

    if (!global.msgCacheSet.has(chatId)) global.msgCacheSet.set(chatId, new Set())
    global.msgCacheLastSeen.set(chatId, now)

    const cache = global.msgCacheSet.get(chatId)
    if (cache.has(msgId)) return true
    cache.add(msgId)
    return false
}

// Cleanup old caches every 60 seconds
setInterval(() => {
    const now = Date.now()
    const expiry = 60000

    if (global.msgCacheLastSeen && global.msgCacheSet) {
        for (let [chatId, lastSeen] of global.msgCacheLastSeen.entries()) {
            if (now - lastSeen > expiry) {
                global.msgCacheSet.delete(chatId)
                global.msgCacheLastSeen.delete(chatId)
            }
        }
    }
}, 60000)

/**
 * Optimized Message Handler for FRIEREN-MD
 * Extracted from index.js for better maintainability
 */
export async function messageHandler(xp, { messages, type }) {
    if (global.debug) console.log(c.grey(`[EVENT] messages.upsert type: ${type} count: ${messages.length}`))
    
    for (let m of messages) {
        try {
            if (!m.message) continue
            if (m.key.remoteJid.endsWith('@newsletter')) continue
            
            // 1. Pre-Processing (Cleaning & LID)
            m = cleanMsg(m)
            m = replaceLid(m)

            // 2. Specialized Messages (Status & Reactions)
            if (m.key.remoteJid === 'status@broadcast' && global.autoreadsw) {
                await xp.readMessages([m.key]); continue
            }
            
            if (m.message?.reactionMessage) { 
                await rct_key(xp, m); continue 
            }

            // 3. System Message Parsing
            m = smsg(xp, m)
            if (!m) continue

            const id = m.chat
            const isGroup = m.isGroup
            const sender = m.sender
            const pushName = m.pushName || m.name || (m.sender ? m.sender.split('@')[0] : '')

            // 4. Content Extraction
            const { text, media } = global.getMessageContent(m)
            if (text) { m.body = text; m.text = text }

            // 5. Duplicate Detection
            if (!m.fromMe && isDuplicate(id, m.key.id)) continue

            // 6. Logging
            const time = global.time.timeIndo('Asia/Jakarta', 'HH:mm'),
                  name = pushName || sender.split('@')[0]
            
            const groupMetadata = isGroup ? (groupCache.get(id) || await getMetadata(id, xp) || {}) : {}
            const groupName = isGroup ? groupMetadata.subject || 'Grup' : ''

            console.log(
                c.bgGrey.yellowBright.bold(
                    isGroup ? `[ ${groupName} | ${name} ]` : id.endsWith('@newsletter') ? `[ ${id} ]` : `[ ${name} ]`
                ) +
                c.white.bold(' | ') +
                c.blueBright.bold(`[ ${time} ]`)
            )

            if (media || text) {
                console.log(
                    c.white.bold(
                        [media && `[ ${media} ]`, text && `[ ${text} ]`].filter(Boolean).join(' ')
                    )
                )
            }

            // 7. Spam Filter
            if (!(await filterMsg(m, { id, group: isGroup, sender, pushName, channel: id.endsWith('@newsletter') }, text))) continue

            // --- ACTIVITY TRACKING ---
            const user = db().key[sender]
            if (user) {
                user.chatCount = (user.chatCount || 0) + 1
            }
            if (isGroup) {
                const gcData = getGc(id)
                if (gcData) {
                    gcData.stats = gcData.stats || {}
                    gcData.stats[sender] = (gcData.stats[sender] || 0) + 1
                }
            }

            // --- PRESENCE UPDATE (Typing/Recording) ---
            if (global.autotyping) xp.sendPresenceUpdate('composing', id).catch(() => {})
            if (global.autorecording) xp.sendPresenceUpdate('recording', id).catch(() => {})

            // --- REACTION CACHE (Optimized with TTL) ---
            if (xp.reactionCache) {
                xp.reactionCache.set(m.key.id, m)
                setTimeout(() => {
                    if (xp.reactionCache.has(m.key.id)) xp.reactionCache.delete(m.key.id)
                }, 600000) // 10 minutes TTL
            }

            if (global.autoread) xp.readMessages([m.key]).catch(() => {})
            
            if (isGroup && Object.keys(groupMetadata).length) { await saveLidCache(groupMetadata) }

            // 8. Security Checks (Banned Groups/Users)
            if (isGroup && bangc({ id, group: isGroup, sender, pushName, channel: id.endsWith('@newsletter') })) continue 

            // 9. Auto Response & Signals
            if (text && db().respon && db().respon[text.toLowerCase()]) {
                 await xp.sendMessage(id, { text: db().respon[text.toLowerCase()] }, { quoted: m })
            }

            if (text) {
                signal(text, m, sender, id, xp, global.ev).catch(e => console.error('Signal Error:', e))
            }

            // 10. Parallel Handlers (Non-Blocking)
            Promise.all([
                checkAutoDelete(m, xp).catch(e => console.error('checkAutoDelete error:', e)),
                checkToxic(m, xp).catch(e => console.error('checkToxic error:', e)),
                checkVirtext(m, xp).catch(e => console.error('checkVirtext error:', e)),
                checkSpamTag(m, xp).catch(e => console.error('checkSpamTag error:', e)),
                checkAntilink(m, xp).catch(e => console.error('checkAntilink error:', e)),
                checkMute(m, xp).catch(e => console.error('checkMute error:', e)),
                checkAntibot(m, xp).catch(e => console.error('checkAntibot error:', e)),
                checkAntisticker(m, xp).catch(e => console.error('checkAntisticker error:', e)),
                checkAntiwame(m, xp).catch(e => console.error('checkAntiwame error:', e)),
                checkAfk(m, xp).catch(e => console.error('checkAfk error:', e)),
                handleCmd(m, xp, global.store).catch(e => console.error('handleCmd error:', e))
            ]);

        } catch (msgErr) {
            console.error(c.red.bold('Error in messageHandler loop:'), msgErr)
        }
    }
}
