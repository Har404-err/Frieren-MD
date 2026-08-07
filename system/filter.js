import { getGc, badwords } from './db/data.js'
import { grupify } from './sys.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const autodelPath = path.join(__dirname, 'db/autodel.json')

// --- GLOBAL AUTO DELETE CHAT ---
export const checkAutoDelete = async (m, xp) => {
    try {
        if (!fs.existsSync(autodelPath)) return
        
        const sender = m.sender || m.key?.participant || m.key?.remoteJid
        const list = JSON.parse(fs.readFileSync(autodelPath))
        
        // Cek apakah sender ada di list
        const isTarget = list.some(id => id.split('@')[0] === sender.split('@')[0])
        
        if (isTarget) {
            const chatId = m.chat || m.key?.remoteJid
            if (m.isGroup || chatId?.endsWith('@g.us')) {
                const { botAdm } = await grupify(xp, chatId, sender)
                if (botAdm) {
                    await xp.sendMessage(chatId, { delete: m.key })
                }
            }
        }
    } catch (e) {
        console.error('Error checkAutoDelete:', e)
    }
}

export const checkToxic = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const gcData = getGc({ id: chatId })
    if (!gcData || !gcData.filter?.antitoxic) return
    
    const text = (m.text || m.body || '').toLowerCase()
    if (!text) return

    const sender = m.sender || m.key?.participant || m.key?.remoteJid
    const cleanText = text.replace(/[^\w\s]/g, '')
    
    const isToxic = badwords().some(word => {
        const pattern = new RegExp(`\\b${word.toLowerCase()}\\b`, 'i')
        return pattern.test(text) || pattern.test(cleanText) || text.includes(word.toLowerCase())
    }) || (gcData.badwords || []).some(word => {
        const pattern = new RegExp(`\\b${word.toLowerCase()}\\b`, 'i')
        return pattern.test(text) || pattern.test(cleanText) || text.includes(word.toLowerCase())
    })
    if (!isToxic) return

    const { botAdm } = await grupify(xp, chatId, sender)

    if (botAdm) {
        await xp.sendMessage(chatId, { delete: m.key })
        await xp.sendMessage(chatId, { text: `⚠️ @${sender.split('@')[0]} terdeteksi toxic! Pesan dihapus.`, mentions: [sender] })
    }
    return isToxic ? true : undefined

  } catch (e) {
    console.error('Error checkToxic:', e)
  }
}

export const checkVirtext = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const text = m.text || m.body || ''
    if (!text) return

    if (text.length > 50000) {
        const sender = m.sender || m.key?.participant || m.key?.remoteJid
        const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
        if (usrAdm) return 

        if (botAdm) {
            await xp.sendMessage(chatId, { delete: m.key })
            await xp.sendMessage(chatId, { 
                text: `⚠️ *SPAM DETECTED* ⚠️\n\n@${sender.split('@')[0]} pesanmu dihapus karena terlalu panjang (> 50.000 karakter).`,
                mentions: [sender]
            })
        }
        return true
    }
  } catch (e) {
    console.error('Error checkVirtext:', e)
  }
}

export const checkSpamTag = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const mentions = m.mentionedJid || []
    
    if (mentions.length > 10) {
        const sender = m.sender || m.key?.participant || m.key?.remoteJid
        const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
        if (usrAdm) return 

        if (botAdm) {
            await xp.sendMessage(chatId, { delete: m.key })
            await xp.groupParticipantsUpdate(chatId, [sender], 'remove')
            await xp.sendMessage(chatId, { 
                text: `⚠️ *ANTI SPAM TAG* ⚠️\n\n@${sender.split('@')[0]} dikeluarkan karena melakukan spam tag (${mentions.length} user).`,
                mentions: [sender]
            })
        }
        return true
    }
  } catch (e) {
    console.error('Error checkSpamTag:', e)
  }
}

export const checkAntilink = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const gcData = getGc({ id: chatId })
    const isAntilink = gcData?.filter?.antilink
    const isAntilinkGc = gcData?.filter?.antilinkgc

    if (!gcData || (!isAntilink && !isAntilinkGc)) return

    const text = (m.text || m.body || '').toLowerCase()
    const linkRegex = /chat\.whatsapp\.com\/[a-zA-Z0-9]{20,}/i
    
    if (!linkRegex.test(text)) return

    const sender = m.sender || m.key?.participant || m.key?.remoteJid
    const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
    const senderNum = sender.split('@')[0]
    const isOwner = [].concat(global.ownerNumber).map(n => n.replace(/[^0-9]/g, '')).includes(senderNum)

    if (isOwner) return
    if (isAntilinkGc) {
        // MODE STRICT: Hanya Owner yang boleh
        if (isOwner) return
    } else {
        // MODE NORMAL: Admin juga boleh
        if (usrAdm) return
    }

    if (botAdm) {
        await xp.sendMessage(chatId, { delete: m.key })
        
        if (!usrAdm) {
            await xp.groupParticipantsUpdate(chatId, [sender], 'remove')
        }
        
        await xp.sendMessage(chatId, { 
            text: `⛔ *LINK TERDETEKSI* ⛔\n\nMaaf @${senderNum}, mengirim link grup lain dilarang di sini.`,
            mentions: [sender]
        })
    } else {
        await xp.sendMessage(chatId, { 
            text: `⚠️ @${senderNum} Jangan kirim link grup!\n(Jadikan bot admin untuk auto-kick)`,
            mentions: [sender]
        }, { quoted: m })
    }
    return true

  } catch (e) {
    console.error('Error checkAntilink:', e)
  }
}

export const checkMute = async (m, xp) => {
    try {
        const chatId = m.chat || m.key?.remoteJid
        if (!m.isGroup && !chatId?.endsWith('@g.us')) return
        
        const gcData = getGc({ id: chatId })
        if (!gcData) return

        const sender = m.sender || m.key?.participant || m.key?.remoteJid
        const senderNum = sender.split('@')[0]
        const isOwner = [].concat(global.ownerNumber || []).map(n => (n || '').toString().replace(/[^0-9]/g, '')).includes(senderNum)

        // Group mute
        if (gcData.mute && !isOwner) {
            return true
        }

        // Individual mute list
        if (gcData.muteList && gcData.muteList.length > 0) {
            const isMuted = gcData.muteList.some(id => id.split('@')[0] === senderNum)
            
            if (isMuted) {
                const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
                if (usrAdm) return
                if (botAdm) {
                    await xp.sendMessage(chatId, { delete: m.key })
                }
                return true
            }
        }
    } catch (e) {
        console.error('Error checkMute:', e)
    }
}

export const checkAntibot = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const gcData = getGc({ id: chatId })
    if (!gcData || !gcData.filter?.antibot) return

    if (m.isBaileys) {
        const sender = m.sender || m.key?.participant
        const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
        if (usrAdm) return

        if (botAdm) {
             await xp.sendMessage(chatId, { delete: m.key })
             await xp.groupParticipantsUpdate(chatId, [sender], 'remove')
             await xp.sendMessage(chatId, { text: `🤖 *ANTIBOT DETECTED* 🤖\n\nMaaf, bot lain dilarang disini.` })
        }
        return true
    }
  } catch (e) {
      console.error('Error checkAntibot:', e)
  }
}

export const checkAntisticker = async (m, xp) => {
  try {
      const chatId = m.chat || m.key?.remoteJid
      if (!m.isGroup && !chatId?.endsWith('@g.us')) return
      
      const gcData = getGc({ id: chatId })
      if (!gcData || !gcData.filter?.antisticker) return
      
      if (m.mtype === 'stickerMessage') {
          const sender = m.sender || m.key?.participant
          const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
          if (usrAdm) return
          
          if (botAdm) {
              await xp.sendMessage(chatId, { delete: m.key })
          }
          return true
      }
  } catch (e) {
      console.error('Error checkAntisticker:', e)
  }
}

export const checkAntiwame = async (m, xp) => {
  try {
    const chatId = m.chat || m.key?.remoteJid
    if (!m.isGroup && !chatId?.endsWith('@g.us')) return
    
    const gcData = getGc({ id: chatId })
    if (!gcData || !gcData.filter?.antiwame) return

    const text = (m.text || m.body || '').toLowerCase()
    const linkRegex = /wa\.me\/\d+/i
    
    if (linkRegex.test(text)) {
        const sender = m.sender || m.key?.participant
        const { botAdm, usrAdm } = await grupify(xp, chatId, sender)
        if (usrAdm) return

        if (botAdm) {
            await xp.sendMessage(chatId, { delete: m.key })
            await xp.sendMessage(chatId, { text: `⚠️ @${sender.split('@')[0]} Link wa.me dilarang!`, mentions: [sender] })
        }
        return true
    }
  } catch (e) {
      console.error('Error checkAntiwame:', e)
  }
}