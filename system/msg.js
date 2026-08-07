import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { serialize, smsg } from './lib/msg.js'

// Execute prototype extension immediately
serialize()

// Helper to normalize JID (Standard Baileys Logic)
const jidDecode = (jid) => {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
        const decode = jid.split(':')
        if (decode.length < 2) return jid
        return decode[0] + '@' + decode[1].split('@')[1]
    }
    return jid
}

const normalizeJid = (jid) => {
    if (!jid) return jid
    const decoded = jidDecode(jid)
    if (typeof decoded !== 'string') return jid

    // Resolve LID to phone number via lidReverseMap
    if (decoded.endsWith('@lid') && global.lidReverseMap?.has(decoded)) {
        const resolved = global.lidReverseMap.get(decoded)
        if (resolved) return resolved.split('@')[0] + '@s.whatsapp.net'
    }

    return decoded.toLowerCase()
}

const STUB_TYPE_MESSAGES = {
    2: 'Sekali lihat',
    20: 'Grup dibuat',
    22: 'Mengubah foto grup',
    24: 'Mengedit info grup',
    25: 'Mengedit peraturan anggota grup',
    26: 'Mengedit chat grup',
    27: 'Bergabung ke grup',
    32: 'Keluar dari grup',
    145: 'Mengedit persetujuan admin',
    171: 'Mengedit peraturan tambahkan anggota',
    172: 'Meminta bergabung'
}

const PROTOCOL_TYPE_MESSAGES = {
    0: 'Pesan dihapus',
    3: 'Mengatur timer grup',
    5: 'Sinkronisasi',
    6: 'Sinkronisasi kunci aplikasi',
    9: 'Sinkronisasi kunci keamanan'
}

const MEDIA_TYPE_MAP = {
    imageMessage: 'Gambar',
    videoMessage: 'Video',
    audioMessage: 'Audio',
    documentMessage: 'Dokumen',
    stickerMessage: 'Stiker',
    locationMessage: 'Lokasi',
    pollCreationMessage: 'Polling',
    pollCreationMessageV3: 'Polling',
    pollCreationMessageV5: 'Polling',
    pollUpdateMessage: 'Memilih polling',
    liveLocationMessage: 'Lokasi Live',
    reactionMessage: 'Reaksi',
    protocolMessage: 'Sistem',
    ephemeralMessage: 'Sekali Lihat',
    viewOnceMessage: 'Sekali Lihat',
    viewOnceMessageV2: 'Sekali Lihat',
    interactiveMessage: 'Button',
    richResponseMessage: 'Rich AI',
    albumMessage: 'Album',
    ptvMessage: 'Ptv',
    questionMessage: 'Pertanyaan'
}

/**
 * Extract text and media type from a Baileys message object.
 * Does NOT modify the original message object to avoid TypeError on read-only getters.
 */
function getMessageContent(m) {
  let text = '', media = '', no = ''

  if (!m?.message) return { text, media }

  const c = m.message
  const chat = global.chat ? global.chat(m) : {}
  const key = m.key
  const vo = key?.isViewOnce || c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message
  const stubType = m?.messageStubType
  const prm = c.protocolMessage
  const paramType = m.messageStubParameters

  if (paramType?.[0]) {
    try {
        const data = JSON.parse(paramType[0])
        no = (data.phoneNumber || data.pn || chat.pushName || '').replace(/@.+$/, '')
    } catch {
        no = (paramType[0] || '').replace(/@.+$/, '')
    }
  }

  if (vo) {
    const vMsg = c.viewOnceMessage?.message || c.viewOnceMessageV2?.message || c.viewOnceMessageV2Extension?.message || c
    const type = Object.keys(vMsg)[0]
    text = vMsg.conversation || vMsg.extendedTextMessage?.text || vMsg[type]?.caption || ''
    media = 'Sekali Lihat'
  }

  if (m.key?.remoteJid === 'status@broadcast') media = 'Status'
  if (c.groupStatusMentionMessage) {
    media = 'Status Grup'
    text = 'Grup ini disebut dalam status'
  }

  if (!text) {
    // Handle Interactive/Native Flow Response
    if (c.interactiveResponseMessage) {
        const native = c.interactiveResponseMessage.nativeFlowResponseMessage
        if (native?.paramsJson) {
            try {
                const data = JSON.parse(native.paramsJson)
                text = data.id || data.selectedRowId || data.selected_row_id || data.reference_index || text
            } catch (e) {
                text = native.paramsJson || text
            }
        }
        if (!text && c.interactiveResponseMessage.body?.text) {
            text = c.interactiveResponseMessage.body.text
        }
    }
    
    // Handle List Response (Legacy)
    if (c.listResponseMessage) {
        text = c.listResponseMessage.singleSelectReply?.selectedRowId || text
    }

    // Handle Template Button Response (Legacy)
    if (c.templateButtonReplyMessage) {
        text = c.templateButtonReplyMessage.selectedId || c.templateButtonReplyMessage.selectedDisplayText || text
    }

    text = text 
         || c.conversation 
         || c.extendedTextMessage?.text
         || c.imageMessage?.caption
         || c.videoMessage?.caption
         || (c.reactionMessage ? `Memberi reaksi ${c.reactionMessage.text}` : '')
         || (m.call && 'Panggilan telepon')
         || (prm?.type === 14 
             ? (prm.editedMessage?.conversation || prm.editedMessage?.extendedTextMessage?.text 
                 ? `Diedit ${prm.editedMessage.conversation || prm.editedMessage.extendedTextMessage?.text}` 
                 : 'Diedit') 
             : '')
         || PROTOCOL_TYPE_MESSAGES[prm?.type]
         || ({
                1: `${(chat.sender || '').replace(/@s\.whatsapp\.net$/, '')} Menyimpan pesan`,
                2: `${(chat.sender || '').replace(/@s\.whatsapp\.net$/, '')} Menghapus pesan tersimpan`
            })[c.keepInChatMessage?.keepType]
         || STUB_TYPE_MESSAGES[stubType]
         || ({
                29: `Menjadikan ${no} admin`,
                30: `Menurunkan admin ${no}`
            })[stubType]
         || ({
                1: 'Menyematkan pesan',
                2: 'Melepaskan pin pesan'
            })[c.pinInChatMessage?.type]
         || c.ephemeralMessage?.message?.conversation
         || c.ephemeralMessage?.message?.extendedTextMessage?.text
  }

  // Determine Media Type
  if (!media) {
      if (c.contactMessage) media = `Kontak ${c.contactMessage.displayName || ''}`
      else if (c.eventMessage) media = `Acara ${c.eventMessage.name || ''}`
      else if (global.xp?.detect) {
          const detectedType = global.xp.detect(m)
          if (detectedType && detectedType !== 'Unknown' && detectedType !== 'text') {
              media = detectedType.charAt(0).toUpperCase() + detectedType.slice(1)
          }
      }
      if (!media) {
          for (const key in MEDIA_TYPE_MAP) {
              if (c[key]) {
                  media = MEDIA_TYPE_MAP[key]
                  break
              }
          }
      }
  }
  
  media = text && media && text.toLowerCase() === media.toLowerCase() ? '' : media

  return { text, media }
}

export { normalizeJid, smsg }
export default getMessageContent